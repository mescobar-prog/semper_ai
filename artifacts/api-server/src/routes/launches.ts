import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  db,
  toolsTable,
  launchesTable,
  launchTokensTable,
  sessionTokensTable,
  usersTable,
  docChunksTable,
  documentsTable,
  type LaunchSharedSnippet,
} from "@workspace/db";
import {
  DraftBriefBody,
  ExchangeContextTokenBody,
  LaunchToolBody,
  QueryLibraryBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { generateOpaqueToken } from "../lib/tokens";
import {
  draftMissionBrief,
  generateRagQueries,
  type BriefType,
} from "../lib/gemini-helpers";
import { searchChunks, searchChunksMultiQuery } from "../lib/rag";
import {
  buildContextBlock,
  ensureActivePreset,
  getActiveContext,
  getOrCreateContextBlock,
  getOrCreateProfile,
  hasConfirmedContextBlock,
  serializeContextBlock,
  serializeProfile,
  snapshotAsProfile,
  redactProfileForLaunch,
  SHAREABLE_PROFILE_FIELDS,
  profileFieldDisplayValue,
} from "../lib/profile-helpers";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const LAUNCH_TOKEN_TTL_MS = 5 * 60 * 1000;
const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000;

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host =
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

async function loadActiveTool(toolId: string) {
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, toolId))
    .limit(1);
  return tool;
}

// POST /tools/:toolId/launch-preview
// Returns the candidate context bundle (profile fields + RAG snippets) the
// user is about to send, *without* minting a launch token. The marketplace
// frontend uses this to render the pre-launch preview / redaction panel.
router.post("/tools/:toolId/launch-preview", requireAuth, async (req, res) => {
  const tool = await loadActiveTool(String(req.params.toolId));
  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }
  if (tool.isActive !== "true") {
    res.status(403).json({ error: "Tool is not active" });
    return;
  }

  // Resolve the user's active mission preset; the snapshot drives identity
  // for the preview (so the candidate list reflects what would actually be
  // sent on launch), and the preset's document set scopes RAG so the user
  // doesn't see snippets from outside their chosen mission scope.
  const ctx = await getActiveContext(req.user!.id);
  const snapshotProfile = snapshotAsProfile(ctx.snapshot, ctx.profile);

  let queries: string[] = [];
  let snippets: Awaited<ReturnType<typeof searchChunksMultiQuery>> = [];
  try {
    queries = await generateRagQueries(snapshotProfile, {
      name: tool.name,
      vendor: tool.vendor,
      shortDescription: tool.shortDescription,
      longDescription: tool.longDescription,
      purpose: tool.purpose,
      ragQueryTemplates: tool.ragQueryTemplates,
    });
    snippets = await searchChunksMultiQuery(req.user!.id, queries, 4, 12, {
      documentIds: ctx.documentIds,
    });
  } catch (err) {
    logger.warn({ err }, "RAG preview failed; returning empty candidates");
  }

  const profileFields = SHAREABLE_PROFILE_FIELDS.map(({ key, label }) => {
    const { value, hasValue } = profileFieldDisplayValue(snapshotProfile, key);
    return { key: key as string, label, value, hasValue };
  });

  res.json({
    tool: {
      id: tool.id,
      slug: tool.slug,
      name: tool.name,
      vendor: tool.vendor,
    },
    profileFields,
    candidateSnippets: snippets,
    queries,
    launchPreference:
      ctx.profile.launchPreference === "direct" ? "direct" : "preview",
  });
});

// POST /tools/:toolId/launch
// Mints a single-use launch token. Accepts an optional allowlist of profile
// field keys + RAG chunk IDs + a freeform note. When the body is omitted (or
// arrays are null), behaves like the legacy direct-launch flow: include all
// populated profile fields and run RAG to pick snippets server-side.
router.post("/tools/:toolId/launch", requireAuth, async (req, res) => {
  const tool = await loadActiveTool(String(req.params.toolId));
  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }
  if (tool.isActive !== "true") {
    res.status(403).json({ error: "Tool is not active" });
    return;
  }

  // Body is optional; an empty body is equivalent to "include everything".
  const body = req.body && Object.keys(req.body).length > 0 ? req.body : {};
  const parsed = LaunchToolBody.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid launch selection" });
    return;
  }
  const { selectedFieldKeys, selectedSnippetIds, additionalNote } = parsed.data;

  // Ensure an active preset exists and use its snapshot as the profile basis;
  // RAG is scoped to the preset's documents so launches stay within mission.
  const ctx = await getActiveContext(req.user!.id);
  const snapshotProfile = snapshotAsProfile(ctx.snapshot, ctx.profile);
  const preset = ctx.activePreset;

  // Decide which profile field keys to share. Null/undefined => all populated.
  const allFieldKeys = SHAREABLE_PROFILE_FIELDS.map(({ key }) => key as string);
  let sharedFieldKeys: string[];
  if (selectedFieldKeys == null) {
    sharedFieldKeys = allFieldKeys.filter((k) => {
      const { hasValue } = profileFieldDisplayValue(
        snapshotProfile,
        k as keyof typeof snapshotProfile,
      );
      return hasValue;
    });
  } else {
    const allowSet = new Set(allFieldKeys);
    sharedFieldKeys = Array.from(new Set(selectedFieldKeys)).filter((k) =>
      allowSet.has(k),
    );
  }

  // Decide which snippets to share. Null/undefined => run RAG and include all
  // selected snippets. Otherwise, look up the requested chunk IDs (scoped to
  // this user + preset doc set so a caller can't peek at someone else's
  // library or snippets outside the active mission).
  let sharedSnippets: LaunchSharedSnippet[] = [];
  try {
    if (selectedSnippetIds == null) {
      const queries = await generateRagQueries(snapshotProfile, {
        name: tool.name,
        vendor: tool.vendor,
        shortDescription: tool.shortDescription,
        longDescription: tool.longDescription,
        purpose: tool.purpose,
        ragQueryTemplates: tool.ragQueryTemplates,
      });
      sharedSnippets = await searchChunksMultiQuery(
        req.user!.id,
        queries,
        4,
        12,
        { documentIds: ctx.documentIds },
      );
    } else if (selectedSnippetIds.length > 0) {
      const presetDocIds = new Set(ctx.documentIds);
      const rows = await db
        .select({
          chunkId: docChunksTable.id,
          documentId: docChunksTable.documentId,
          documentTitle: documentsTable.title,
          chunkIndex: docChunksTable.chunkIndex,
          content: docChunksTable.content,
        })
        .from(docChunksTable)
        .innerJoin(
          documentsTable,
          eq(documentsTable.id, docChunksTable.documentId),
        )
        .where(
          and(
            eq(docChunksTable.userId, req.user!.id),
            inArray(docChunksTable.id, selectedSnippetIds),
          ),
        );
      // Preserve the order the client sent so highest-relevance hits stay first.
      const byId = new Map(rows.map((r) => [r.chunkId, r]));
      sharedSnippets = selectedSnippetIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .filter(
          (r) => presetDocIds.size === 0 || presetDocIds.has(r.documentId),
        )
        .map((r) => ({
          chunkId: r.chunkId,
          documentId: r.documentId,
          documentTitle: r.documentTitle,
          chunkIndex: r.chunkIndex,
          content: r.content,
          score: 0,
        }));
    }
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve launch snippets; proceeding with what we have",
    );
  }

  const note =
    typeof additionalNote === "string" && additionalNote.trim().length > 0
      ? additionalNote.trim()
      : null;

  const [launch] = await db
    .insert(launchesTable)
    .values({
      userId: req.user!.id,
      toolId: tool.id,
      status: "token_issued",
      sharedFieldKeys,
      sharedSnippets,
      additionalNote: note,
    })
    .returning();

  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + LAUNCH_TOKEN_TTL_MS);
  await db.insert(launchTokensTable).values({
    token,
    launchId: launch.id,
    expiresAt,
  });
  logger.info(
    { launchId: launch.id, toolId: tool.id, presetId: preset.id },
    "launch initiated",
  );

  // Compute installer download URL the same way the admin route serializes it.
  // The storage router serves "/objects/<x>" at "/api/storage/objects/<x>".
  let installerDownloadUrl: string | null = tool.installerUrl;
  if (!installerDownloadUrl && tool.installerObjectKey) {
    installerDownloadUrl = tool.installerObjectKey.startsWith("/objects/")
      ? `/api/storage/objects/${tool.installerObjectKey.slice("/objects/".length)}`
      : tool.installerObjectKey;
  }

  let launchUrl: string;
  if (tool.hostingType === "local_install") {
    // Substitute {token} into the admin-defined local-launch pattern. Falls
    // back to the regular launchUrl with ?token= when no pattern is set so
    // tools that haven't migrated keep working.
    const pattern = tool.localLaunchUrlPattern ?? tool.launchUrl;
    if (pattern.includes("{token}")) {
      launchUrl = pattern.replace(/\{token\}/g, encodeURIComponent(token));
    } else {
      const sep = pattern.includes("?") ? "&" : "?";
      launchUrl = `${pattern}${sep}token=${encodeURIComponent(token)}`;
    }
  } else {
    launchUrl = tool.launchUrl;
    if (launchUrl.startsWith("/")) {
      launchUrl = `${getOrigin(req)}${launchUrl}`;
    }
    const sep = launchUrl.includes("?") ? "&" : "?";
    launchUrl = `${launchUrl}${sep}token=${encodeURIComponent(token)}`;
  }

  res.json({
    launchId: launch.id,
    launchToken: token,
    launchUrl,
    expiresAt: expiresAt.toISOString(),
    sharedFieldKeys,
    sharedSnippetCount: sharedSnippets.length,
    hostingType: tool.hostingType,
    installerDownloadUrl,
    installerFilename: tool.installerFilename ?? null,
    installInstructions: tool.installInstructions ?? null,
  });
});

router.post("/tools/context-exchange", async (req, res) => {
  const parsed = ExchangeContextTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { launchToken } = parsed.data;

  // Atomically claim the token: only one concurrent request can win this UPDATE.
  // The WHERE guard ensures the token is unused and unexpired in the same SQL
  // statement that flips usedAt, so concurrent exchanges cannot both pass the
  // pre-check and both mint a session.
  const claimNow = new Date();
  const [tokenRow] = await db
    .update(launchTokensTable)
    .set({ usedAt: claimNow })
    .where(
      and(
        eq(launchTokensTable.token, launchToken),
        isNull(launchTokensTable.usedAt),
        gt(launchTokensTable.expiresAt, claimNow),
      ),
    )
    .returning();

  if (!tokenRow) {
    res.status(401).json({ error: "Invalid, used, or expired launch token" });
    return;
  }

  const [launch] = await db
    .select()
    .from(launchesTable)
    .where(eq(launchesTable.id, tokenRow.launchId))
    .limit(1);
  if (!launch) {
    res.status(401).json({ error: "Launch not found" });
    return;
  }

  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, launch.toolId))
    .limit(1);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, launch.userId))
    .limit(1);
  if (!tool || !user) {
    res.status(401).json({ error: "Launch context unavailable" });
    return;
  }

  // Resolve the active mission preset — its snapshot becomes the "profile"
  // the tool sees (so cross-mission contamination is prevented), and the
  // task-dependent Context Block lives in its own table and rides alongside
  // the snapshot profile. We then apply the user's preview-time redaction so
  // any field they excluded at preview is stripped from what's actually sent
  // to the tool. Snippets come from the launch row's audit-time snapshot, we
  // never re-run RAG here.
  const [ctx, contextBlock] = await Promise.all([
    getActiveContext(user.id),
    getOrCreateContextBlock(user.id),
  ]);
  const snapshotProfile = snapshotAsProfile(ctx.snapshot, ctx.profile);
  const sharedFieldKeys = launch.sharedFieldKeys ?? [];
  const redactedProfile = redactProfileForLaunch(
    snapshotProfile,
    sharedFieldKeys,
  );
  const snippets = launch.sharedSnippets ?? [];

  const now = new Date();
  const sessionToken = generateOpaqueToken();
  const sessionExpiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_MS);

  await db
    .update(launchesTable)
    .set({ status: "exchanged", exchangedAt: now })
    .where(eq(launchesTable.id, launch.id));

  await db.insert(sessionTokensTable).values({
    token: sessionToken,
    launchId: launch.id,
    userId: user.id,
    toolId: tool.id,
    expiresAt: sessionExpiresAt,
  });

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    user.id;

  const userPayload = {
    id: user.id,
    displayName,
    email: user.email,
  };

  res.json({
    sessionToken,
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    tool: {
      id: tool.id,
      slug: tool.slug,
      name: tool.name,
      vendor: tool.vendor,
      atoStatus: tool.atoStatus,
    },
    user: userPayload,
    // Profile is the redacted view (per the user's preview-time field
    // selections); contextBlock travels separately so the receiving tool
    // sees the {profile, contextBlock} envelope shape used everywhere else.
    profile: serializeProfile(redactedProfile, contextBlock, ctx.activePreset.id),
    contextBlock: serializeContextBlock(contextBlock),
    contextMarkdown: buildContextBlock(userPayload, redactedProfile, contextBlock),
    // Snippets are the user-approved set captured at preview time; queries
    // are intentionally empty here because we did not re-run RAG.
    primer: { queries: [], snippets },
    additionalNote: launch.additionalNote ?? null,
    sharedFieldKeys,
  });
});

router.post("/tools/library-query", async (req, res) => {
  const parsed = QueryLibraryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { sessionToken, query, limit } = parsed.data;

  const [sess] = await db
    .select()
    .from(sessionTokensTable)
    .where(eq(sessionTokensTable.token, sessionToken))
    .limit(1);
  if (!sess) {
    res.status(401).json({ error: "Invalid session token" });
    return;
  }
  if (sess.expiresAt.getTime() < Date.now()) {
    res.status(401).json({ error: "Session token expired" });
    return;
  }

  // Apply the same active-preset doc scope used at exchange time so a tool
  // can't reach outside the user's chosen mission scope mid-session.
  const ctx = await getActiveContext(sess.userId);

  const snippets = await searchChunks(
    sess.userId,
    query,
    Math.min(Math.max(limit ?? 6, 1), 20),
    { documentIds: ctx.documentIds },
  );

  res.json({ query, snippets });
});

router.post("/tools/draft-brief", async (req, res) => {
  const parsed = DraftBriefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { sessionToken, topic, briefType, audience } = parsed.data;

  const [sess] = await db
    .select()
    .from(sessionTokensTable)
    .where(eq(sessionTokensTable.token, sessionToken))
    .limit(1);
  if (!sess) {
    res.status(401).json({ error: "Invalid session token" });
    return;
  }
  if (sess.expiresAt.getTime() < Date.now()) {
    res.status(401).json({ error: "Session token expired" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, sess.userId))
    .limit(1);
  if (!user) {
    res.status(401).json({ error: "Launch user unavailable" });
    return;
  }

  const [profile, contextBlockRow] = await Promise.all([
    getOrCreateProfile(user.id),
    getOrCreateContextBlock(user.id),
  ]);

  const trimmedTopic = topic.trim();
  // Use the user's topic as the primary library query, plus a couple of
  // profile-derived fallbacks so a vague topic still surfaces unit-specific
  // material. The Context Block's commander's-intent line is a great
  // fallback when the topic itself is vague.
  const queries = [trimmedTopic];
  if (contextBlockRow?.intent) queries.push(contextBlockRow.intent);
  if (profile.dutyTitle && profile.unit) {
    queries.push(`${profile.unit} ${profile.dutyTitle}`);
  }

  const snippets = await searchChunksMultiQuery(user.id, queries, 3, 8);

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    user.id;

  const userPayload = {
    id: user.id,
    displayName,
    email: user.email,
  };

  const contextBlock = buildContextBlock(userPayload, profile, contextBlockRow);

  let draft: string;
  try {
    draft = await draftMissionBrief({
      topic: trimmedTopic,
      briefType: briefType as BriefType,
      audience: audience ?? null,
      profile,
      user: { displayName, email: user.email },
      contextBlock,
      snippets: snippets.map((s) => ({
        documentTitle: s.documentTitle,
        chunkIndex: s.chunkIndex,
        content: s.content,
      })),
    });
  } catch (err) {
    logger.error({ err }, "draftMissionBrief failed");
    res.status(500).json({ error: "Failed to draft brief" });
    return;
  }

  res.json({
    briefType,
    topic: trimmedTopic,
    draft,
    queries,
    snippets,
  });
});

router.get("/launches/recent", requireAuth, async (req, res) => {
  // Touch ensureActivePreset so brand-new accounts get a preset minted on
  // their first dashboard load; we don't actually use the result here.
  await getOrCreateProfile(req.user!.id);

  const rows = await db
    .select({
      id: launchesTable.id,
      toolId: launchesTable.toolId,
      toolName: toolsTable.name,
      toolSlug: toolsTable.slug,
      status: launchesTable.status,
      createdAt: launchesTable.createdAt,
      sharedFieldKeys: launchesTable.sharedFieldKeys,
      sharedSnippets: launchesTable.sharedSnippets,
      additionalNote: launchesTable.additionalNote,
    })
    .from(launchesTable)
    .innerJoin(toolsTable, eq(launchesTable.toolId, toolsTable.id))
    .where(eq(launchesTable.userId, req.user!.id))
    .orderBy(desc(launchesTable.createdAt))
    .limit(10);

  res.json(
    rows.map((r) => ({
      id: r.id,
      toolId: r.toolId,
      toolName: r.toolName,
      toolSlug: r.toolSlug,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      sharedFieldKeys: r.sharedFieldKeys ?? [],
      sharedSnippets: r.sharedSnippets ?? [],
      additionalNote: r.additionalNote ?? null,
    })),
  );
});

export default router;
