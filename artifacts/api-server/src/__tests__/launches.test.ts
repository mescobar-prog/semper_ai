import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import {
  createTestTool,
  createTestUser,
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
  });

  afterAll(async () => {
    await cleanupTestData({
      userIds: createdUserIds,
      toolIds: createdToolIds,
    });
  });

  it("returns hostingType=local_install and substitutes {token} into the local launch URL pattern", async () => {
    const toolId = await createTestTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch?session={token}&extra=foo",
      installerFilename: "myapp-1.0.0.exe",
      installInstructions: "Run the installer and click Next.",
      installerUrl: "https://example.test/installer.exe",
    });
    createdToolIds.push(toolId);

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
    const toolId = await createTestTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch",
    });
    createdToolIds.push(toolId);

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
    const toolId = await createTestTool({
      hostingType: "local_install",
      localLaunchUrlPattern: "myapp://launch?t={token}",
    });
    createdToolIds.push(toolId);

    const res = await request(app)
      .post(`/api/tools/${toolId}/launch`)
      .send({});

    expect(res.status).toBe(401);
  });
});
