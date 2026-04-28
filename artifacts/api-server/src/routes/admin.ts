import { Router, type IRouter } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  toolsTable,
  categoriesTable,
  favoritesTable,
  launchesTable,
  toolReviewsTable,
  type Tool,
} from "@workspace/db";
import {
  CreateToolBody,
  UpdateToolBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();

interface ToolDetailRow extends Tool {
  categorySlug: string | null;
  categoryName: string | null;
  favoriteCount: number;
  launchCount: number;
  avgRating: string | number | null;
  reviewCount: number;
}

function serializeToolDetail(row: ToolDetailRow) {
  const { submitterId, submissionStatus, ...rest } = row;
  return {
    ...rest,
    isActive: row.isActive === "true",
    favoriteCount: Number(row.favoriteCount ?? 0),
    launchCount: Number(row.launchCount ?? 0),
    isFavorite: false,
    avgRating:
      row.avgRating === null || row.avgRating === undefined
        ? null
        : Number(row.avgRating),
    reviewCount: Number(row.reviewCount ?? 0),
    createdAt: (row.createdAt instanceof Date
      ? row.createdAt
      : new Date(row.createdAt)
    ).toISOString(),
    updatedAt: (row.updatedAt instanceof Date
      ? row.updatedAt
      : new Date(row.updatedAt)
    ).toISOString(),
  };
}

router.get("/admin/tools", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: toolsTable.id,
      slug: toolsTable.slug,
      name: toolsTable.name,
      vendor: toolsTable.vendor,
      shortDescription: toolsTable.shortDescription,
      longDescription: toolsTable.longDescription,
      purpose: toolsTable.purpose,
      ragQueryTemplates: toolsTable.ragQueryTemplates,
      atoStatus: toolsTable.atoStatus,
      impactLevels: toolsTable.impactLevels,
      dataClassification: toolsTable.dataClassification,
      badges: toolsTable.badges,
      version: toolsTable.version,
      homepageUrl: toolsTable.homepageUrl,
      launchUrl: toolsTable.launchUrl,
      documentationUrl: toolsTable.documentationUrl,
      logoUrl: toolsTable.logoUrl,
      isActive: toolsTable.isActive,
      categoryId: toolsTable.categoryId,
      createdBy: toolsTable.createdBy,
      categorySlug: categoriesTable.slug,
      categoryName: categoriesTable.name,
      submitterId: toolsTable.submitterId,
      submissionStatus: toolsTable.submissionStatus,
      createdAt: toolsTable.createdAt,
      updatedAt: toolsTable.updatedAt,
      favoriteCount: sql<number>`(SELECT COUNT(*)::int FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id})`,
      launchCount: sql<number>`(SELECT COUNT(*)::int FROM ${launchesTable} l WHERE l.tool_id = ${toolsTable.id})`,
      avgRating: sql<string | null>`(SELECT AVG(r.rating)::text FROM ${toolReviewsTable} r WHERE r.tool_id = ${toolsTable.id} AND r.hidden_at IS NULL)`,
      reviewCount: sql<number>`(SELECT COUNT(*)::int FROM ${toolReviewsTable} r WHERE r.tool_id = ${toolsTable.id} AND r.hidden_at IS NULL)`,
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(eq(toolsTable.submissionStatus, "approved"))
    .orderBy(asc(toolsTable.name));

  res.json(rows.map((r) => serializeToolDetail(r as ToolDetailRow)));
});

router.post("/admin/tools", requireAdmin, async (req, res) => {
  const parsed = CreateToolBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid tool data" });
    return;
  }
  const data = parsed.data;
  const [created] = await db
    .insert(toolsTable)
    .values({
      slug: data.slug,
      name: data.name,
      vendor: data.vendor,
      shortDescription: data.shortDescription,
      longDescription: data.longDescription,
      purpose: data.purpose ?? "",
      ragQueryTemplates: data.ragQueryTemplates ?? [],
      categoryId: data.categoryId ?? null,
      atoStatus: data.atoStatus,
      impactLevels: data.impactLevels,
      dataClassification: data.dataClassification,
      version: data.version ?? null,
      badges: data.badges,
      homepageUrl: data.homepageUrl ?? null,
      launchUrl: data.launchUrl,
      documentationUrl: data.documentationUrl ?? null,
      logoUrl: data.logoUrl ?? null,
      isActive: data.isActive ? "true" : "false",
      submissionStatus: "approved",
      createdBy: req.user!.id,
    })
    .returning();

  const [cat] = created.categoryId
    ? await db
        .select()
        .from(categoriesTable)
        .where(eq(categoriesTable.id, created.categoryId))
        .limit(1)
    : [null];

  res.json(
    serializeToolDetail({
      ...created,
      categorySlug: cat?.slug ?? null,
      categoryName: cat?.name ?? null,
      favoriteCount: 0,
      launchCount: 0,
      avgRating: null,
      reviewCount: 0,
    }),
  );
});

router.put("/admin/tools/:id", requireAdmin, async (req, res) => {
  const parsed = UpdateToolBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid tool data" });
    return;
  }
  const data = parsed.data;
  const [updated] = await db
    .update(toolsTable)
    .set({
      slug: data.slug,
      name: data.name,
      vendor: data.vendor,
      shortDescription: data.shortDescription,
      longDescription: data.longDescription,
      purpose: data.purpose ?? "",
      ragQueryTemplates: data.ragQueryTemplates ?? [],
      categoryId: data.categoryId ?? null,
      atoStatus: data.atoStatus,
      impactLevels: data.impactLevels,
      dataClassification: data.dataClassification,
      version: data.version ?? null,
      badges: data.badges,
      homepageUrl: data.homepageUrl ?? null,
      launchUrl: data.launchUrl,
      documentationUrl: data.documentationUrl ?? null,
      logoUrl: data.logoUrl ?? null,
      isActive: data.isActive ? "true" : "false",
    })
    .where(
      and(
        eq(toolsTable.id, String(req.params.id)),
        eq(toolsTable.submissionStatus, "approved"),
      ),
    )
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  const [cat] = updated.categoryId
    ? await db
        .select()
        .from(categoriesTable)
        .where(eq(categoriesTable.id, updated.categoryId))
        .limit(1)
    : [null];

  const [stats] = await db
    .select({
      favoriteCount: sql<number>`(SELECT COUNT(*)::int FROM ${favoritesTable} f WHERE f.tool_id = ${updated.id})`,
      launchCount: sql<number>`(SELECT COUNT(*)::int FROM ${launchesTable} l WHERE l.tool_id = ${updated.id})`,
      avgRating: sql<string | null>`(SELECT AVG(r.rating)::text FROM ${toolReviewsTable} r WHERE r.tool_id = ${updated.id} AND r.hidden_at IS NULL)`,
      reviewCount: sql<number>`(SELECT COUNT(*)::int FROM ${toolReviewsTable} r WHERE r.tool_id = ${updated.id} AND r.hidden_at IS NULL)`,
    })
    .from(toolsTable)
    .where(eq(toolsTable.id, updated.id))
    .limit(1);

  res.json(
    serializeToolDetail({
      ...updated,
      categorySlug: cat?.slug ?? null,
      categoryName: cat?.name ?? null,
      favoriteCount: stats?.favoriteCount ?? 0,
      launchCount: stats?.launchCount ?? 0,
      avgRating: stats?.avgRating ?? null,
      reviewCount: stats?.reviewCount ?? 0,
    }),
  );
});

router.delete("/admin/tools/:id", requireAdmin, async (req, res) => {
  const result = await db
    .delete(toolsTable)
    .where(
      and(
        eq(toolsTable.id, String(req.params.id)),
        eq(toolsTable.submissionStatus, "approved"),
      ),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }
  res.json({ success: true });
});

export default router;
