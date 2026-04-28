import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  presetsTable,
  presetDocumentsTable,
  documentsTable,
  profilesTable,
} from "@workspace/db";
import {
  CreateMyPresetBody,
  UpdateMyPresetBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  ensureActivePreset,
  getOrCreateProfile,
  serializePreset,
  snapshotFromProfile,
  emptySnapshot,
} from "../lib/profile-helpers";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Confine candidate document ids to the user's own library so a malicious
// client can't cross-link another user's docs into their own preset.
async function filterOwnedDocIds(
  userId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const unique = Array.from(new Set(ids));
  const owned = await db
    .select({ id: documentsTable.id })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.userId, userId),
        inArray(documentsTable.id, unique),
      ),
    );
  return owned.map((r) => r.id);
}

async function loadDocLinks(presetId: string): Promise<string[]> {
  const rows = await db
    .select({ id: presetDocumentsTable.documentId })
    .from(presetDocumentsTable)
    .where(eq(presetDocumentsTable.presetId, presetId));
  return rows.map((r) => r.id);
}

router.get("/profile/presets", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  // ensureActivePreset both backfills and returns the active preset, so by
  // the time we list, the user is guaranteed to have one.
  const { profile } = await ensureActivePreset(userId);

  const presets = await db
    .select()
    .from(presetsTable)
    .where(eq(presetsTable.userId, userId))
    .orderBy(asc(presetsTable.createdAt));

  const docRows = await db
    .select({
      presetId: presetDocumentsTable.presetId,
      documentId: presetDocumentsTable.documentId,
    })
    .from(presetDocumentsTable)
    .innerJoin(presetsTable, eq(presetsTable.id, presetDocumentsTable.presetId))
    .where(eq(presetsTable.userId, userId));

  const byPreset = new Map<string, string[]>();
  for (const r of docRows) {
    const arr = byPreset.get(r.presetId) ?? [];
    arr.push(r.documentId);
    byPreset.set(r.presetId, arr);
  }

  res.json(
    presets.map((p) =>
      serializePreset(
        p,
        byPreset.get(p.id) ?? [],
        profile.activePresetId === p.id,
      ),
    ),
  );
});

router.post("/profile/presets", requireAuth, async (req, res) => {
  const parsed = CreateMyPresetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid preset" });
    return;
  }
  const userId = req.user!.id;
  const data = parsed.data;

  // Default snapshot = the user's current live profile, so "create from
  // current state" is the no-args path.
  const profile = await getOrCreateProfile(userId);
  const snapshot =
    data.profileSnapshot ?? snapshotFromProfile(profile);

  const docIds = await filterOwnedDocIds(userId, data.documentIds ?? []);

  let created;
  try {
    [created] = await db
      .insert(presetsTable)
      .values({
        userId,
        name: data.name.trim(),
        description: data.description ?? null,
        profileSnapshot: snapshot,
      })
      .returning();
  } catch (err) {
    logger.warn({ err }, "preset insert failed (likely duplicate name)");
    res.status(400).json({ error: "A preset with that name already exists" });
    return;
  }

  if (docIds.length > 0) {
    await db
      .insert(presetDocumentsTable)
      .values(docIds.map((id) => ({ presetId: created.id, documentId: id })));
  }

  let isActive = false;
  if (data.activate) {
    await db
      .update(profilesTable)
      .set({ activePresetId: created.id })
      .where(eq(profilesTable.userId, userId));
    isActive = true;
  } else {
    // If the user had no active preset yet (newly minted account), make this
    // one active automatically.
    if (!profile.activePresetId) {
      await db
        .update(profilesTable)
        .set({ activePresetId: created.id })
        .where(eq(profilesTable.userId, userId));
      isActive = true;
    }
  }

  res.json(serializePreset(created, docIds, isActive));
});

router.put("/profile/presets/:id", requireAuth, async (req, res) => {
  const parsed = UpdateMyPresetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid preset update" });
    return;
  }
  const userId = req.user!.id;
  const id = String(req.params.id);

  const [existing] = await db
    .select()
    .from(presetsTable)
    .where(and(eq(presetsTable.id, id), eq(presetsTable.userId, userId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
  if ("description" in parsed.data) update.description = parsed.data.description;
  if (parsed.data.profileSnapshot !== undefined) {
    update.profileSnapshot = parsed.data.profileSnapshot ?? emptySnapshot();
  }

  let updated = existing;
  if (Object.keys(update).length > 0) {
    try {
      [updated] = await db
        .update(presetsTable)
        .set(update)
        .where(eq(presetsTable.id, id))
        .returning();
    } catch (err) {
      logger.warn({ err }, "preset update failed (likely duplicate name)");
      res
        .status(400)
        .json({ error: "A preset with that name already exists" });
      return;
    }
  }

  if (parsed.data.documentIds !== undefined) {
    const ownedIds = await filterOwnedDocIds(userId, parsed.data.documentIds);
    await db
      .delete(presetDocumentsTable)
      .where(eq(presetDocumentsTable.presetId, id));
    if (ownedIds.length > 0) {
      await db
        .insert(presetDocumentsTable)
        .values(
          ownedIds.map((docId) => ({ presetId: id, documentId: docId })),
        );
    }
  }

  const docIds = await loadDocLinks(id);
  const profile = await getOrCreateProfile(userId);
  res.json(serializePreset(updated, docIds, profile.activePresetId === id));
});

router.delete("/profile/presets/:id", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const id = String(req.params.id);

  const userPresets = await db
    .select()
    .from(presetsTable)
    .where(eq(presetsTable.userId, userId))
    .orderBy(asc(presetsTable.createdAt));

  const target = userPresets.find((p) => p.id === id);
  if (!target) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }

  if (userPresets.length <= 1) {
    res
      .status(400)
      .json({ error: "Cannot delete your only preset — create another first" });
    return;
  }

  const profile = await getOrCreateProfile(userId);
  let newActiveId = profile.activePresetId;

  // If we're deleting the currently active preset, hand off to the next
  // remaining preset (the oldest one that isn't the target).
  if (newActiveId === id) {
    const next = userPresets.find((p) => p.id !== id);
    newActiveId = next ? next.id : null;
    await db
      .update(profilesTable)
      .set({ activePresetId: newActiveId })
      .where(eq(profilesTable.userId, userId));
  }

  await db.delete(presetsTable).where(eq(presetsTable.id, id));

  res.json({ success: true, activePresetId: newActiveId ?? "" });
});

router.post(
  "/profile/presets/:id/duplicate",
  requireAuth,
  async (req, res) => {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const [existing] = await db
      .select()
      .from(presetsTable)
      .where(and(eq(presetsTable.id, id), eq(presetsTable.userId, userId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }

    const docIds = await loadDocLinks(id);

    // Append " (copy)" — and if that name already exists, walk through "(copy 2)"
    // etc. so we don't trip the unique-name index.
    const taken = new Set(
      (
        await db
          .select({ name: presetsTable.name })
          .from(presetsTable)
          .where(eq(presetsTable.userId, userId))
      ).map((r) => r.name),
    );
    let candidate = `${existing.name} (copy)`;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${existing.name} (copy ${n++})`;
    }

    const [created] = await db
      .insert(presetsTable)
      .values({
        userId,
        name: candidate,
        description: existing.description,
        profileSnapshot: existing.profileSnapshot,
      })
      .returning();

    if (docIds.length > 0) {
      await db
        .insert(presetDocumentsTable)
        .values(docIds.map((d) => ({ presetId: created.id, documentId: d })));
    }

    res.json(serializePreset(created, docIds, false));
  },
);

router.post(
  "/profile/presets/:id/activate",
  requireAuth,
  async (req, res) => {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const [existing] = await db
      .select()
      .from(presetsTable)
      .where(and(eq(presetsTable.id, id), eq(presetsTable.userId, userId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }

    await db
      .update(profilesTable)
      .set({ activePresetId: id })
      .where(eq(profilesTable.userId, userId));

    const docIds = await loadDocLinks(id);
    res.json(serializePreset(existing, docIds, true));
  },
);

export default router;
