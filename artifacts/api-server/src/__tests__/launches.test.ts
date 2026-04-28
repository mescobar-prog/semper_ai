import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import {
  createTestTool,
  createTestUser,
  affirmTestUser,
  cleanupTestData,
  type TestUser,
} from "./helpers/setup";

describe("POST /api/tools/:id/launch (local_install)", () => {
  const createdUserIds: string[] = [];
  const createdToolIds: string[] = [];
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser();
    createdUserIds.push(user.userId);
    // The launch endpoint gates on a valid affirmation for (active preset,
    // current cb version). Seed one so each test body can POST /launch
    // without first walking the marketplace's affirmation modal flow.
    await affirmTestUser(user.userId);
  });

  afterAll(async () => {
    await cleanupTestData({
      userIds: createdUserIds,
      toolIds: createdToolIds,
    });
  });

  // Wrap createTestTool so the new id is registered for cleanup BEFORE
  // it's returned to the test body. Previously the test pushed the id
  // after the call returned, which meant any throw between create and
  // push (an assertion failure on the awaited call, etc.) would strand
  // the row in the DB and the next run would see leftover tools.
  async function createTrackedTool(
    overrides: Parameters<typeof createTestTool>[0],
  ): Promise<string> {
    const toolId = await createTestTool(overrides);
    createdToolIds.push(toolId);
    return toolId;
  }

  it("returns hostingType=local_install and substitutes {token} into the local launch URL pattern", async () => {
    const toolId = await createTrackedTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch?session={token}&extra=foo",
      installerFilename: "myapp-1.0.0.exe",
      installInstructions: "Run the installer and click Next.",
      installerUrl: "https://example.test/installer.exe",
    });

    const res = await request(app)
      .post(`/api/tools/${toolId}/launch`)
      .set(user.authHeader)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.hostingType).toBe("local_install");
    expect(typeof res.body.launchToken).toBe("string");
    expect(res.body.launchToken.length).toBeGreaterThan(0);

    const token: string = res.body.launchToken;
    expect(res.body.launchUrl).toBe(
      `myapp://launch?session=${encodeURIComponent(token)}&extra=foo`,
    );
    expect(res.body.installerDownloadUrl).toBe(
      "https://example.test/installer.exe",
    );
    expect(res.body.installerFilename).toBe("myapp-1.0.0.exe");
    expect(res.body.installInstructions).toBe(
      "Run the installer and click Next.",
    );
  });

  it("falls back to appending ?token= when local pattern has no {token}", async () => {
    const toolId = await createTrackedTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch",
    });

    const res = await request(app)
      .post(`/api/tools/${toolId}/launch`)
      .set(user.authHeader)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.hostingType).toBe("local_install");
    const token: string = res.body.launchToken;
    expect(res.body.launchUrl).toBe(
      `myapp://launch?token=${encodeURIComponent(token)}`,
    );
  });

  it("rejects unauthenticated callers", async () => {
    const toolId = await createTrackedTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch?t={token}",
    });

    const res = await request(app)
      .post(`/api/tools/${toolId}/launch`)
      .send({});

    expect(res.status).toBe(401);
  });

  // Targeted test for Task #119 fix #6: a launch token must be
  // single-use. The atomic UPDATE...WHERE used_at IS NULL guarantees
  // only one /context-exchange call wins per token; subsequent uses
  // must come back as 401.
  it("rejects re-use of a launch token on /tools/context-exchange", async () => {
    const toolId = await createTrackedTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch?t={token}",
    });

    const launchRes = await request(app)
      .post(`/api/tools/${toolId}/launch`)
      .set(user.authHeader)
      .send({});
    expect(launchRes.status).toBe(200);
    const token: string = launchRes.body.launchToken;
    expect(typeof token).toBe("string");

    const first = await request(app)
      .post("/api/tools/context-exchange")
      .send({ launchToken: token });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/tools/context-exchange")
      .send({ launchToken: token });
    expect(second.status).toBe(401);
    expect(second.body.error).toMatch(/used|invalid|expired/i);
  });
});
