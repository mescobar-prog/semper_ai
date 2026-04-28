import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, toolsTable } from "@workspace/db";
import {
  createTestTool,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./helpers/setup";

// Stub the GitHub helper so the test does not hit the live connector. Must be
// declared before importing the app so vi.mock hoisting takes effect on the
// admin route's transitive imports.
vi.mock("../lib/github", async () => {
  const actual = await vi.importActual<typeof import("../lib/github")>(
    "../lib/github",
  );
  return {
    ...actual,
    getRepoMetadata: vi.fn(),
  };
});

// eslint-disable-next-line import/first
import app from "../app";
// eslint-disable-next-line import/first
import { getRepoMetadata } from "../lib/github";

const mockedGetRepoMetadata = vi.mocked(getRepoMetadata);

describe("POST /api/admin/tools/:id/sync-github", () => {
  const createdUserIds: string[] = [];
  const createdToolIds: string[] = [];
  let admin: TestUser;
  let nonAdmin: TestUser;

  beforeAll(async () => {
    admin = await createTestUser({ isAdmin: true });
    nonAdmin = await createTestUser({ isAdmin: false });
    createdUserIds.push(admin.userId, nonAdmin.userId);
  });

  afterAll(async () => {
    await cleanupTestData({
      userIds: createdUserIds,
      toolIds: createdToolIds,
    });
  });

  it("persists the stubbed GitHub metadata onto the tool row", async () => {
    const toolId = await createTestTool({
      gitRepoOwner: "octo-org",
      gitRepoName: "octo-repo",
      homepageUrl: null,
    });
    createdToolIds.push(toolId);

    mockedGetRepoMetadata.mockResolvedValueOnce({
      owner: "octo-org",
      name: "octo-repo",
      fullName: "octo-org/octo-repo",
      description: "stub repo",
      defaultBranch: "trunk",
      private: false,
      stars: 42,
      language: "TypeScript",
      licenseSpdx: "Apache-2.0",
      latestReleaseTag: "v9.9.9",
      latestCommitSha: "deadbeefcafef00d",
      homepageUrl: "https://stub.example.test",
      readmeMarkdown: "# stub",
    });

    const res = await request(app)
      .post(`/api/admin/tools/${toolId}/sync-github`)
      .set(admin.authHeader)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.gitDefaultBranch).toBe("trunk");
    expect(res.body.gitLatestReleaseTag).toBe("v9.9.9");
    expect(res.body.gitLatestCommitSha).toBe("deadbeefcafef00d");
    expect(res.body.gitLicenseSpdx).toBe("Apache-2.0");
    expect(res.body.gitStars).toBe(42);
    expect(res.body.homepageUrl).toBe("https://stub.example.test");
    expect(typeof res.body.gitLastSyncedAt).toBe("string");

    // Verify the row was actually persisted, not just echoed.
    const [row] = await db
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.id, toolId))
      .limit(1);
    expect(row.gitDefaultBranch).toBe("trunk");
    expect(row.gitLatestReleaseTag).toBe("v9.9.9");
    expect(row.gitLatestCommitSha).toBe("deadbeefcafef00d");
    expect(row.gitLicenseSpdx).toBe("Apache-2.0");
    expect(row.gitStars).toBe(42);
    expect(row.gitLastSyncedAt).not.toBeNull();
  });

  it("does not overwrite an existing homepageUrl during sync", async () => {
    const toolId = await createTestTool({
      gitRepoOwner: "octo-org",
      gitRepoName: "octo-repo",
      homepageUrl: "https://admin-set.example",
    });
    createdToolIds.push(toolId);

    mockedGetRepoMetadata.mockResolvedValueOnce({
      owner: "octo-org",
      name: "octo-repo",
      fullName: "octo-org/octo-repo",
      description: null,
      defaultBranch: "main",
      private: false,
      stars: 0,
      language: null,
      licenseSpdx: null,
      latestReleaseTag: null,
      latestCommitSha: null,
      homepageUrl: "https://github-derived.example",
      readmeMarkdown: null,
    });

    const res = await request(app)
      .post(`/api/admin/tools/${toolId}/sync-github`)
      .set(admin.authHeader)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.homepageUrl).toBe("https://admin-set.example");
  });

  it("rejects when tool has no GitHub repo linked", async () => {
    const toolId = await createTestTool({
      gitRepoOwner: null,
      gitRepoName: null,
    });
    createdToolIds.push(toolId);

    const res = await request(app)
      .post(`/api/admin/tools/${toolId}/sync-github`)
      .set(admin.authHeader)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not linked/i);
  });

  it("rejects non-admin callers with 403", async () => {
    const toolId = await createTestTool({
      gitRepoOwner: "octo-org",
      gitRepoName: "octo-repo",
    });
    createdToolIds.push(toolId);

    const res = await request(app)
      .post(`/api/admin/tools/${toolId}/sync-github`)
      .set(nonAdmin.authHeader)
      .send({});

    expect(res.status).toBe(403);
  });
});
