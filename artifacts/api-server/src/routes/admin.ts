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
  DraftToolTextBody,
  RequestInstallerUploadUrlBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  GithubNotConnectedError,
  GithubNotFoundError,
  getRepoMetadata,
  listRepos,
} from "../lib/github";
import { draftToolText } from "../lib/gemini-helpers";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

interface ToolDetailRow extends Tool {
  categorySlug: string | null;
  categoryName: string | null;
  favoriteCount: number;
  launchCount: number;
  avgRating: string | number | null;
  reviewCount: number;
}

function buildInstallerDownloadUrl(objectKey: string | null): string | null {
  if (!objectKey) return null;
  // Stored as "/objects/uploads/<uuid>"; the storage router serves it at
  // "/api/storage/objects/uploads/<uuid>" which is reachable by browsers.
  if (!objectKey.startsWith("/objects/")) return objectKey;
  const tail = objectKey.slice("/objects/".length);
  return `/api/storage/objects/${tail}`;
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
    isVendorSubmitted: submitterId != null,
    purpose: row.purpose ?? "",
    ragQueryTemplates: row.ragQueryTemplates ?? [],
    installerDownloadUrl:
      row.installerUrl ?? buildInstallerDownloadUrl(row.installerObjectKey),
    gitLastSyncedAt: row.gitLastSyncedAt
      ? row.gitLastSyncedAt.toISOString()
      : null,
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
      contactEmail: toolsTable.contactEmail,
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
      isActive: toolsTable.isActive,
      categoryId: toolsTable.categoryId,
      createdBy: toolsTable.createdBy,
      reviewerId: toolsTable.reviewerId,
      reviewComment: toolsTable.reviewComment,
      submittedAt: toolsTable.submittedAt,
      reviewedAt: toolsTable.reviewedAt,
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

// Common field-mapping for create + update. Returns the set of columns to
// write; null-coalescing here ensures existing patterns (purpose default "")
// are preserved while letting admins explicitly clear optional installer/git
// fields by sending null.
function buildToolWriteValues(
  data:
    | ReturnType<typeof CreateToolBody.parse>
    | ReturnType<typeof UpdateToolBody.parse>,
) {
  return {
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
    hostingType: data.hostingType,
    installerUrl: data.installerUrl ?? null,
    installerObjectKey: data.installerObjectKey ?? null,
    installerFilename: data.installerFilename ?? null,
    installerSizeBytes: data.installerSizeBytes ?? null,
    installerPlatform: data.installerPlatform ?? null,
    installInstructions: data.installInstructions ?? null,
    localLaunchUrlPattern: data.localLaunchUrlPattern ?? null,
    gitRepoOwner: data.gitRepoOwner ?? null,
    gitRepoName: data.gitRepoName ?? null,
    gitDefaultBranch: data.gitDefaultBranch ?? null,
    gitLatestReleaseTag: data.gitLatestReleaseTag ?? null,
    gitLatestCommitSha: data.gitLatestCommitSha ?? null,
    gitLicenseSpdx: data.gitLicenseSpdx ?? null,
    gitStars: data.gitStars ?? null,
  };
}

async function loadToolDetailRow(toolId: string): Promise<ToolDetailRow | null> {
  const [row] = await db
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
      contactEmail: toolsTable.contactEmail,
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
      isActive: toolsTable.isActive,
      categoryId: toolsTable.categoryId,
      createdBy: toolsTable.createdBy,
      reviewerId: toolsTable.reviewerId,
      reviewComment: toolsTable.reviewComment,
      submittedAt: toolsTable.submittedAt,
      reviewedAt: toolsTable.reviewedAt,
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
    .where(eq(toolsTable.id, toolId))
    .limit(1);
  return (row as ToolDetailRow | undefined) ?? null;
}

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
      ...buildToolWriteValues(data),
      submissionStatus: "approved",
      createdBy: req.user!.id,
    })
    .returning();

  const row = await loadToolDetailRow(created.id);
  if (!row) {
    res.status(500).json({ error: "Failed to load created tool" });
    return;
  }
  res.json(serializeToolDetail(row));
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
    .set(buildToolWriteValues(data))
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

  const row = await loadToolDetailRow(updated.id);
  if (!row) {
    res.status(500).json({ error: "Failed to load updated tool" });
    return;
  }
  res.json(serializeToolDetail(row));
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

// ---------------------------------------------------------------------------
// GitHub-backed admin endpoints
// ---------------------------------------------------------------------------

router.get("/admin/github/repos", requireAdmin, async (req, res) => {
  const search =
    typeof req.query.search === "string" ? req.query.search : undefined;
  const page = Number.isFinite(Number(req.query.page))
    ? Math.max(1, Number(req.query.page))
    : 1;
  try {
    const repos = await listRepos({ search, page });
    res.json(repos);
  } catch (err) {
    if (err instanceof GithubNotConnectedError) {
      res.status(503).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Failed to list GitHub repos");
    res.status(500).json({ error: "Failed to list GitHub repos" });
  }
});

router.get("/admin/github/repo-metadata", requireAdmin, async (req, res) => {
  const owner = typeof req.query.owner === "string" ? req.query.owner : "";
  const repo = typeof req.query.repo === "string" ? req.query.repo : "";
  if (!owner || !repo) {
    res.status(400).json({ error: "owner and repo are required" });
    return;
  }
  try {
    const metadata = await getRepoMetadata(owner, repo);
    res.json(metadata);
  } catch (err) {
    if (err instanceof GithubNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GithubNotConnectedError) {
      res.status(503).json({ error: err.message });
      return;
    }
    req.log.error({ err, owner, repo }, "Failed to fetch repo metadata");
    res.status(500).json({ error: "Failed to fetch repo metadata" });
  }
});

router.post(
  "/admin/tools/:id/sync-github",
  requireAdmin,
  async (req, res) => {
    const toolId = String(req.params.id);
    const [existing] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, toolId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    if (!existing.gitRepoOwner || !existing.gitRepoName) {
      res
        .status(400)
        .json({ error: "Tool is not linked to a GitHub repo" });
      return;
    }
    try {
      const meta = await getRepoMetadata(
        existing.gitRepoOwner,
        existing.gitRepoName,
      );
      await db
        .update(toolsTable)
        .set({
          gitDefaultBranch: meta.defaultBranch,
          gitLatestReleaseTag: meta.latestReleaseTag,
          gitLatestCommitSha: meta.latestCommitSha,
          gitLicenseSpdx: meta.licenseSpdx,
          gitStars: meta.stars,
          gitLastSyncedAt: new Date(),
          // Backfill homepageUrl if admin hadn't set one
          homepageUrl: existing.homepageUrl ?? meta.homepageUrl ?? null,
        })
        .where(eq(toolsTable.id, toolId));
      const row = await loadToolDetailRow(toolId);
      if (!row) {
        res.status(500).json({ error: "Failed to reload tool" });
        return;
      }
      res.json(serializeToolDetail(row));
    } catch (err) {
      if (err instanceof GithubNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof GithubNotConnectedError) {
        res.status(503).json({ error: err.message });
        return;
      }
      req.log.error({ err, toolId }, "Failed to sync from GitHub");
      res.status(500).json({ error: "Failed to sync from GitHub" });
    }
  },
);

// ---------------------------------------------------------------------------
// Gemini draft endpoint
// ---------------------------------------------------------------------------

router.post("/admin/tools/draft-text", requireAdmin, async (req, res) => {
  const parsed = DraftToolTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid draft request" });
    return;
  }
  const { field, sourceMaterial } = parsed.data;
  try {
    const result = await draftToolText(field, sourceMaterial ?? {});
    res.json(result);
  } catch (err) {
    req.log.error({ err, field }, "Draft generation failed");
    res.status(500).json({ error: "Failed to generate draft" });
  }
});

// ---------------------------------------------------------------------------
// Installer upload-url helper (delegates to object storage)
// ---------------------------------------------------------------------------

router.post(
  "/admin/tools/installer-upload-url",
  requireAdmin,
  async (req, res) => {
    const parsed = RequestInstallerUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid installer upload request" });
      return;
    }
    try {
      const uploadURL =
        await objectStorageService.getObjectEntityUploadURL();
      const objectKey =
        objectStorageService.normalizeObjectEntityPath(uploadURL);
      const downloadUrl = buildInstallerDownloadUrl(objectKey) ?? objectKey;
      res.json({ uploadUrl: uploadURL, objectKey, downloadUrl });
    } catch (err) {
      req.log.error({ err }, "Installer upload URL minting failed");
      res.status(500).json({ error: "Failed to mint installer upload URL" });
    }
  },
);

export default router;
