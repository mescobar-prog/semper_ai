import { Router, type IRouter } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import {
  db,
  toolsTable,
  categoriesTable,
  usersTable,
} from "@workspace/db";
import {
  CreateSubmissionBody,
  UpdateMySubmissionBody,
  ReviewSubmissionBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const REVIEW_QUEUE_STATUSES = ["pending", "changes_requested"];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function uniqueSubmissionSlug(name: string): Promise<string> {
  const base = slugify(name) || "submission";
  let candidate = base;
  let suffix = 1;
  // Loop until we find a slug that doesn't exist.
  // Cap at 100 attempts to avoid pathological cases.
  while (suffix < 100) {
    const [hit] = await db
      .select({ id: toolsTable.id })
      .from(toolsTable)
      .where(eq(toolsTable.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${Date.now()}`;
}

function displayUser(u: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
} | null): string | null {
  if (!u) return null;
  const parts = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return parts || u.email || null;
}

type ToolRow = typeof toolsTable.$inferSelect;

function serializeSubmission(
  row: ToolRow,
  category: { slug: string | null; name: string | null } | null,
  submitter: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null,
) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    vendor: row.vendor,
    shortDescription: row.shortDescription,
    longDescription: row.longDescription,
    atoStatus: row.atoStatus,
    impactLevels: row.impactLevels ?? [],
    dataClassification: row.dataClassification,
    launchUrl: row.launchUrl,
    homepageUrl: row.homepageUrl,
    documentationUrl: row.documentationUrl,
    logoUrl: row.logoUrl,
    contactEmail: row.contactEmail,
    categoryId: row.categoryId,
    categorySlug: category?.slug ?? null,
    categoryName: category?.name ?? null,
    submissionStatus: row.submissionStatus,
    submitterId: row.submitterId,
    submitterDisplayName: displayUser(submitter),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    reviewComment: row.reviewComment,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    isVendorSubmitted: row.submitterId != null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadSubmissionWithRelations(id: string) {
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, id))
    .limit(1);
  if (!tool) return null;
  const [category] = tool.categoryId
    ? await db
        .select({ slug: categoriesTable.slug, name: categoriesTable.name })
        .from(categoriesTable)
        .where(eq(categoriesTable.id, tool.categoryId))
        .limit(1)
    : [null];
  const [submitter] = tool.submitterId
    ? await db
        .select({
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          email: usersTable.email,
        })
        .from(usersTable)
        .where(eq(usersTable.id, tool.submitterId))
        .limit(1)
    : [null];
  return { tool, category, submitter };
}

router.get("/submissions", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const rows = await db
    .select({
      tool: toolsTable,
      category: { slug: categoriesTable.slug, name: categoriesTable.name },
    })
    .from(toolsTable)
    .leftJoin(categoriesTable, eq(toolsTable.categoryId, categoriesTable.id))
    .where(eq(toolsTable.submitterId, userId))
    .orderBy(desc(toolsTable.submittedAt));

  res.json(
    rows.map((r) => ({
      id: r.tool.id,
      slug: r.tool.slug,
      name: r.tool.name,
      vendor: r.tool.vendor,
      shortDescription: r.tool.shortDescription,
      atoStatus: r.tool.atoStatus,
      submissionStatus: r.tool.submissionStatus,
      submittedAt: r.tool.submittedAt
        ? r.tool.submittedAt.toISOString()
        : null,
      updatedAt: r.tool.updatedAt.toISOString(),
      reviewComment: r.tool.reviewComment,
      reviewedAt: r.tool.reviewedAt ? r.tool.reviewedAt.toISOString() : null,
      isVendorSubmitted: r.tool.submitterId != null,
    })),
  );
});

router.post("/submissions", requireAuth, async (req, res) => {
  const parsed = CreateSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid submission data" });
    return;
  }
  const data = parsed.data;
  const now = new Date();

  // Slug uniqueness is enforced both by `uniqueSubmissionSlug`'s pre-check
  // and the `tools.slug` UNIQUE constraint. Two concurrent submissions for
  // the same tool name can pass the pre-check, then race on insert and
  // collide on the constraint. Retry with a fresh slug suffix a few times
  // before giving up — surface a clean 409 if the burst is sustained.
  const MAX_SLUG_ATTEMPTS = 5;
  let created: typeof toolsTable.$inferSelect | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = await uniqueSubmissionSlug(data.name);
    try {
      const rows = await db
        .insert(toolsTable)
        .values({
          slug,
          name: data.name,
          vendor: data.vendor,
          shortDescription: data.shortDescription,
          longDescription: data.longDescription,
          categoryId: data.categoryId ?? null,
          atoStatus: data.atoStatus,
          impactLevels: data.impactLevels,
          dataClassification: data.dataClassification,
          badges: [],
          homepageUrl: data.homepageUrl ?? null,
          launchUrl: data.launchUrl,
          documentationUrl: data.documentationUrl ?? null,
          logoUrl: data.logoUrl ?? null,
          contactEmail: data.contactEmail,
          isActive: "false",
          submissionStatus: "pending",
          submitterId: req.user!.id,
          submittedAt: now,
          createdBy: req.user!.id,
        })
        .returning();
      created = rows[0];
      break;
    } catch (err) {
      lastErr = err;
      // Detect Postgres unique-violation on the slug column. drizzle wraps
      // the underlying pg error; check both the SQLSTATE code and the
      // message for the constraint name.
      const code = (err as { code?: string } | null)?.code;
      const message =
        err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isSlugDup =
        code === "23505" &&
        (message.includes("slug") || message.includes("tools_slug"));
      if (!isSlugDup) throw err;
      // Loop and try a fresh slug — uniqueSubmissionSlug will pick a new
      // suffix now that the racing row is committed.
    }
  }

  if (!created) {
    logger.warn({ err: lastErr, name: data.name }, "submission slug retry exhausted");
    res
      .status(409)
      .json({ error: "Could not allocate a unique slug — please try again." });
    return;
  }

  const loaded = await loadSubmissionWithRelations(created.id);
  if (!loaded) {
    res.status(500).json({ error: "Failed to load created submission" });
    return;
  }
  res.json(
    serializeSubmission(loaded.tool, loaded.category, loaded.submitter),
  );
});

router.get("/submissions/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const loaded = await loadSubmissionWithRelations(id);
  if (!loaded || loaded.tool.submitterId !== req.user!.id) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }
  res.json(
    serializeSubmission(loaded.tool, loaded.category, loaded.submitter),
  );
});

router.put("/submissions/:id", requireAuth, async (req, res) => {
  const parsed = UpdateMySubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid submission data" });
    return;
  }
  const id = String(req.params.id);
  const [existing] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, id))
    .limit(1);
  if (!existing || existing.submitterId !== req.user!.id) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }
  if (
    existing.submissionStatus !== "pending" &&
    existing.submissionStatus !== "changes_requested"
  ) {
    res.status(403).json({
      error:
        "Only pending or changes-requested submissions can be edited by the submitter",
    });
    return;
  }
  const data = parsed.data;
  const now = new Date();
  await db
    .update(toolsTable)
    .set({
      name: data.name,
      vendor: data.vendor,
      shortDescription: data.shortDescription,
      longDescription: data.longDescription,
      categoryId: data.categoryId ?? null,
      atoStatus: data.atoStatus,
      impactLevels: data.impactLevels,
      dataClassification: data.dataClassification,
      launchUrl: data.launchUrl,
      homepageUrl: data.homepageUrl ?? null,
      documentationUrl: data.documentationUrl ?? null,
      logoUrl: data.logoUrl ?? null,
      contactEmail: data.contactEmail,
      submissionStatus: "pending",
      submittedAt: now,
    })
    .where(eq(toolsTable.id, id));

  const loaded = await loadSubmissionWithRelations(id);
  if (!loaded) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }
  res.json(
    serializeSubmission(loaded.tool, loaded.category, loaded.submitter),
  );
});

router.post("/submissions/:id/withdraw", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const [existing] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, id))
    .limit(1);
  if (!existing || existing.submitterId !== req.user!.id) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }
  if (
    existing.submissionStatus !== "pending" &&
    existing.submissionStatus !== "changes_requested"
  ) {
    res.status(403).json({
      error:
        "Only pending or changes-requested submissions can be withdrawn",
    });
    return;
  }
  await db
    .update(toolsTable)
    .set({ submissionStatus: "withdrawn", isActive: "false" })
    .where(eq(toolsTable.id, id));

  const loaded = await loadSubmissionWithRelations(id);
  if (!loaded) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }
  res.json(
    serializeSubmission(loaded.tool, loaded.category, loaded.submitter),
  );
});

router.get("/admin/submissions", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(toolsTable)
    .where(inArray(toolsTable.submissionStatus, REVIEW_QUEUE_STATUSES))
    .orderBy(desc(toolsTable.submittedAt));

  const categoryIds = Array.from(
    new Set(rows.map((r) => r.categoryId).filter((v): v is string => !!v)),
  );
  const submitterIds = Array.from(
    new Set(rows.map((r) => r.submitterId).filter((v): v is string => !!v)),
  );
  const categories = categoryIds.length
    ? await db
        .select()
        .from(categoriesTable)
        .where(inArray(categoriesTable.id, categoryIds))
    : [];
  const submitters = submitterIds.length
    ? await db
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          email: usersTable.email,
        })
        .from(usersTable)
        .where(inArray(usersTable.id, submitterIds))
    : [];
  const catById = new Map(categories.map((c) => [c.id, c]));
  const subById = new Map(submitters.map((s) => [s.id, s]));

  res.json(
    rows.map((row) =>
      serializeSubmission(
        row,
        row.categoryId ? catById.get(row.categoryId) ?? null : null,
        row.submitterId ? subById.get(row.submitterId) ?? null : null,
      ),
    ),
  );
});

router.post(
  "/admin/submissions/:id/review",
  requireAdmin,
  async (req, res) => {
    const parsed = ReviewSubmissionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid review payload" });
      return;
    }
    const id = String(req.params.id);
    const [existing] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    if (
      existing.submissionStatus !== "pending" &&
      existing.submissionStatus !== "changes_requested"
    ) {
      res.status(400).json({
        error: "Only pending or changes-requested submissions can be reviewed",
      });
      return;
    }
    const { action, comment } = parsed.data;
    const reviewedAt = new Date();

    if (action === "approve") {
      await db
        .update(toolsTable)
        .set({
          submissionStatus: "approved",
          reviewerId: req.user!.id,
          reviewedAt,
          reviewComment: comment ?? null,
          isActive: "true",
        })
        .where(eq(toolsTable.id, id));
    } else if (action === "request_changes") {
      if (!comment || !comment.trim()) {
        res.status(400).json({
          error: "A comment is required when requesting changes",
        });
        return;
      }
      await db
        .update(toolsTable)
        .set({
          submissionStatus: "changes_requested",
          reviewerId: req.user!.id,
          reviewedAt,
          reviewComment: comment,
        })
        .where(eq(toolsTable.id, id));
    } else if (action === "reject") {
      if (!comment || !comment.trim()) {
        res.status(400).json({
          error: "A comment is required when rejecting a submission",
        });
        return;
      }
      await db
        .update(toolsTable)
        .set({
          submissionStatus: "rejected",
          reviewerId: req.user!.id,
          reviewedAt,
          reviewComment: comment,
          isActive: "false",
        })
        .where(eq(toolsTable.id, id));
    }

    const loaded = await loadSubmissionWithRelations(id);
    if (!loaded) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    res.json(
      serializeSubmission(loaded.tool, loaded.category, loaded.submitter),
    );
  },
);

export default router;
