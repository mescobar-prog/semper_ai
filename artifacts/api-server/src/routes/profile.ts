import { Router, type IRouter } from "express";
import { eq, asc, desc } from "drizzle-orm";
import {
  db,
  profilesTable,
  profileChatMessagesTable,
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
  serializeProfile,
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
import { branchCode, hasUnitDoctrinePackage, findMosEntry } from "@workspace/mil-data";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/profile", requireAuth, async (req, res) => {
  // Lazy-create the user's default mission preset on first read so that
  // the returned activePresetId is always populated.
  const { profile, preset } = await ensureActivePreset(req.user!.id);
  res.json(serializeProfile(profile, preset.id));
});

router.put("/profile", requireAuth, async (req, res) => {
  const parsed = UpdateMyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid profile data" });
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
    "primaryMission",
    "freeFormContext",
  ] as const) {
    if (k in data) update[k] = data[k];
  }
  if (Array.isArray(data.aiUseCases)) update.aiUseCases = data.aiUseCases;
  if (data.launchPreference === "preview" || data.launchPreference === "direct") {
    update.launchPreference = data.launchPreference;
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

  const [updated] = await db
    .update(profilesTable)
    .set(update)
    .where(eq(profilesTable.userId, req.user!.id))
    .returning();

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

  res.json(serializeProfile(updated, updated.activePresetId));
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

  // Server-side enforcement: NO-GO submissions are rejected outright. The
  // operator must edit and re-submit. We still return the evaluation so the
  // UI can render the failing scores / OPSEC flag.
  if (evaluation.status !== "GO") {
    res.status(422).json({
      error:
        evaluation.opsecFlag
          ? "Context Block tripped the OPSEC fail-safe. Edit the block and re-evaluate before confirming."
          : `Context Block scored ${evaluation.totalScore}/12 — the GO threshold is 10/12. Edit the block and re-evaluate before confirming.`,
      evaluation,
    });
    return;
  }

  const now = new Date();
  const [updated] = await db
    .update(profilesTable)
    .set({
      cbDoctrine: parsed.data.doctrine,
      cbIntent: parsed.data.intent,
      cbEnvironment: parsed.data.environment,
      cbConstraints: parsed.data.constraints,
      cbRisk: parsed.data.risk,
      cbExperience: parsed.data.experience,
      cbConfirmedAt: now,
      cbScoreTotal: evaluation.totalScore,
      cbScores: evaluation.scores,
      cbStatus: evaluation.status,
      cbFlags: evaluation.flags,
      cbSubmissionId: evaluation.submissionId,
      cbOpsecFlag: evaluation.opsecFlag ? "true" : "false",
    })
    .where(eq(profilesTable.userId, userId))
    .returning();

  res.json({
    profile: serializeProfile(updated, updated.activePresetId),
    evaluation,
  });
});

export default router;
