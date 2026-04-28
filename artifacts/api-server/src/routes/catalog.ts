import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  categoriesTable,
  toolsTable,
  favoritesTable,
  launchesTable,
  toolReviewsTable,
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
  const sort = req.query.sort === "rating" ? "rating" : "name";

  const conditions = [
    eq(toolsTable.isActive, "true"),
    eq(toolsTable.submissionStatus, "approved"),
  ];
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
      hostingType: toolsTable.hostingType,
      categorySlug: categoriesTable.slug,
      categoryName: categoriesTable.name,
      submitterId: toolsTable.submitterId,
      favoriteCount: sql<number>`(SELECT COUNT(*)::int FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id})`,
      launchCount: sql<number>`(SELECT COUNT(*)::int FROM ${launchesTable} l WHERE l.tool_id = ${toolsTable.id})`,
      avgRating: sql<string | null>`(SELECT AVG(r.rating)::text FROM ${toolReviewsTable} r WHERE r.tool_id = ${toolsTable.id} AND r.hidden_at IS NULL)`,
      reviewCount: sql<number>`(SELECT COUNT(*)::int FROM ${toolReviewsTable} r WHERE r.tool_id = ${toolsTable.id} AND r.hidden_at IS NULL)`,
      isFavorite: userId
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id} AND f.user_id = ${userId})`
        : sql<boolean>`false`,
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(and(...conditions))
    .orderBy(
      ...(sort === "rating"
        ? [
            desc(
              sql`COALESCE((SELECT AVG(r.rating) FROM ${toolReviewsTable} r WHERE r.tool_id = ${toolsTable.id} AND r.hidden_at IS NULL), 0)`,
            ),
            desc(
              sql`(SELECT COUNT(*) FROM ${toolReviewsTable} r WHERE r.tool_id = ${toolsTable.id} AND r.hidden_at IS NULL)`,
            ),
            asc(toolsTable.name),
          ]
        : [asc(toolsTable.name)]),
    );

  let result = rows;
  if (favoritesOnly && userId) {
    result = rows.filter((r) => r.isFavorite);
  }

  res.json(
    result.map(({ submitterId, ...r }) => ({
      ...r,
      favoriteCount: Number(r.favoriteCount ?? 0),
      launchCount: Number(r.launchCount ?? 0),
      isFavorite: Boolean(r.isFavorite),
      isVendorSubmitted: submitterId != null,
      avgRating: r.avgRating === null || r.avgRating === undefined
        ? null
        : Number(r.avgRating),
      reviewCount: Number(r.reviewCount ?? 0),
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
      logoUrl: toolsTable.logoUrl,
      isActive: toolsTable.isActive,
      categoryId: toolsTable.categoryId,
      hostingType: toolsTable.hostingType,
      installerUrl: toolsTable.installerUrl,
      installerObjectKey: toolsTable.installerObjectKey,
      installerFilename: toolsTable.installerFilename,
      installerSizeBytes: toolsTable.installerSizeBytes,
      installerPlatform: toolsTable.installerPlatform,
      installInstructions: toolsTable.installInstructions,
      localLaunchUrlPattern: toolsTable.localLaunchUrlPattern,
      gitRepoOwner: toolsTable.gitRepoOwner,
      gitRepoName: toolsTable.gitRepoName,
      gitDefaultBranch: toolsTable.gitDefaultBranch,
      gitLatestReleaseTag: toolsTable.gitLatestReleaseTag,
      gitLatestCommitSha: toolsTable.gitLatestCommitSha,
      gitLicenseSpdx: toolsTable.gitLicenseSpdx,
      gitStars: toolsTable.gitStars,
      gitLastSyncedAt: toolsTable.gitLastSyncedAt,
      purpose: toolsTable.purpose,
      ragQueryTemplates: toolsTable.ragQueryTemplates,
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
      isFavorite: userId
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id} AND f.user_id = ${userId})`
        : sql<boolean>`false`,
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(eq(toolsTable.slug, slug))
    .limit(1);

  if (!row || row.submissionStatus !== "approved") {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  const { submitterId, submissionStatus, ...rest } = row;
  // Compute the public download URL for the installer the same way the admin
  // route does (storage router serves /objects/<x> at /api/storage/objects/<x>).
  let installerDownloadUrl: string | null = row.installerUrl ?? null;
  if (!installerDownloadUrl && row.installerObjectKey) {
    installerDownloadUrl = row.installerObjectKey.startsWith("/objects/")
      ? `/api/storage/objects/${row.installerObjectKey.slice("/objects/".length)}`
      : row.installerObjectKey;
  }
  res.json({
    ...rest,
    isActive: row.isActive === "true",
    favoriteCount: Number(row.favoriteCount ?? 0),
    launchCount: Number(row.launchCount ?? 0),
    isFavorite: Boolean(row.isFavorite),
    isVendorSubmitted: submitterId != null,
    avgRating:
      row.avgRating === null || row.avgRating === undefined
        ? null
        : Number(row.avgRating),
    reviewCount: Number(row.reviewCount ?? 0),
    purpose: row.purpose ?? "",
    ragQueryTemplates: row.ragQueryTemplates ?? [],
    installerDownloadUrl,
    gitLastSyncedAt: row.gitLastSyncedAt
      ? row.gitLastSyncedAt.toISOString()
      : null,
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
