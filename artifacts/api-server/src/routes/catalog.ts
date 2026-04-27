import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  categoriesTable,
  toolsTable,
  favoritesTable,
  launchesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/catalog/categories", async (_req, res) => {
  const cats = await db
    .select()
    .from(categoriesTable)
    .orderBy(asc(categoriesTable.sortOrder), asc(categoriesTable.name));
  res.json(cats);
});

router.get("/catalog/tools", async (req, res) => {
  const userId = req.user?.id ?? null;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category =
    typeof req.query.category === "string" ? req.query.category : undefined;
  const atoStatus =
    typeof req.query.ato_status === "string" ? req.query.ato_status : undefined;
  const impactLevel =
    typeof req.query.impact_level === "string"
      ? req.query.impact_level
      : undefined;
  const favoritesOnly = req.query.favorites_only === "true";

  const conditions = [eq(toolsTable.isActive, "true")];
  if (q) {
    conditions.push(
      or(
        ilike(toolsTable.name, `%${q}%`),
        ilike(toolsTable.vendor, `%${q}%`),
        ilike(toolsTable.shortDescription, `%${q}%`),
      )!,
    );
  }
  if (category) conditions.push(eq(categoriesTable.slug, category));
  if (atoStatus) conditions.push(eq(toolsTable.atoStatus, atoStatus));
  if (impactLevel) {
    conditions.push(
      sql`${toolsTable.impactLevels} ? ${impactLevel}`,
    );
  }

  const rows = await db
    .select({
      id: toolsTable.id,
      slug: toolsTable.slug,
      name: toolsTable.name,
      vendor: toolsTable.vendor,
      shortDescription: toolsTable.shortDescription,
      atoStatus: toolsTable.atoStatus,
      impactLevels: toolsTable.impactLevels,
      dataClassification: toolsTable.dataClassification,
      badges: toolsTable.badges,
      categorySlug: categoriesTable.slug,
      categoryName: categoriesTable.name,
      favoriteCount: sql<number>`(SELECT COUNT(*)::int FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id})`,
      launchCount: sql<number>`(SELECT COUNT(*)::int FROM ${launchesTable} l WHERE l.tool_id = ${toolsTable.id})`,
      isFavorite: userId
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id} AND f.user_id = ${userId})`
        : sql<boolean>`false`,
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(and(...conditions))
    .orderBy(asc(toolsTable.name));

  let result = rows;
  if (favoritesOnly && userId) {
    result = rows.filter((r) => r.isFavorite);
  }

  res.json(
    result.map((r) => ({
      ...r,
      favoriteCount: Number(r.favoriteCount ?? 0),
      launchCount: Number(r.launchCount ?? 0),
      isFavorite: Boolean(r.isFavorite),
    })),
  );
});

router.get("/catalog/tools/:slug", async (req, res) => {
  const userId = req.user?.id ?? null;
  const { slug } = req.params;

  const [row] = await db
    .select({
      id: toolsTable.id,
      slug: toolsTable.slug,
      name: toolsTable.name,
      vendor: toolsTable.vendor,
      shortDescription: toolsTable.shortDescription,
      longDescription: toolsTable.longDescription,
      atoStatus: toolsTable.atoStatus,
      impactLevels: toolsTable.impactLevels,
      dataClassification: toolsTable.dataClassification,
      badges: toolsTable.badges,
      version: toolsTable.version,
      homepageUrl: toolsTable.homepageUrl,
      launchUrl: toolsTable.launchUrl,
      documentationUrl: toolsTable.documentationUrl,
      isActive: toolsTable.isActive,
      categoryId: toolsTable.categoryId,
      categorySlug: categoriesTable.slug,
      categoryName: categoriesTable.name,
      createdAt: toolsTable.createdAt,
      updatedAt: toolsTable.updatedAt,
      favoriteCount: sql<number>`(SELECT COUNT(*)::int FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id})`,
      launchCount: sql<number>`(SELECT COUNT(*)::int FROM ${launchesTable} l WHERE l.tool_id = ${toolsTable.id})`,
      isFavorite: userId
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id} AND f.user_id = ${userId})`
        : sql<boolean>`false`,
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(eq(toolsTable.slug, slug))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  res.json({
    ...row,
    isActive: row.isActive === "true",
    favoriteCount: Number(row.favoriteCount ?? 0),
    launchCount: Number(row.launchCount ?? 0),
    isFavorite: Boolean(row.isFavorite),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
});

router.post("/catalog/favorites/:toolId", requireAuth, async (req, res) => {
  await db
    .insert(favoritesTable)
    .values({ userId: req.user!.id, toolId: String(req.params.toolId) })
    .onConflictDoNothing();
  res.json({ success: true });
});

router.delete("/catalog/favorites/:toolId", requireAuth, async (req, res) => {
  await db
    .delete(favoritesTable)
    .where(
      and(
        eq(favoritesTable.userId, req.user!.id),
        eq(favoritesTable.toolId, String(req.params.toolId)),
      ),
    );
  res.json({ success: true });
});

export default router;
