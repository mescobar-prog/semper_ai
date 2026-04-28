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
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  getOrCreateProfile,
  serializeProfile,
} from "../lib/profile-helpers";
import { runProfileChat } from "../lib/gemini-helpers";
import {
  ingestMosPackage,
  ingestUnitPackage,
  startIngestPackage,
} from "../lib/auto-ingest";
import { branchCode, hasUnitDoctrinePackage, findMosEntry } from "@workspace/mil-data";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/profile", requireAuth, async (req, res) => {
  const profile = await getOrCreateProfile(req.user!.id);
  res.json(serializeProfile(profile));
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

  res.json(serializeProfile(updated));
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

export default router;
