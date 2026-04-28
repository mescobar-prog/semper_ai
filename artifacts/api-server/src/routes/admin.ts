import express, { Router, type IRouter } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  toolsTable,
  categoriesTable,
  favoritesTable,
  launchesTable,
  toolReviewsTable,
  usersTable,
  profilesTable,
  installerUploadsTable,
  contextBlocksTable,
  type Tool,
} from "@workspace/db";
import {
  CreateToolBody,
  UpdateToolBody,
  DraftToolTextBody,
  RequestInstallerUploadUrlBody,
  InitInstallerUploadBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  GithubNotConnectedError,
  GithubNotFoundError,
  getRepoMetadata,
  listRepos,
} from "../lib/github";
import { draftToolText } from "../lib/gemini-helpers";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Maximum allowed installer-binary upload size. Mirrors the client-side
// constant `MAX_INSTALLER_UPLOAD_SIZE_BYTES` in
// artifacts/marketplace/src/pages/Admin.tsx — keep in sync.
export const MAX_INSTALLER_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

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

type InstallerVerifyOk = { ok: true; sizeBytes: number | null };
type InstallerVerifyErr = { ok: false; status: number; error: string };

// Independently verify the installer object's actual byte size in object
// storage (HEAD-style metadata fetch) before we let the tool record reference
// it. The earlier check in the upload-URL endpoint trusts the client-declared
// size, but the actual PUT happens directly from the browser to GCS — a
// misbehaving client could declare 1 MB and upload 5 GB. Re-checking here and
// deleting oversized blobs closes that hole.
//
// Returns:
//   - `sizeBytes: <number>` when a new key was verified — caller should
//     persist this (storage-derived) size.
//   - `sizeBytes: null` when no installer key is being set, OR when the key
//     is unchanged from what's already saved. In the unchanged case the
//     caller should keep the previously-stored size and ignore any
//     client-supplied value (otherwise the request payload could spoof
//     `installerSizeBytes` without actually changing the blob).
async function verifyInstallerObjectKey(
  objectKey: string | null | undefined,
  previousKey: string | null,
  log: { error: (obj: object, msg: string) => void },
): Promise<InstallerVerifyOk | InstallerVerifyErr> {
  if (!objectKey) return { ok: true, sizeBytes: null };
  // Skip re-verification when the key is unchanged from what's already saved
  // — that object was verified when first persisted and revalidating on every
  // tool edit would be wasteful.
  if (objectKey === previousKey) return { ok: true, sizeBytes: null };

  let sizeBytes: number;
  try {
    sizeBytes = await objectStorageService.getObjectEntitySize(objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return {
        ok: false,
        status: 400,
        error: "Uploaded installer object was not found in storage.",
      };
    }
    throw err;
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    await objectStorageService
      .deleteObjectEntity(objectKey)
      .catch((err) =>
        log.error({ err, objectKey }, "Failed to delete empty installer blob"),
      );
    return {
      ok: false,
      status: 400,
      error: "Uploaded installer is empty.",
    };
  }

  if (sizeBytes > MAX_INSTALLER_UPLOAD_SIZE_BYTES) {
    // Best-effort delete so the orphaned oversized blob doesn't linger.
    await objectStorageService
      .deleteObjectEntity(objectKey)
      .catch((err) =>
        log.error(
          { err, objectKey, sizeBytes },
          "Failed to delete oversized installer blob",
        ),
      );
    return {
      ok: false,
      status: 413,
      error: `Installer too large. Maximum size is ${Math.floor(
        MAX_INSTALLER_UPLOAD_SIZE_BYTES / (1024 * 1024),
      )} MB.`,
    };
  }

  return { ok: true, sizeBytes };
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

  const installerCheck = await verifyInstallerObjectKey(
    data.installerObjectKey,
    null,
    req.log,
  );
  if (!installerCheck.ok) {
    res.status(installerCheck.status).json({ error: installerCheck.error });
    return;
  }
  // Always derive installerSizeBytes from object storage — never trust the
  // client payload. On create with no installer key, force null.
  data.installerSizeBytes = installerCheck.sizeBytes;

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

  // Look up the previously-stored installer key + size so we can skip
  // re-verifying an unchanged reference and so we never let the client's
  // payload spoof installerSizeBytes (only storage-derived sizes are
  // trusted).
  const [existing] = await db
    .select({
      installerObjectKey: toolsTable.installerObjectKey,
      installerSizeBytes: toolsTable.installerSizeBytes,
    })
    .from(toolsTable)
    .where(
      and(
        eq(toolsTable.id, String(req.params.id)),
        eq(toolsTable.submissionStatus, "approved"),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  const installerCheck = await verifyInstallerObjectKey(
    data.installerObjectKey,
    existing.installerObjectKey ?? null,
    req.log,
  );
  if (!installerCheck.ok) {
    res.status(installerCheck.status).json({ error: installerCheck.error });
    return;
  }
  // Pick installerSizeBytes from authoritative sources only:
  //   - newly-uploaded blob: storage-derived size from the HEAD check
  //   - unchanged key: previously-stored DB value
  //   - cleared key: null
  // The request payload's installerSizeBytes is intentionally ignored.
  if (installerCheck.sizeBytes !== null) {
    data.installerSizeBytes = installerCheck.sizeBytes;
  } else if (data.installerObjectKey && data.installerObjectKey === existing.installerObjectKey) {
    data.installerSizeBytes = existing.installerSizeBytes ?? null;
  } else {
    data.installerSizeBytes = null;
  }

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
// Context Block confirmation audit
// ---------------------------------------------------------------------------

function displayName(u: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const parts = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return parts || u.email || "Unknown user";
}

router.get(
  "/admin/context-block-confirmations",
  requireAdmin,
  async (_req, res) => {
    const rows = await db
      .select({
        userId: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        branch: profilesTable.branch,
        rank: profilesTable.rank,
        isAdmin: profilesTable.isAdmin,
        cbConfirmedAt: contextBlocksTable.confirmedAt,
        cbScoreTotal: contextBlocksTable.scoreTotal,
        cbStatus: contextBlocksTable.status,
        cbOpsecFlag: contextBlocksTable.opsecFlag,
        cbBypassed: contextBlocksTable.bypassed,
        cbSubmissionId: contextBlocksTable.submissionId,
      })
      .from(usersTable)
      .leftJoin(profilesTable, eq(profilesTable.userId, usersTable.id))
      .leftJoin(
        contextBlocksTable,
        eq(contextBlocksTable.userId, usersTable.id),
      )
      // Confirmed users first (most recent first), then never-confirmed users
      // alphabetically by email so the "missing" list is stable.
      .orderBy(
        sql`${contextBlocksTable.confirmedAt} DESC NULLS LAST`,
        asc(usersTable.email),
      );

    const users = rows.map((r) => {
      const hasConfirmed = r.cbConfirmedAt != null;
      return {
        userId: r.userId,
        displayName: displayName({
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
        }),
        email: r.email,
        branch: r.branch,
        rank: r.rank,
        isAdmin: r.isAdmin === "true",
        hasConfirmed,
        confirmedAt: r.cbConfirmedAt ? r.cbConfirmedAt.toISOString() : null,
        scoreTotal: r.cbScoreTotal,
        status: r.cbStatus,
        opsecFlag: r.cbOpsecFlag === "true",
        bypassed: r.cbBypassed === "true",
        submissionId: r.cbSubmissionId,
      };
    });

    const totals = users.reduce(
      (acc, u) => {
        acc.totalUsers += 1;
        if (u.hasConfirmed) acc.confirmedUsers += 1;
        else acc.unconfirmedUsers += 1;
        if (u.opsecFlag) acc.opsecFlaggedUsers += 1;
        if (u.status === "NO-GO") acc.noGoUsers += 1;
        if (u.bypassed) acc.bypassedUsers += 1;
        return acc;
      },
      {
        totalUsers: 0,
        confirmedUsers: 0,
        unconfirmedUsers: 0,
        opsecFlaggedUsers: 0,
        noGoUsers: 0,
        bypassedUsers: 0,
      },
    );

    res.json({ users, totals });
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
  const { field, sourceMaterial, steering } = parsed.data;
  try {
    const result = await draftToolText(
      field,
      sourceMaterial ?? {},
      steering ?? null,
    );
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
    if (parsed.data.sizeBytes > MAX_INSTALLER_UPLOAD_SIZE_BYTES) {
      res.status(413).json({
        error: `Installer too large. Maximum size is ${Math.floor(
          MAX_INSTALLER_UPLOAD_SIZE_BYTES / (1024 * 1024),
        )} MB.`,
      });
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

// ---------------------------------------------------------------------------
// Resumable installer upload (chunked)
// ---------------------------------------------------------------------------
//
// The flow is:
//   1. POST /admin/tools/installer-upload-init       → start or resume
//   2. PUT  /admin/tools/installer-upload/:id/chunk  → push 8 MB chunk
//   3. POST /admin/tools/installer-upload/:id/complete (after final chunk)
//      POST /admin/tools/installer-upload/:id/abort  (give up cleanly)
//
// We proxy chunks through the API server (rather than letting the browser
// PUT directly to GCS) so that we don't depend on the bucket's CORS config
// allowing `Content-Range` request headers, and so the API server can be
// the single source of truth on `bytesUploaded` (persisted in DB) for
// resume-after-page-reload.
//
// Chunk size MUST be a multiple of 256 KB except for the final chunk —
// that's a GCS resumable-upload requirement.

const INSTALLER_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
// Allow a little headroom over the chunk size for HTTP overhead.
const INSTALLER_UPLOAD_CHUNK_LIMIT = INSTALLER_UPLOAD_CHUNK_SIZE + 64 * 1024;

router.post(
  "/admin/tools/installer-upload-init",
  requireAdmin,
  async (req, res) => {
    const parsed = InitInstallerUploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid installer upload request" });
      return;
    }
    const { filename, sizeBytes, contentType, fileFingerprint } = parsed.data;
    if (sizeBytes > MAX_INSTALLER_UPLOAD_SIZE_BYTES) {
      res.status(413).json({
        error: `Installer too large. Maximum size is ${Math.floor(
          MAX_INSTALLER_UPLOAD_SIZE_BYTES / (1024 * 1024),
        )} MB.`,
      });
      return;
    }
    const userId = req.user!.id;

    try {
      const [existing] = await db
        .select()
        .from(installerUploadsTable)
        .where(
          and(
            eq(installerUploadsTable.userId, userId),
            eq(installerUploadsTable.fileFingerprint, fileFingerprint),
            isNull(installerUploadsTable.completedAt),
          ),
        )
        .limit(1);

      // Reuse an in-progress session when the same user is uploading the
      // same file (matched by fingerprint). Refresh `bytesUploaded` from
      // GCS so the client gets an authoritative resume offset even if the
      // last successful chunk's DB write was lost.
      if (existing && existing.sizeBytes === sizeBytes) {
        const liveOffset = await queryGcsResumableOffset(
          existing.sessionUri,
          existing.sizeBytes,
        );
        let bytesUploaded = existing.bytesUploaded;
        if (liveOffset.kind === "in_progress") {
          bytesUploaded = liveOffset.bytesUploaded;
          if (bytesUploaded !== existing.bytesUploaded) {
            await db
              .update(installerUploadsTable)
              .set({ bytesUploaded })
              .where(eq(installerUploadsTable.id, existing.id));
          }
          res.json({
            uploadId: existing.id,
            objectKey: existing.objectKey,
            downloadUrl:
              buildInstallerDownloadUrl(existing.objectKey) ??
              existing.objectKey,
            sizeBytes: existing.sizeBytes,
            bytesUploaded,
            chunkSize: INSTALLER_UPLOAD_CHUNK_SIZE,
            resumed: true,
          });
          return;
        }
        if (liveOffset.kind === "complete") {
          await db
            .update(installerUploadsTable)
            .set({
              bytesUploaded: existing.sizeBytes,
              completedAt: new Date(),
            })
            .where(eq(installerUploadsTable.id, existing.id));
          res.json({
            uploadId: existing.id,
            objectKey: existing.objectKey,
            downloadUrl:
              buildInstallerDownloadUrl(existing.objectKey) ??
              existing.objectKey,
            sizeBytes: existing.sizeBytes,
            bytesUploaded: existing.sizeBytes,
            chunkSize: INSTALLER_UPLOAD_CHUNK_SIZE,
            resumed: true,
          });
          return;
        }
        // liveOffset.kind === "expired" → session no longer valid. Mark
        // this row completed (so it stops blocking the unique index) and
        // fall through to mint a fresh session.
        await db
          .update(installerUploadsTable)
          .set({ completedAt: new Date() })
          .where(eq(installerUploadsTable.id, existing.id));
      } else if (existing) {
        // Same fingerprint but different sizeBytes → file was modified or
        // a different file collided. Retire the old session and mint a
        // new one.
        await db
          .update(installerUploadsTable)
          .set({ completedAt: new Date() })
          .where(eq(installerUploadsTable.id, existing.id));
      }

      const { sessionUri, objectKey } =
        await objectStorageService.createResumableUploadSession({ contentType });

      const [created] = await db
        .insert(installerUploadsTable)
        .values({
          userId,
          objectKey,
          sessionUri,
          filename,
          sizeBytes,
          contentType,
          fileFingerprint,
          bytesUploaded: 0,
        })
        .returning();

      res.json({
        uploadId: created.id,
        objectKey: created.objectKey,
        downloadUrl:
          buildInstallerDownloadUrl(created.objectKey) ?? created.objectKey,
        sizeBytes: created.sizeBytes,
        bytesUploaded: 0,
        chunkSize: INSTALLER_UPLOAD_CHUNK_SIZE,
        resumed: false,
      });
    } catch (err) {
      req.log.error({ err }, "Installer upload init failed");
      res.status(500).json({ error: "Failed to start installer upload" });
    }
  },
);

router.put(
  "/admin/tools/installer-upload/:uploadId/chunk",
  requireAdmin,
  express.raw({
    type: () => true,
    limit: INSTALLER_UPLOAD_CHUNK_LIMIT,
  }),
  async (req, res) => {
    const uploadId = String(req.params.uploadId);
    const userId = req.user!.id;

    const offsetParam = req.query.offset;
    const offset = Number(
      Array.isArray(offsetParam) ? offsetParam[0] : offsetParam,
    );
    if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
      res.status(400).json({ error: "offset query param required" });
      return;
    }

    const chunk = req.body as Buffer;
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      res.status(400).json({ error: "Empty chunk body" });
      return;
    }

    try {
      const [session] = await db
        .select()
        .from(installerUploadsTable)
        .where(
          and(
            eq(installerUploadsTable.id, uploadId),
            eq(installerUploadsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!session) {
        res.status(404).json({ error: "Upload session not found" });
        return;
      }
      if (session.completedAt) {
        res.status(409).json({
          error: "Upload session already completed",
          bytesUploaded: session.sizeBytes,
        });
        return;
      }
      if (offset !== session.bytesUploaded) {
        // Client and server drifted (likely a duplicate retry). Tell the
        // client where to resume from rather than corrupting the upload.
        res.status(409).json({
          error: "Offset mismatch",
          expectedOffset: session.bytesUploaded,
          bytesUploaded: session.bytesUploaded,
        });
        return;
      }
      if (offset + chunk.length > session.sizeBytes) {
        res.status(400).json({
          error: "Chunk extends past declared file size",
        });
        return;
      }

      const result = await pushChunkToGcs(
        session.sessionUri,
        chunk,
        offset,
        session.sizeBytes,
      );

      if (result.kind === "error") {
        req.log.error(
          { uploadId, status: result.status, body: result.body },
          "GCS chunk PUT failed",
        );
        res.status(502).json({
          error: `Storage chunk upload failed — please retry.`,
        });
        return;
      }

      const newBytesUploaded =
        result.kind === "complete" ? session.sizeBytes : result.bytesUploaded;

      await db
        .update(installerUploadsTable)
        .set({
          bytesUploaded: newBytesUploaded,
          completedAt: result.kind === "complete" ? new Date() : null,
        })
        .where(eq(installerUploadsTable.id, uploadId));

      res.json({
        bytesUploaded: newBytesUploaded,
        sizeBytes: session.sizeBytes,
        complete: result.kind === "complete",
      });
    } catch (err) {
      req.log.error({ err, uploadId }, "Installer upload chunk failed");
      res.status(500).json({ error: "Failed to upload chunk" });
    }
  },
);

router.post(
  "/admin/tools/installer-upload/:uploadId/complete",
  requireAdmin,
  async (req, res) => {
    const uploadId = String(req.params.uploadId);
    const userId = req.user!.id;
    try {
      const [session] = await db
        .select()
        .from(installerUploadsTable)
        .where(
          and(
            eq(installerUploadsTable.id, uploadId),
            eq(installerUploadsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!session) {
        res.status(404).json({ error: "Upload session not found" });
        return;
      }
      if (session.bytesUploaded !== session.sizeBytes) {
        res.status(409).json({
          error: "Upload not yet fully received",
          bytesUploaded: session.bytesUploaded,
          sizeBytes: session.sizeBytes,
        });
        return;
      }
      if (!session.completedAt) {
        await db
          .update(installerUploadsTable)
          .set({ completedAt: new Date() })
          .where(eq(installerUploadsTable.id, uploadId));
      }
      res.json({
        objectKey: session.objectKey,
        downloadUrl:
          buildInstallerDownloadUrl(session.objectKey) ?? session.objectKey,
        sizeBytes: session.sizeBytes,
        filename: session.filename,
      });
    } catch (err) {
      req.log.error({ err, uploadId }, "Installer upload complete failed");
      res.status(500).json({ error: "Failed to complete installer upload" });
    }
  },
);

router.post(
  "/admin/tools/installer-upload/:uploadId/abort",
  requireAdmin,
  async (req, res) => {
    const uploadId = String(req.params.uploadId);
    const userId = req.user!.id;
    try {
      const [session] = await db
        .select()
        .from(installerUploadsTable)
        .where(
          and(
            eq(installerUploadsTable.id, uploadId),
            eq(installerUploadsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!session) {
        res.status(404).json({ error: "Upload session not found" });
        return;
      }
      // Best-effort tell GCS to drop the resumable session so the bytes
      // already uploaded don't linger as orphaned data.
      void cancelGcsResumableSession(session.sessionUri).catch((err) => {
        req.log.warn({ err, uploadId }, "GCS cancel failed; ignoring");
      });
      await db
        .update(installerUploadsTable)
        .set({ completedAt: new Date() })
        .where(eq(installerUploadsTable.id, uploadId));
      res.status(204).end();
    } catch (err) {
      req.log.error({ err, uploadId }, "Installer upload abort failed");
      res.status(500).json({ error: "Failed to abort installer upload" });
    }
  },
);

// ---------------------------------------------------------------------------
// GCS resumable upload helpers
// ---------------------------------------------------------------------------

type ChunkPushResult =
  | { kind: "in_progress"; bytesUploaded: number }
  | { kind: "complete" }
  | { kind: "error"; status: number; body: string };

async function pushChunkToGcs(
  sessionUri: string,
  chunk: Buffer,
  offset: number,
  totalSize: number,
): Promise<ChunkPushResult> {
  const start = offset;
  const end = offset + chunk.length - 1;
  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
    },
    // Buffer is accepted by undici/Node fetch at runtime; the lib.dom
    // BodyInit shape doesn't include Node Buffer so cast through unknown.
    body: chunk as unknown as ArrayBuffer,
  });

  // 308 Resume Incomplete → more chunks expected. The Range response
  // header tells us the inclusive last byte GCS has stored.
  if (response.status === 308) {
    const range = response.headers.get("range");
    let bytesUploaded = 0;
    if (range) {
      const m = range.match(/bytes=0-(\d+)/);
      if (m) bytesUploaded = Number(m[1]) + 1;
    }
    return { kind: "in_progress", bytesUploaded };
  }

  if (response.status >= 200 && response.status < 300) {
    return { kind: "complete" };
  }

  const body = await response.text().catch(() => "");
  return { kind: "error", status: response.status, body };
}

type GcsOffsetResult =
  | { kind: "in_progress"; bytesUploaded: number }
  | { kind: "complete" }
  | { kind: "expired" };

async function queryGcsResumableOffset(
  sessionUri: string,
  totalSize: number,
): Promise<GcsOffsetResult> {
  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "Content-Length": "0",
      "Content-Range": `bytes */${totalSize}`,
    },
  });

  if (response.status === 308) {
    const range = response.headers.get("range");
    let bytesUploaded = 0;
    if (range) {
      const m = range.match(/bytes=0-(\d+)/);
      if (m) bytesUploaded = Number(m[1]) + 1;
    }
    return { kind: "in_progress", bytesUploaded };
  }

  if (response.status >= 200 && response.status < 300) {
    return { kind: "complete" };
  }

  // 404 / 410 / 499 etc. → session URI no longer valid (commonly because
  // it expired or was cancelled).
  return { kind: "expired" };
}

async function cancelGcsResumableSession(sessionUri: string): Promise<void> {
  // Per the GCS XML API resumable-upload protocol, sending DELETE to the
  // session URI cancels it.
  await fetch(sessionUri, { method: "DELETE" });
}

export default router;
