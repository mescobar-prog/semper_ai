import { Router, type IRouter } from "express";
import { eq, asc, desc } from "drizzle-orm";
import {
  db,
  profilesTable,
  contextBlocksTable,
  profileChatMessagesTable,
  launchAffirmationsTable,
} from "@workspace/db";
import {
  UpdateMyProfileBody,
  SendProfileChatBody,
  EvaluateContextBlockBody,
  ConfirmContextBlockBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  ensureActivePreset,
  getOrCreateProfile,
  getOrCreateContextBlock,
  serializeProfile,
  serializeContextBlock,
} from "../lib/profile-helpers";
import {
  evaluateContextBlock,
  runProfileChat,
} from "../lib/gemini-helpers";
import {
  ingestMosPackage,
  ingestUnitPackage,
  startIngestPackage,
} from "../lib/auto-ingest";
import {
  branchCode,
  hasUnitDoctrinePackage,
  findMosEntry,
  isValidCommandCode,
} from "@workspace/mil-data";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/profile", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  // Lazy-create the user's default mission preset on first read so that
  // the returned activePresetId is always populated.
  const [{ profile, preset }, contextBlock] = await Promise.all([
    ensureActivePreset(userId),
    getOrCreateContextBlock(userId),
  ]);
  res.json({
    profile: serializeProfile(profile, contextBlock, preset.id),
    contextBlock: serializeContextBlock(contextBlock),
  });
});

router.put("/profile", requireAuth, async (req, res) => {
  // `.strict()` rejects payloads that include any field not in the schema —
  // e.g. legacy `primaryMission` / `aiUseCases`, or typos like `bilets`.
  // Returning 400 instead of silently ignoring them prevents stale clients
  // from believing they wrote a value that we actually dropped.
  const parsed = UpdateMyProfileBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid profile data",
      issues: parsed.error.issues,
    });
    return;
  }

  const previous = await getOrCreateProfile(req.user!.id);

  const data = parsed.data;
  const update: Record<string, unknown> = {};
  for (const k of [
    "branch",
    "rank",
    "mosCode",
    "dutyTitle",
    "unit",
    "baseLocation",
    "securityClearance",
    "deploymentStatus",
    "freeFormContext",
  ] as const) {
    if (k in data) update[k] = data[k];
  }
  if ("command" in data) {
    const c = data.command;
    if (c == null || c === "") {
      update.command = null;
    } else if (typeof c === "string" && isValidCommandCode(c)) {
      update.command = c;
    } else {
      res.status(400).json({
        error: "invalid_command_code",
        message: `Unknown combatant command code: ${String(c)}`,
      });
      return;
    }
  }
  if (Array.isArray(data.billets)) {
    update.billets = data.billets
      .map((b) => (typeof b === "string" ? b.trim() : ""))
      .filter((b) => b.length > 0);
  }
  if (data.launchPreference === "preview" || data.launchPreference === "direct") {
    update.launchPreference = data.launchPreference;
  }

  // viewMode is admin presentation state. Only honor it for users whose
  // profile is actually flagged admin — non-admins quietly remain in
  // "admin" view (which is the default and contains no admin-only UI for
  // them anyway). This keeps the field from being a covert privilege
  // signal: server-side authorization always reads isAdmin, never viewMode.
  const rawForView = (req.body ?? {}) as Record<string, unknown>;
  if ("viewMode" in rawForView) {
    const v = rawForView.viewMode;
    if (
      previous.isAdmin === "true" &&
      (v === "admin" || v === "operator")
    ) {
      update.viewMode = v;
    }
  }

  // Allow the client to switch the active mission preset via PUT /profile in
  // addition to the dedicated /profile/presets/:id/activate endpoint. The
  // generated zod schema may not include this key yet; tolerate it being
  // present on the raw body.
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  if ("activePresetId" in rawBody) {
    const v = rawBody.activePresetId;
    if (v === null || typeof v === "string") {
      update.activePresetId = v;
    }
  }

  // Server-side branch+MOS validity enforcement. The catalog is the source of
  // truth: if a client (current UI, stale UI, or direct API call) tries to
  // persist a MOS that doesn't belong to the resolved branch, drop the MOS
  // rather than allow the cross-branch combination. We only enforce when both
  // branch and MOS are present in this update OR already on the row, so a
  // partial update touching only one field is still validated against the
  // effective post-write state.
  const effectiveBranch =
    "branch" in update ? (update.branch as string | null) : previous.branch;
  const effectiveMos =
    "mosCode" in update
      ? (update.mosCode as string | null)
      : previous.mosCode;
  if (effectiveBranch && effectiveMos) {
    const bc = branchCode(effectiveBranch);
    if (!bc || !findMosEntry(bc, effectiveMos)) {
      update.mosCode = null;
    }
  }

  // If this PUT switches the active preset, the profile update and the
  // affirmation invalidation must be atomic — otherwise there's a window
  // where the new preset is in effect but a stale affirmation still
  // satisfies the launch gate. Wrap both writes in a single transaction
  // when we know the preset is changing; fall back to a single update in
  // the common case (preset unchanged) to keep the simple path lean.
  const presetChanging =
    "activePresetId" in update &&
    update.activePresetId !== previous.activePresetId;

  const updated = presetChanging
    ? await db.transaction(async (tx) => {
        const [row] = await tx
          .update(profilesTable)
          .set(update)
          .where(eq(profilesTable.userId, req.user!.id))
          .returning();
        await tx
          .delete(launchAffirmationsTable)
          .where(eq(launchAffirmationsTable.userId, req.user!.id));
        return row;
      })
    : (
        await db
          .update(profilesTable)
          .set(update)
          .where(eq(profilesTable.userId, req.user!.id))
          .returning()
      )[0];

  // Auto-ingest curated doctrine when the user picks a new branch+MOS or
  // changes their unit to one we have a curated package for. We compare the
  // *resolved* branch+MOS pair so that re-ordering branch and MOS edits
  // doesn't trigger duplicate fetches.
  const userId = req.user!.id;
  const prevBranchCode = branchCode(previous.branch);
  const newBranchCode = branchCode(updated.branch);
  const prevMosKey = prevBranchCode && previous.mosCode
    ? `${prevBranchCode}:${previous.mosCode.trim().toUpperCase()}`
    : null;
  const newMosKey = newBranchCode && updated.mosCode
    ? `${newBranchCode}:${updated.mosCode.trim().toUpperCase()}`
    : null;
  if (
    newBranchCode &&
    updated.mosCode &&
    newMosKey !== prevMosKey &&
    findMosEntry(newBranchCode, updated.mosCode)
  ) {
    startIngestPackage(
      () => ingestMosPackage(userId, updated.branch, updated.mosCode),
      { userId, source: `mos:${newMosKey}` },
    );
  }

  const prevUnitKey = prevBranchCode && previous.unit
    ? `${prevBranchCode}:${previous.unit.trim()}`
    : null;
  const newUnitKey = newBranchCode && updated.unit
    ? `${newBranchCode}:${updated.unit.trim()}`
    : null;
  if (
    newBranchCode &&
    updated.unit &&
    newUnitKey !== prevUnitKey &&
    hasUnitDoctrinePackage(newBranchCode, updated.unit)
  ) {
    startIngestPackage(
      () => ingestUnitPackage(userId, updated.branch, updated.unit),
      { userId, source: `unit:${newUnitKey}` },
    );
  }

  const contextBlock = await getOrCreateContextBlock(userId);
  res.json({
    profile: serializeProfile(updated, contextBlock, updated.activePresetId),
    contextBlock: serializeContextBlock(contextBlock),
  });
});

router.get("/profile/chat", requireAuth, async (req, res) => {
  const messages = await db
    .select()
    .from(profileChatMessagesTable)
    .where(eq(profileChatMessagesTable.userId, req.user!.id))
    .orderBy(asc(profileChatMessagesTable.createdAt));

  res.json(
    messages.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  );
});

router.post("/profile/chat", requireAuth, async (req, res) => {
  const parsed = SendProfileChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid message" });
    return;
  }
  const { message } = parsed.data;
  const userId = req.user!.id;

  await db
    .insert(profileChatMessagesTable)
    .values({ userId, role: "user", content: message });

  const profile = await getOrCreateProfile(userId);
  const history = await db
    .select()
    .from(profileChatMessagesTable)
    .where(eq(profileChatMessagesTable.userId, userId))
    .orderBy(asc(profileChatMessagesTable.createdAt))
    .limit(40);

  let result;
  try {
    result = await runProfileChat(
      history.map((h) => ({
        role: h.role as "user" | "assistant",
        content: h.content,
      })),
      profile,
    );
  } catch (err) {
    logger.error({ err }, "profile chat failed");
    res.status(500).json({ error: "Assistant temporarily unavailable" });
    return;
  }

  await db
    .insert(profileChatMessagesTable)
    .values({ userId, role: "assistant", content: result.reply });

  res.json({
    reply: result.reply,
    suggestedProfile: result.suggestedProfile,
  });
});

router.post("/profile/chat/reset", requireAuth, async (req, res) => {
  await db
    .delete(profileChatMessagesTable)
    .where(eq(profileChatMessagesTable.userId, req.user!.id));
  res.json({ success: true });
});

// ----- 6-element Context Block verification gate ---------------------------

router.post("/profile/context-block/evaluate", requireAuth, async (req, res) => {
  const parsed = EvaluateContextBlockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Context Block submission" });
    return;
  }
  try {
    const evaluation = await evaluateContextBlock(parsed.data);
    res.json(evaluation);
  } catch (err) {
    logger.error({ err }, "Context Block evaluator failed");
    res.status(500).json({ error: "Context Block evaluator unavailable" });
  }
});

router.post("/profile/context-block/confirm", requireAuth, async (req, res) => {
  const parsed = ConfirmContextBlockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Context Block submission" });
    return;
  }
  const userId = req.user!.id;
  // Make sure a profile row exists (the upsert path doesn't insert one).
  await getOrCreateProfile(userId);

  let evaluation;
  try {
    evaluation = await evaluateContextBlock(parsed.data);
  } catch (err) {
    logger.error({ err }, "Context Block evaluator failed during confirm");
    res.status(500).json({ error: "Context Block evaluator unavailable" });
    return;
  }

  // Server-side enforcement (Task #99):
  //   - OPSEC violations are *always* a hard reject — `bypass: true` is
  //     ignored.
  //   - Sub-threshold scores (totalScore < 10 with no OPSEC flag) are
  //     normally rejected, but `bypass: true` allows the operator to
  //     confirm anyway and the row is persisted with `bypassed = true`.
  //     The condition is keyed explicitly to `totalScore < 10` (not just
  //     status !== "GO") so that any future evaluator status that isn't
  //     about the score (e.g. an OPSEC-only NO-GO) cannot be silently
  //     bypassed via this path.
  //   - In-threshold (GO) confirms always clear the bypass flag so the row
  //     reflects the latest assurance level.
  const bypassRequested = parsed.data.bypass === true;
  const isGo = evaluation.status === "GO" && !evaluation.opsecFlag;
  const isSubThreshold = evaluation.totalScore < 10;
  const allowSubThresholdBypass =
    !isGo && isSubThreshold && bypassRequested && !evaluation.opsecFlag;

  if (!isGo && !allowSubThresholdBypass) {
    res.status(422).json({
      error:
        evaluation.opsecFlag
          ? "Context Block tripped the OPSEC fail-safe. Edit the block and re-evaluate before confirming."
          : `Context Block scored ${evaluation.totalScore}/12 — the GO threshold is 10/12. Edit the block and re-evaluate before confirming.`,
      evaluation,
    });
    return;
  }

  // Make sure a context_blocks row exists, then upsert. Bump the monotonic
  // `version` on every confirm — Task #45's launch-time affirmation gate
  // pairs (user, preset, this version) so any edit / re-confirm
  // automatically invalidates a still-cached affirmation.
  const existingCb = await getOrCreateContextBlock(userId);

  const now = new Date();
  const [updatedCb] = await db
    .update(contextBlocksTable)
    .set({
      doctrine: parsed.data.doctrine,
      intent: parsed.data.intent,
      environment: parsed.data.environment,
      constraints: parsed.data.constraints,
      risk: parsed.data.risk,
      experience: parsed.data.experience,
      confirmedAt: now,
      scoreTotal: evaluation.totalScore,
      scores: evaluation.scores,
      status: evaluation.status,
      flags: evaluation.flags,
      submissionId: evaluation.submissionId,
      opsecFlag: evaluation.opsecFlag ? "true" : "false",
      bypassed: allowSubThresholdBypass ? "true" : "false",
      version: (existingCb.version ?? 1) + 1,
      updatedAt: now,
    })
    .where(eq(contextBlocksTable.userId, userId))
    .returning();

  const profile = await getOrCreateProfile(userId);

  res.json({
    profile: serializeProfile(profile, updatedCb, profile.activePresetId),
    contextBlock: serializeContextBlock(updatedCb),
    evaluation,
  });
});

export default router;
