import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  profilesTable,
  toolsTable,
  presetsTable,
  presetDocumentsTable,
  launchesTable,
  launchTokensTable,
  sessionTokensTable,
  sessionsTable,
} from "@workspace/db";
import { createSession } from "../../lib/auth";

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

    await db.delete(profilesTable).where(eq(profilesTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }

  // Drop any sessions for these users (cookie cleanup); sessions are keyed
  // by sid not userId, so we scan and drop the ones created here. We rely
  // on the explicit sids passed in via TestUser.sessionId in callers if
  // needed; for now, rely on session expiry to roll them off.
  void sessionsTable;
}
