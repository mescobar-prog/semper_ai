import { Router, type IRouter } from "express";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  documentsTable,
  docChunksTable,
  favoritesTable,
  launchesTable,
  toolsTable,
  categoriesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  getOrCreateProfile,
  completenessPct,
} from "../lib/profile-helpers";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (req, res) => {
  const userId = req.user!.id;

  const profile = await getOrCreateProfile(userId);

  const [libStats] = await db
    .select({
      documentCount: sql<number>`COUNT(DISTINCT ${documentsTable.id})::int`,
      chunkCount: sql<number>`COUNT(${docChunksTable.id})::int`,
    })
    .from(documentsTable)
    .leftJoin(
      docChunksTable,
      eq(docChunksTable.documentId, documentsTable.id),
    )
    .where(eq(documentsTable.userId, userId));

  const [favs] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(favoritesTable)
    .where(eq(favoritesTable.userId, userId));

  const [launches] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(launchesTable)
    .where(eq(launchesTable.userId, userId));

  const recentLaunches = await db
    .select({
      id: launchesTable.id,
      toolId: launchesTable.toolId,
      toolName: toolsTable.name,
      toolSlug: toolsTable.slug,
      status: launchesTable.status,
      createdAt: launchesTable.createdAt,
    })
    .from(launchesTable)
    .innerJoin(toolsTable, eq(launchesTable.toolId, toolsTable.id))
    .where(eq(launchesTable.userId, userId))
    .orderBy(desc(launchesTable.createdAt))
    .limit(5);

  const atoBreakdown = await db
    .select({
      atoStatus: toolsTable.atoStatus,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(toolsTable)
    .where(
      sql`${toolsTable.isActive} = 'true' AND ${toolsTable.submissionStatus} = 'approved'`,
    )
    .groupBy(toolsTable.atoStatus);

  const topTools = await db
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
      submitterId: toolsTable.submitterId,
      favoriteCount: sql<number>`(SELECT COUNT(*)::int FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id})`,
      launchCount: sql<number>`(SELECT COUNT(*)::int FROM ${launchesTable} l WHERE l.tool_id = ${toolsTable.id})`,
      isFavorite: sql<boolean>`EXISTS (SELECT 1 FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id} AND f.user_id = ${userId})`,
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(
      sql`${toolsTable.isActive} = 'true' AND ${toolsTable.submissionStatus} = 'approved'`,
    )
    .orderBy(
      desc(sql`(SELECT COUNT(*) FROM ${launchesTable} l WHERE l.tool_id = ${toolsTable.id})`),
      desc(sql`(SELECT COUNT(*) FROM ${favoritesTable} f WHERE f.tool_id = ${toolsTable.id})`),
    )
    .limit(6);

  res.json({
    profileCompletenessPct: completenessPct(profile),
    libraryDocumentCount: Number(libStats?.documentCount ?? 0),
    libraryChunkCount: Number(libStats?.chunkCount ?? 0),
    favoritesCount: Number(favs?.c ?? 0),
    launchCount: Number(launches?.c ?? 0),
    recentLaunches: recentLaunches.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    atoStatusBreakdown: atoBreakdown.map((a) => ({
      atoStatus: a.atoStatus,
      count: Number(a.count),
    })),
    topTools: topTools.map(({ submitterId, ...t }) => ({
      ...t,
      favoriteCount: Number(t.favoriteCount ?? 0),
      launchCount: Number(t.launchCount ?? 0),
      isFavorite: Boolean(t.isFavorite),
      isVendorSubmitted: submitterId != null,
    })),
  });
});

export default router;
