import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  toolsTable,
  toolReviewsTable,
  launchesTable,
  profilesTable,
  usersTable,
} from "@workspace/db";
import {
  ListToolReviewsQueryParams,
  UpsertMyToolReviewBody,
  AdminListReviewsQueryParams,
  AdminHideReviewBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ADMIN_DEFAULT_LIMIT = 50;
const ADMIN_MAX_LIMIT = 200;

function publicReviewRow(row: {
  id: string;
  toolId: string;
  rating: number;
  comment: string | null;
  reviewerBranch: string | null;
  reviewerRank: string | null;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}, currentUserId: string | null) {
  return {
    id: row.id,
    toolId: row.toolId,
    rating: row.rating,
    comment: row.comment,
    reviewerBranch: row.reviewerBranch,
    reviewerRank: row.reviewerRank,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isMine: currentUserId !== null && row.userId === currentUserId,
  };
}

router.get("/catalog/reviews", async (req, res) => {
  const parsed = ListToolReviewsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const { tool_slug: toolSlug, limit: rawLimit, offset: rawOffset } =
    parsed.data;
  const limit = Math.min(Math.max(rawLimit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(rawOffset ?? 0, 0);

  const [tool] = await db
    .select({ id: toolsTable.id })
    .from(toolsTable)
    .where(eq(toolsTable.slug, toolSlug))
    .limit(1);
  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  const userId = req.user?.id ?? null;

  const visibleCondition = and(
    eq(toolReviewsTable.toolId, tool.id),
    isNull(toolReviewsTable.hiddenAt),
  );

  const rows = await db
    .select({
      id: toolReviewsTable.id,
      toolId: toolReviewsTable.toolId,
      userId: toolReviewsTable.userId,
      rating: toolReviewsTable.rating,
      comment: toolReviewsTable.comment,
      createdAt: toolReviewsTable.createdAt,
      updatedAt: toolReviewsTable.updatedAt,
      reviewerBranch: profilesTable.branch,
      reviewerRank: profilesTable.rank,
    })
    .from(toolReviewsTable)
    .leftJoin(profilesTable, eq(profilesTable.userId, toolReviewsTable.userId))
    .where(visibleCondition)
    .orderBy(desc(toolReviewsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [stats] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      avg: sql<string | null>`AVG(${toolReviewsTable.rating})::text`,
    })
    .from(toolReviewsTable)
    .where(visibleCondition);

  const total = Number(stats?.total ?? 0);
  const avgRating =
    stats?.avg !== null && stats?.avg !== undefined
      ? Number(stats.avg)
      : null;

  let myReview: ReturnType<typeof publicReviewRow> | null = null;
  let canReview = false;
  if (userId) {
    const [myRow] = await db
      .select({
        id: toolReviewsTable.id,
        toolId: toolReviewsTable.toolId,
        userId: toolReviewsTable.userId,
        rating: toolReviewsTable.rating,
        comment: toolReviewsTable.comment,
        createdAt: toolReviewsTable.createdAt,
        updatedAt: toolReviewsTable.updatedAt,
        reviewerBranch: profilesTable.branch,
        reviewerRank: profilesTable.rank,
      })
      .from(toolReviewsTable)
      .leftJoin(profilesTable, eq(profilesTable.userId, toolReviewsTable.userId))
      .where(
        and(
          eq(toolReviewsTable.toolId, tool.id),
          eq(toolReviewsTable.userId, userId),
        ),
      )
      .limit(1);
    if (myRow) {
      myReview = publicReviewRow(myRow, userId);
    }

    const [launch] = await db
      .select({ id: launchesTable.id })
      .from(launchesTable)
      .where(
        and(
          eq(launchesTable.toolId, tool.id),
          eq(launchesTable.userId, userId),
        ),
      )
      .limit(1);
    canReview = !!launch;
  }

  res.json({
    reviews: rows.map((r) => publicReviewRow(r, userId)),
    total,
    avgRating,
    hasMore: offset + rows.length < total,
    myReview,
    canReview,
  });
});

router.put("/catalog/tools/:toolId/review", requireAuth, async (req, res) => {
  const parsed = UpsertMyToolReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid review payload" });
    return;
  }
  const { rating, comment } = parsed.data;
  const trimmedComment =
    typeof comment === "string" ? comment.trim() : null;
  const finalComment =
    trimmedComment && trimmedComment.length > 0 ? trimmedComment : null;

  const userId = req.user!.id;
  const toolId = String(req.params.toolId);

  const [tool] = await db
    .select({ id: toolsTable.id })
    .from(toolsTable)
    .where(eq(toolsTable.id, toolId))
    .limit(1);
  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  const [launch] = await db
    .select({ id: launchesTable.id })
    .from(launchesTable)
    .where(
      and(eq(launchesTable.toolId, tool.id), eq(launchesTable.userId, userId)),
    )
    .limit(1);
  if (!launch) {
    res
      .status(403)
      .json({ error: "You must launch this tool at least once before reviewing it." });
    return;
  }

  const [saved] = await db
    .insert(toolReviewsTable)
    .values({
      userId,
      toolId: tool.id,
      rating,
      comment: finalComment,
    })
    .onConflictDoUpdate({
      target: [toolReviewsTable.userId, toolReviewsTable.toolId],
      set: {
        rating,
        comment: finalComment,
        // Editing your own review un-hides it (admins can re-hide).
        hiddenAt: null,
        hiddenReason: null,
        hiddenBy: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const [profile] = await db
    .select({ branch: profilesTable.branch, rank: profilesTable.rank })
    .from(profilesTable)
    .where(eq(profilesTable.userId, userId))
    .limit(1);

  res.json(
    publicReviewRow(
      {
        id: saved.id,
        toolId: saved.toolId,
        userId: saved.userId,
        rating: saved.rating,
        comment: saved.comment,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        reviewerBranch: profile?.branch ?? null,
        reviewerRank: profile?.rank ?? null,
      },
      userId,
    ),
  );
});

router.delete(
  "/catalog/tools/:toolId/review",
  requireAuth,
  async (req, res) => {
    const userId = req.user!.id;
    const toolId = String(req.params.toolId);

    const result = await db
      .delete(toolReviewsTable)
      .where(
        and(
          eq(toolReviewsTable.userId, userId),
          eq(toolReviewsTable.toolId, toolId),
        ),
      )
      .returning();

    if (result.length === 0) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    res.json({ success: true });
  },
);

function adminReviewRow(row: {
  id: string;
  toolId: string;
  toolName: string;
  toolSlug: string;
  userId: string;
  reviewerEmail: string | null;
  reviewerBranch: string | null;
  reviewerRank: string | null;
  rating: number;
  comment: string | null;
  hiddenAt: Date | null;
  hiddenReason: string | null;
  hiddenBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    toolId: row.toolId,
    toolName: row.toolName,
    toolSlug: row.toolSlug,
    userId: row.userId,
    reviewerEmail: row.reviewerEmail,
    reviewerBranch: row.reviewerBranch,
    reviewerRank: row.reviewerRank,
    rating: row.rating,
    comment: row.comment,
    isHidden: row.hiddenAt !== null,
    hiddenReason: row.hiddenReason,
    hiddenAt: row.hiddenAt ? row.hiddenAt.toISOString() : null,
    hiddenBy: row.hiddenBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/admin/reviews", requireAdmin, async (req, res) => {
  const parsed = AdminListReviewsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  const {
    include_hidden: includeHidden,
    limit: rawLimit,
    offset: rawOffset,
  } = parsed.data;
  const limit = Math.min(
    Math.max(rawLimit ?? ADMIN_DEFAULT_LIMIT, 1),
    ADMIN_MAX_LIMIT,
  );
  const offset = Math.max(rawOffset ?? 0, 0);

  const conditions = includeHidden ? [] : [isNull(toolReviewsTable.hiddenAt)];
  const whereClause =
    conditions.length > 0 ? and(...conditions) : undefined;

  const baseSelect = db
    .select({
      id: toolReviewsTable.id,
      toolId: toolReviewsTable.toolId,
      toolName: toolsTable.name,
      toolSlug: toolsTable.slug,
      userId: toolReviewsTable.userId,
      reviewerEmail: usersTable.email,
      reviewerBranch: profilesTable.branch,
      reviewerRank: profilesTable.rank,
      rating: toolReviewsTable.rating,
      comment: toolReviewsTable.comment,
      hiddenAt: toolReviewsTable.hiddenAt,
      hiddenReason: toolReviewsTable.hiddenReason,
      hiddenBy: toolReviewsTable.hiddenBy,
      createdAt: toolReviewsTable.createdAt,
      updatedAt: toolReviewsTable.updatedAt,
    })
    .from(toolReviewsTable)
    .innerJoin(toolsTable, eq(toolsTable.id, toolReviewsTable.toolId))
    .leftJoin(usersTable, eq(usersTable.id, toolReviewsTable.userId))
    .leftJoin(profilesTable, eq(profilesTable.userId, toolReviewsTable.userId));

  const rows = await (whereClause ? baseSelect.where(whereClause) : baseSelect)
    .orderBy(desc(toolReviewsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const totalQuery = db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(toolReviewsTable);
  const [{ total } = { total: 0 }] = await (whereClause
    ? totalQuery.where(whereClause)
    : totalQuery);

  res.json({
    reviews: rows.map(adminReviewRow),
    total: Number(total ?? 0),
    hasMore: offset + rows.length < Number(total ?? 0),
  });
});

async function fetchAdminReview(id: string) {
  const [row] = await db
    .select({
      id: toolReviewsTable.id,
      toolId: toolReviewsTable.toolId,
      toolName: toolsTable.name,
      toolSlug: toolsTable.slug,
      userId: toolReviewsTable.userId,
      reviewerEmail: usersTable.email,
      reviewerBranch: profilesTable.branch,
      reviewerRank: profilesTable.rank,
      rating: toolReviewsTable.rating,
      comment: toolReviewsTable.comment,
      hiddenAt: toolReviewsTable.hiddenAt,
      hiddenReason: toolReviewsTable.hiddenReason,
      hiddenBy: toolReviewsTable.hiddenBy,
      createdAt: toolReviewsTable.createdAt,
      updatedAt: toolReviewsTable.updatedAt,
    })
    .from(toolReviewsTable)
    .innerJoin(toolsTable, eq(toolsTable.id, toolReviewsTable.toolId))
    .leftJoin(usersTable, eq(usersTable.id, toolReviewsTable.userId))
    .leftJoin(profilesTable, eq(profilesTable.userId, toolReviewsTable.userId))
    .where(eq(toolReviewsTable.id, id))
    .limit(1);
  return row ?? null;
}

router.post("/admin/reviews/:reviewId/hide", requireAdmin, async (req, res) => {
  const parsed = AdminHideReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }
  const reviewId = String(req.params.reviewId);
  const trimmedReason = parsed.data.reason?.trim() ?? "";
  const [updated] = await db
    .update(toolReviewsTable)
    .set({
      hiddenAt: new Date(),
      hiddenReason: trimmedReason ? trimmedReason : null,
      hiddenBy: req.user!.id,
    })
    .where(eq(toolReviewsTable.id, reviewId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  const row = await fetchAdminReview(reviewId);
  if (!row) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  res.json(adminReviewRow(row));
});

router.post(
  "/admin/reviews/:reviewId/unhide",
  requireAdmin,
  async (req, res) => {
    const reviewId = String(req.params.reviewId);
    const [updated] = await db
      .update(toolReviewsTable)
      .set({
        hiddenAt: null,
        hiddenReason: null,
        hiddenBy: null,
      })
      .where(eq(toolReviewsTable.id, reviewId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    const row = await fetchAdminReview(reviewId);
    if (!row) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    res.json(adminReviewRow(row));
  },
);

export default router;
