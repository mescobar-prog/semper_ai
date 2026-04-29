import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, toolsTable } from "@workspace/db";
import { runGitSelectedBranchBackfill } from "../lib/migrate";
import { createTestTool, cleanupTestData } from "./helpers/setup";

describe("runGitSelectedBranchBackfill", () => {
  const createdToolIds: string[] = [];

  afterAll(async () => {
    await cleanupTestData({ toolIds: createdToolIds });
  });

  it("mirrors gitDefaultBranch into gitSelectedBranch for legacy linked tools", async () => {
    const linkedLegacyId = await createTestTool({
      gitRepoOwner: "octo-org",
      gitRepoName: "octo-repo",
      gitDefaultBranch: "main",
      gitSelectedBranch: null,
    });
    const alreadySelectedId = await createTestTool({
      gitRepoOwner: "octo-org",
      gitRepoName: "octo-repo",
      gitDefaultBranch: "main",
      gitSelectedBranch: "release/v9", // intentional non-default
    });
    const unlinkedId = await createTestTool({
      gitRepoOwner: null,
      gitRepoName: null,
      gitDefaultBranch: null,
      gitSelectedBranch: null,
    });
    createdToolIds.push(linkedLegacyId, alreadySelectedId, unlinkedId);

    await runGitSelectedBranchBackfill();

    const [legacy] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, linkedLegacyId))
      .limit(1);
    expect(legacy.gitSelectedBranch).toBe("main");

    const [kept] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, alreadySelectedId))
      .limit(1);
    // Must NOT clobber an admin-chosen branch.
    expect(kept.gitSelectedBranch).toBe("release/v9");

    const [unlinked] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, unlinkedId))
      .limit(1);
    // Tool with no GitHub link stays untouched.
    expect(unlinked.gitSelectedBranch).toBeNull();

    // Idempotent: a second run should not change anything.
    await runGitSelectedBranchBackfill();
    const [again] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, linkedLegacyId))
      .limit(1);
    expect(again.gitSelectedBranch).toBe("main");
  });
});
