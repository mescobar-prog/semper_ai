import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  toolsTable,
  launchesTable,
  launchTokensTable,
  launchAffirmationsTable,
  presetDocumentsTable,
  sessionTokensTable,
  usersTable,
  docChunksTable,
  documentsTable,
  type LaunchAffirmation,
  type LaunchSharedSnippet,
} from "@workspace/db";
import {
  CreateLaunchAffirmationBody,
  DraftBriefBody,
  ExchangeContextTokenBody,
  LaunchToolBody,
  PreviewLaunchContextBody,
  QueryLibraryBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { generateOpaqueToken } from "../lib/tokens";
import {
  draftMissionBrief,
  generateRagQueries,
  type BriefType,
  type ContextBlockSituation,
} from "../lib/gemini-helpers";
import { searchChunks, searchChunksMultiQuery } from "../lib/rag";
import {
  buildContextBlock,
  ensureActivePreset,
  getActiveContext,
  getOrCreateContextBlock,
  getOrCreateProfile,
  hasConfirmedContextBlock,
  parseSelectedDoctrineDocIds,
  serializeContextBlock,
  serializePreset,
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
// Launch-time affirmation TTL (Task #45). Within this window the operator
// can launch any tool that uses the same active preset + context-block
// version without re-affirming; outside it the modal pops again.
const LAUNCH_AFFIRMATION_TTL_MS = 30 * 60 * 1000;

function serializeAffirmation(row: LaunchAffirmation) {
  return {
    presetId: row.presetId,
    contextBlockVersion: row.contextBlockVersion,
    affirmedAt: row.affirmedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

async function loadValidAffirmation(
  userId: string,
  presetId: string,
  contextBlockVersion: number,
  now: Date,
): Promise<LaunchAffirmation | null> {
  const [row] = await db
    .select()
    .from(launchAffirmationsTable)
    .where(eq(launchAffirmationsTable.userId, userId))
    .limit(1);
  if (!row) return null;
  if (row.presetId !== presetId) return null;
  if (row.contextBlockVersion !== contextBlockVersion) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

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

// ----- Launch-time RAG plumbing (Tasks #88, #106) -----------------------
// Doctrine-scoped RAG used by both /launch-preview and /launch so the
// preview the operator sees and the snippets we actually persist stay
// in lockstep.
//
// Task #106: query generation is now driven off the operator's profile,
// the last five Context Block elements (Doctrine & Orders excluded),
// and the operator's free-form "Additional detail" text. Retrieval
// returns up to LAUNCH_RAG_PER_DOC_CAP chunks per scoped document so
// the operator can review/redact a balanced sample from each doctrine
// doc they ticked, instead of one chatty doc dominating the list.
const LAUNCH_RAG_MIN_SCORE = 0.15;
const LAUNCH_RAG_PER_DOC_CAP = 5;

interface LaunchRagScope {
  /** Doc IDs we'll actually search over (post intersection / fallback). */
  scopedDocumentIds: string[];
  /** Doc IDs the operator explicitly ticked in the Context Block. */
  selectedDoctrineDocIds: string[];
  /**
   * True when the search was narrowed to the operator's selected
   * doctrine; false when no doctrine was ticked (or the intersection
   * with the preset's docs was empty) and we fell back to the whole
   * preset scope. Surfaced in the preview so operators understand
   * what just drove their results.
   */
  scopedToSelectedDoctrine: boolean;
}

function resolveLaunchRagScope(
  contextBlockDoctrine: string | null,
  presetDocs: readonly { id: string; title: string }[],
): LaunchRagScope {
  // The doctrine textarea stores ticks as `- <doc title>` reference
  // lines (the marketplace owns the textarea — see Catalog.tsx).
  // parseSelectedDoctrineDocIds matches those titles back to ids
  // against the operator's preset docs, so a title collision in some
  // unrelated library doc can't slip a wrong id into the scope here.
  const presetDocumentIds = presetDocs.map((d) => d.id);
  const selected = parseSelectedDoctrineDocIds(contextBlockDoctrine, presetDocs);
  if (selected.length === 0) {
    return {
      scopedDocumentIds: presetDocumentIds,
      selectedDoctrineDocIds: [],
      scopedToSelectedDoctrine: false,
    };
  }
  // Because we already restricted the title→id lookup to preset
  // docs, `selected` is by construction a subset of preset doc ids.
  // The legacy intersection step below is kept as a defensive
  // no-op in case a future change widens the lookup.
  const presetSet = new Set(presetDocumentIds);
  const intersection = selected.filter((id) => presetSet.has(id));
  if (intersection.length === 0) {
    return {
      scopedDocumentIds: presetDocumentIds,
      selectedDoctrineDocIds: selected,
      scopedToSelectedDoctrine: false,
    };
  }
  return {
    scopedDocumentIds: intersection,
    selectedDoctrineDocIds: selected,
    scopedToSelectedDoctrine: true,
  };
}

/**
 * Load (id, title) for the operator's active preset documents.
 * Needed by resolveLaunchRagScope so it can match the doctrine
 * textarea's `- <title>` reference lines back to doc ids without
 * letting a title from outside the active preset slip into the
 * scope.
 */
async function loadPresetDocLookup(
  presetDocumentIds: string[],
): Promise<{ id: string; title: string }[]> {
  if (presetDocumentIds.length === 0) return [];
  const rows = await db
    .select({ id: documentsTable.id, title: documentsTable.title })
    .from(documentsTable)
    .where(inArray(documentsTable.id, presetDocumentIds));
  return rows;
}

interface RunLaunchRagInput {
  userId: string;
  tool: {
    name: string;
    vendor: string;
    shortDescription: string;
    longDescription: string;
    purpose: string | null;
    ragQueryTemplates: string[] | null;
  };
  snapshotProfile: ReturnType<typeof snapshotAsProfile>;
  scope: LaunchRagScope;
  /**
   * Operator's free-form "Additional detail" text for this launch
   * (Task #106). Mixed with the Context Block elements as a primary
   * input to the query generator.
   */
  additionalDetail: string | null;
  /**
   * Last five Context Block elements (Doctrine & Orders excluded —
   * that's the corpus we're searching, not a query input). Drives the
   * query generator's understanding of the operator's mission
   * situation.
   */
  contextElements: ContextBlockSituation;
}

interface RunLaunchRagResult {
  queries: string[];
  snippets: Awaited<ReturnType<typeof searchChunksMultiQuery>>;
}

async function runLaunchRag(
  input: RunLaunchRagInput,
): Promise<RunLaunchRagResult> {
  const {
    userId,
    tool,
    snapshotProfile,
    scope,
    additionalDetail,
    contextElements,
  } = input;
  const queries = await generateRagQueries(
    snapshotProfile,
    {
      name: tool.name,
      vendor: tool.vendor,
      shortDescription: tool.shortDescription,
      longDescription: tool.longDescription,
      // RagToolDescriptor declares these optional (string | undefined),
      // but the toolsTable serializes purpose / ragQueryTemplates as
      // nullable. Coerce so we don't accidentally pass through `null`,
      // which the descriptor's downstream profile interpolation doesn't
      // expect.
      purpose: tool.purpose ?? undefined,
      ragQueryTemplates: tool.ragQueryTemplates ?? undefined,
    },
    { additionalDetail, contextElements },
  );

  // Task #106: TRUE per-document top-K retrieval. Loop each scoped doc
  // and run the full multi-query search restricted to that single doc,
  // capping at LAUNCH_RAG_PER_DOC_CAP snippets *per doc*. This
  // guarantees every selected doctrine doc gets its own top-5 ranking
  // and a strong-hitting doc cannot starve sibling docs out of the
  // candidate set (the previous global-then-cap approach allowed
  // exactly that). Per-doc results are independent, so we run the
  // doc-scoped searches in parallel.
  //
  // When the scope is empty (operator hasn't built a preset / no
  // doctrine resolves), `scopedDocumentIds` is empty — there's
  // nothing to search and we return an empty list rather than
  // searching the whole user library, matching prior behavior.
  const docResults = await Promise.all(
    scope.scopedDocumentIds.map((docId) =>
      searchChunksMultiQuery(
        userId,
        queries,
        LAUNCH_RAG_PER_DOC_CAP,
        LAUNCH_RAG_PER_DOC_CAP,
        {
          documentIds: [docId],
          minScore: LAUNCH_RAG_MIN_SCORE,
        },
      ),
    ),
  );

  // Concatenate so each doc's top-K stays grouped, but order docs by
  // their strongest snippet's score so the most-relevant doc's chunks
  // appear first in the operator's review list. This preserves the
  // "best hits first" UX without trading away per-doc fairness.
  const docOrdered = docResults
    .map((hits) => ({
      hits,
      bestScore: hits.length > 0 ? hits[0].score : -Infinity,
    }))
    .sort((a, b) => b.bestScore - a.bestScore);

  const selectedDocSet = new Set(scope.selectedDoctrineDocIds);
  const snippets = docOrdered
    .flatMap(({ hits }) => hits)
    .map((s) => ({
      ...s,
      fromSelectedDoctrine: selectedDocSet.has(s.documentId),
    }));
  return { queries, snippets };
}

/**
 * Pull the five non-doctrine Context Block elements off the
 * persistent CB row in the shape the launch-time RAG generator
 * expects. Doctrine & Orders is intentionally excluded — it tells us
 * which docs to search, not what to search for.
 */
function pickContextBlockSituation(
  cb: { intent: string | null; environment: string | null;
        constraints: string | null; risk: string | null;
        experience: string | null } | null,
): ContextBlockSituation {
  if (!cb) {
    return { intent: null, environment: null, constraints: null, risk: null, experience: null };
  }
  return {
    intent: cb.intent,
    environment: cb.environment,
    constraints: cb.constraints,
    risk: cb.risk,
    experience: cb.experience,
  };
}

// POST /tools/:toolId/launch-preview
// Returns the candidate context bundle (profile fields + RAG snippets) the
// user is about to send, *without* minting a launch token. The marketplace
// frontend uses this to render the pre-launch preview / redaction panel.
//
// Optional body: { additionalDetail?: string | null } — the operator's
// free-form note from the consolidated bottom-of-dialog box (Task #106).
// When present it's mixed with the operator's profile and the last five
// Context Block elements as the input to the RAG query generator. The
// frontend debounces this so we only re-run the search once the
// operator pauses typing.
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

  // Validate additionalDetail off the body. Body is optional —
  // auto-launch / direct-launch flows POST {} and expect a baseline
  // CB-and-profile-led preview — so we pass an empty object through
  // the schema when the body is missing.
  const previewBody = PreviewLaunchContextBody.safeParse(req.body ?? {});
  if (!previewBody.success) {
    res.status(400).json({ error: "Invalid launch preview body" });
    return;
  }
  const rawDetail = previewBody.data.additionalDetail ?? null;
  const additionalDetail =
    rawDetail && rawDetail.trim() ? rawDetail.trim() : null;

  // Resolve the user's active mission preset; the snapshot drives identity
  // for the preview (so the candidate list reflects what would actually be
  // sent on launch), and the preset's document set scopes RAG so the user
  // doesn't see snippets from outside their chosen mission scope.
  const [ctx, contextBlockRow] = await Promise.all([
    getActiveContext(req.user!.id),
    getOrCreateContextBlock(req.user!.id),
  ]);
  const snapshotProfile = snapshotAsProfile(ctx.snapshot, ctx.profile);
  const presetDocLookup = await loadPresetDocLookup(ctx.documentIds);
  const scope = resolveLaunchRagScope(
    contextBlockRow.doctrine,
    presetDocLookup,
  );
  const contextElements = pickContextBlockSituation(contextBlockRow);

  let queries: string[] = [];
  let snippets: Awaited<ReturnType<typeof searchChunksMultiQuery>> = [];
  try {
    const result = await runLaunchRag({
      userId: req.user!.id,
      tool,
      snapshotProfile,
      scope,
      additionalDetail,
      contextElements,
    });
    queries = result.queries;
    snippets = result.snippets;
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
    // Task #106: echo the trimmed Additional detail back so the UI can
    // confirm the search ran against what the operator currently sees
    // in the input.
    additionalDetail,
    // Task #88: tell the UI which doctrine the operator's CB ticked and
    // whether the search was actually narrowed to it (vs falling back
    // to the whole preset because nothing was ticked or the
    // intersection was empty).
    selectedDoctrineDocIds: scope.selectedDoctrineDocIds,
    scopedToSelectedDoctrine: scope.scopedToSelectedDoctrine,
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
  const {
    selectedFieldKeys,
    selectedSnippetIds,
    additionalDetail: rawAdditionalDetail,
  } = parsed.data;
  // Task #106: the consolidated "Additional detail" box replaces both
  // the old separate intent box and the old "additional context" note.
  // We trim and persist into the existing `additionalNote` column so we
  // don't need a schema migration; the legacy `launchIntent` column is
  // left null on new launches and treated as read-only legacy data.
  const additionalDetail =
    typeof rawAdditionalDetail === "string" && rawAdditionalDetail.trim().length > 0
      ? rawAdditionalDetail.trim()
      : null;

  // Ensure an active preset exists and use its snapshot as the profile basis;
  // RAG is scoped to the preset's documents so launches stay within mission.
  const ctx = await getActiveContext(req.user!.id);
  const snapshotProfile = snapshotAsProfile(ctx.snapshot, ctx.profile);
  const preset = ctx.activePreset;

  // ----- Launch-time affirmation gate (Task #45) ------------------------
  // We refuse to mint a token unless the user has a valid, unexpired
  // affirmation for (active preset, current context-block version). The
  // marketplace pre-checks via GET /launches/affirmation so this almost
  // always passes silently; a 409 here means a stale client tried to skip
  // the modal (or the affirmation expired between the pre-check and the
  // POST). Either way the response carries everything the modal needs to
  // render without a follow-up round trip.
  const contextBlockRow = await getOrCreateContextBlock(req.user!.id);
  const cbVersion = contextBlockRow.version ?? 1;
  // Compute the doctrine scope once — used for RAG selection (when the
  // client didn't send selectedSnippetIds) and for badging the persisted
  // snippets (so the audit row records which hits came from selected
  // doctrine vs the preset fallback).
  const presetDocLookup = await loadPresetDocLookup(ctx.documentIds);
  const ragScope = resolveLaunchRagScope(
    contextBlockRow.doctrine,
    presetDocLookup,
  );
  const selectedDoctrineSet = new Set(ragScope.selectedDoctrineDocIds);
  const gateNow = new Date();
  const validAffirmation = await loadValidAffirmation(
    req.user!.id,
    preset.id,
    cbVersion,
    gateNow,
  );
  if (!validAffirmation) {
    const presetDocIds = await db
      .select({ id: presetDocumentsTable.documentId })
      .from(presetDocumentsTable)
      .where(eq(presetDocumentsTable.presetId, preset.id));
    res.status(409).json({
      error:
        "Confirm your active preset's context block before launching this tool.",
      code: "needs_affirmation",
      presetId: preset.id,
      contextBlockVersion: cbVersion,
      preset: serializePreset(
        preset,
        presetDocIds.map((r) => r.id),
        true,
      ),
      contextBlock: serializeContextBlock(contextBlockRow),
    });
    return;
  }

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
  //
  // Task #106: when the client sent additionalDetail with
  // selectedSnippetIds=null, we use the same CB-and-detail-led,
  // doctrine-scoped RAG path as the preview so the operator gets back
  // exactly what they were shown.
  let sharedSnippets: LaunchSharedSnippet[] = [];
  try {
    if (selectedSnippetIds == null) {
      const result = await runLaunchRag({
        userId: req.user!.id,
        tool,
        snapshotProfile,
        scope: ragScope,
        additionalDetail,
        contextElements: pickContextBlockSituation(contextBlockRow),
      });
      sharedSnippets = result.snippets;
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
          fromSelectedDoctrine: selectedDoctrineSet.has(r.documentId),
        }));
    }
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve launch snippets; proceeding with what we have",
    );
  }

  // Persist the affirmation context on the launch row so audits can prove
  // the operator confirmed their preset's CB version at this exact launch.
  //
  // Task #106: the consolidated "Additional detail" text is stored on
  // the existing `additionalNote` column to avoid a schema migration.
  // The legacy `launchIntent` column is left null on new launches and
  // is treated as read-only legacy data (older audit rows may still
  // surface it to historians).
  const [launch] = await db
    .insert(launchesTable)
    .values({
      userId: req.user!.id,
      toolId: tool.id,
      status: "token_issued",
      sharedFieldKeys,
      sharedSnippets,
      additionalNote: additionalDetail,
      launchIntent: null,
      presetId: preset.id,
      contextBlockVersion: cbVersion,
      affirmedAt: validAffirmation.affirmedAt,
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

// ----- Launch-time affirmation endpoints (Task #45) ---------------------
// Reads the user's current affirmation alongside the active preset id and
// the live context-block version. The marketplace uses the comparison to
// decide whether to launch directly or open the affirmation modal; we
// return both halves in one call so the dashboard never has to stitch
// data from /profile and /launches/affirmation just to render its
// "preset confirmed for this session" indicator.
router.get("/launches/affirmation", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const ctx = await getActiveContext(userId);
  const cb = await getOrCreateContextBlock(userId);
  const cbVersion = cb.version ?? 1;
  const now = new Date();
  const valid = await loadValidAffirmation(
    userId,
    ctx.activePreset.id,
    cbVersion,
    now,
  );
  res.json({
    affirmation: valid ? serializeAffirmation(valid) : null,
    presetId: ctx.activePreset.id,
    contextBlockVersion: cbVersion,
  });
});

router.post("/launches/affirm", requireAuth, async (req, res) => {
  const parsed = CreateLaunchAffirmationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const userId = req.user!.id;
  const ctx = await getActiveContext(userId);
  const preset = ctx.activePreset;
  const cb = await getOrCreateContextBlock(userId);
  const cbVersion = cb.version ?? 1;

  // Reject stale clicks — e.g. the user opened the modal, edited their
  // context block in another tab, then submitted the old version. We
  // return the same 409 shape as the launch gate so the modal can
  // re-render against fresh data without special-casing the response.
  if (
    parsed.data.presetId !== preset.id ||
    parsed.data.contextBlockVersion !== cbVersion
  ) {
    const presetDocIds = await db
      .select({ id: presetDocumentsTable.documentId })
      .from(presetDocumentsTable)
      .where(eq(presetDocumentsTable.presetId, preset.id));
    res.status(409).json({
      error:
        "Your active preset or context block changed. Re-confirm to continue.",
      code: "needs_affirmation",
      presetId: preset.id,
      contextBlockVersion: cbVersion,
      preset: serializePreset(
        preset,
        presetDocIds.map((r) => r.id),
        true,
      ),
      contextBlock: serializeContextBlock(cb),
    });
    return;
  }

  // Upsert by userId — a single active affirmation per operator is enough,
  // and replacing keeps the table append-light. Switching preset deletes
  // the row entirely (see routes/presets.ts /activate handler), and a CB
  // version bump invalidates by mismatch on the next gate check.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LAUNCH_AFFIRMATION_TTL_MS);
  const [row] = await db
    .insert(launchAffirmationsTable)
    .values({
      userId,
      presetId: preset.id,
      contextBlockVersion: cbVersion,
      affirmedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: launchAffirmationsTable.userId,
      set: {
        presetId: preset.id,
        contextBlockVersion: cbVersion,
        affirmedAt: now,
        expiresAt,
      },
    })
    .returning();
  logger.info(
    {
      userId,
      presetId: preset.id,
      cbVersion,
      expiresAt: expiresAt.toISOString(),
    },
    "launch affirmation created",
  );
  res.json(serializeAffirmation(row));
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
    // Task #88: surface the operator's launch-time intent to the
    // receiving tool so it can lead its UX with the operator's question
    // (e.g. brief-drafter pre-filling the topic field, or a chat tool
    // pre-populating its first user turn).
    launchIntent: launch.launchIntent ?? null,
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
      launchIntent: launchesTable.launchIntent,
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
      launchIntent: r.launchIntent ?? null,
    })),
  );
});

export default router;
