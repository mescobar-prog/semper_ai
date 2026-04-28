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

  await getOrCreateProfile(req.user!.id);

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

  const [updated] = await db
    .update(profilesTable)
    .set(update)
    .where(eq(profilesTable.userId, req.user!.id))
    .returning();

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
