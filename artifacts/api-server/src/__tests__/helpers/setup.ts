import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  profilesTable,
  toolsTable,
  presetsTable,
  presetDocumentsTable,
  launchesTable,
  launchTokensTable,
  launchAffirmationsTable,
  contextBlocksTable,
  sessionTokensTable,
  sessionsTable,
} from "@workspace/db";
import { createSession } from "../../lib/auth";
import {
  ensureActivePreset,
  getOrCreateContextBlock,
} from "../../lib/profile-helpers";

export interface TestUser {
  userId: string;
  sessionId: string;
  authHeader: { Authorization: string };
}

export async function createTestUser(opts: {
  isAdmin?: boolean;
  email?: string;
} = {}): Promise<TestUser> {
  const userId = `test-${randomUUID()}`;
  const email = opts.email ?? `${userId}@example.test`;

  await db.insert(usersTable).values({
    id: userId,
    email,
    firstName: "Test",
    lastName: "User",
  });

  await db.insert(profilesTable).values({
    userId,
    isAdmin: opts.isAdmin ? "true" : "false",
  });

  const sessionId = await createSession({
    user: {
      id: userId,
      email,
      firstName: "Test",
      lastName: "User",
      profileImageUrl: null,
    },
    access_token: "test-access-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  return {
    userId,
    sessionId,
    authHeader: { Authorization: `Bearer ${sessionId}` },
  };
}

/**
 * Seed a valid launch-time affirmation for the test user against their
 * active preset and current context-block version. The launch endpoint
 * requires this row (Task #45) — without it, POST /api/tools/:id/launch
 * returns 409 needs_affirmation. We also pre-confirm the context block so
 * `loadValidAffirmation` doesn't trip on a version mismatch later.
 */
export async function affirmTestUser(userId: string): Promise<void> {
  const cb = await getOrCreateContextBlock(userId);
  const { preset } = await ensureActivePreset(userId);

  // Stamp the context block as confirmed (GO) so any downstream check
  // that gates on cb.confirmedAt / status passes for this user.
  await db
    .update(contextBlocksTable)
    .set({
      status: "GO",
      scoreTotal: 12,
      confirmedAt: new Date(),
      opsecFlag: "false",
    })
    .where(eq(contextBlocksTable.userId, userId));

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await db
    .insert(launchAffirmationsTable)
    .values({
      userId,
      presetId: preset.id,
      contextBlockVersion: cb.version ?? 1,
      affirmedAt: new Date(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: launchAffirmationsTable.userId,
      set: {
        presetId: preset.id,
        contextBlockVersion: cb.version ?? 1,
        affirmedAt: new Date(),
        expiresAt,
      },
    });
}

export async function createTestTool(
  overrides: Partial<typeof toolsTable.$inferInsert> = {},
): Promise<string> {
  const id = `test-tool-${randomUUID()}`;
  const slug = `test-tool-${randomUUID().slice(0, 8)}`;
  await db.insert(toolsTable).values({
    id,
    slug,
    name: "Test Tool",
    vendor: "Test Vendor",
    shortDescription: "A test tool",
    longDescription: "A longer description for the test tool",
    launchUrl: "https://example.test/launch",
    hostingType: "cloud",
    submissionStatus: "approved",
    isActive: "true",
    ...overrides,
  });
  return id;
}

/**
 * Best-effort cleanup of rows created by a test. Caller passes the IDs they
 * inserted; we do not delete anything else so we don't accidentally wipe
 * shared dev data.
 */
export async function cleanupTestData(ids: {
  userIds?: string[];
  toolIds?: string[];
}): Promise<void> {
  const userIds = ids.userIds ?? [];
  const toolIds = ids.toolIds ?? [];

  if (toolIds.length > 0) {
    // Delete launches first (sessionTokens / launchTokens cascade via FK)
    const launchRows = await db
      .select({ id: launchesTable.id })
      .from(launchesTable)
      .where(inArray(launchesTable.toolId, toolIds));
    const launchIds = launchRows.map((r) => r.id);
    if (launchIds.length > 0) {
      await db
        .delete(sessionTokensTable)
        .where(inArray(sessionTokensTable.launchId, launchIds));
      await db
        .delete(launchTokensTable)
        .where(inArray(launchTokensTable.launchId, launchIds));
      await db
        .delete(launchesTable)
        .where(inArray(launchesTable.id, launchIds));
    }
    await db.delete(toolsTable).where(inArray(toolsTable.id, toolIds));
  }

  for (const userId of userIds) {
    // Delete preset_documents -> presets first to satisfy FKs
    const presetRows = await db
      .select({ id: presetsTable.id })
      .from(presetsTable)
      .where(eq(presetsTable.userId, userId));
    const presetIds = presetRows.map((r) => r.id);
    if (presetIds.length > 0) {
      await db
        .delete(presetDocumentsTable)
        .where(inArray(presetDocumentsTable.presetId, presetIds));
      await db
        .delete(presetsTable)
        .where(inArray(presetsTable.id, presetIds));
    }

    const launchRows = await db
      .select({ id: launchesTable.id })
      .from(launchesTable)
      .where(eq(launchesTable.userId, userId));
    const launchIds = launchRows.map((r) => r.id);
    if (launchIds.length > 0) {
      await db
        .delete(sessionTokensTable)
        .where(inArray(sessionTokensTable.launchId, launchIds));
      await db
        .delete(launchTokensTable)
        .where(inArray(launchTokensTable.launchId, launchIds));
      await db.delete(launchesTable).where(inArray(launchesTable.id, launchIds));
    }

    // Drop launch_affirmations rows seeded via affirmTestUser. There's at
    // most one per user (PK on user_id) but eq() handles the absent case.
    await db
      .delete(launchAffirmationsTable)
      .where(eq(launchAffirmationsTable.userId, userId));
    await db.delete(contextBlocksTable).where(eq(contextBlocksTable.userId, userId));
    await db.delete(profilesTable).where(eq(profilesTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }

  // Drop sessions for these users so the sessions table doesn't grow
  // unbounded across runs. Sessions are keyed by sid (opaque), but
  // `auth.ts::createSession` stores the user id at `sess.user.id`, so
  // we use a JSONB filter to delete only the rows our test users own.
  if (userIds.length > 0) {
    try {
      // drizzle's sql template wraps an embedded JS array as a record
      // (composite type) which postgres can't cast to text[]; expand the
      // ids into individual bound params via sql.join so each one is its
      // own ::text parameter inside an IN list.
      const idList = sql.join(
        userIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await db.execute(
        sql`DELETE FROM sessions WHERE sess->'user'->>'id' IN (${idList})`,
      );
    } catch (err) {
      // Best-effort: don't fail tests if the sessions schema has drifted.
      // eslint-disable-next-line no-console
      console.warn("test cleanup: failed to delete sessions", err);
    }
  }
  void sessionsTable;
}
