import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import {
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./helpers/setup";

vi.mock("../lib/gemini-helpers", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/gemini-helpers")>(
      "../lib/gemini-helpers",
    );
  return {
    ...actual,
    draftToolText: vi.fn(),
  };
});

// eslint-disable-next-line import/first
import app from "../app";
// eslint-disable-next-line import/first
import { draftToolText } from "../lib/gemini-helpers";

const mockedDraftToolText = vi.mocked(draftToolText);

const TEXT_FIELDS = ["shortDescription", "longDescription", "purpose"] as const;

describe("POST /api/admin/tools/draft-text", () => {
  const createdUserIds: string[] = [];
  let admin: TestUser;
  let nonAdmin: TestUser;

  beforeAll(async () => {
    admin = await createTestUser({ isAdmin: true });
    nonAdmin = await createTestUser({ isAdmin: false });
    createdUserIds.push(admin.userId, nonAdmin.userId);
  });

  afterAll(async () => {
    await cleanupTestData({ userIds: createdUserIds });
  });

  for (const field of TEXT_FIELDS) {
    it(`returns a non-empty draft for field=${field}`, async () => {
      mockedDraftToolText.mockResolvedValueOnce({
        field,
        text: `Stub draft for ${field}`,
        list: null,
      });

      const res = await request(app)
        .post("/api/admin/tools/draft-text")
        .set(admin.authHeader)
        .send({
          field,
          sourceMaterial: { name: "Stub Tool", vendor: "Stub Vendor" },
        });

      expect(res.status).toBe(200);
      expect(res.body.field).toBe(field);
      expect(typeof res.body.text).toBe("string");
      expect(res.body.text.length).toBeGreaterThan(0);
      expect(res.body.list).toBeNull();
    });
  }

  it("returns a non-empty list for field=ragQueryTemplates", async () => {
    mockedDraftToolText.mockResolvedValueOnce({
      field: "ragQueryTemplates",
      text: null,
      list: ["{dutyTitle} SOPs", "{primaryMission} planning"],
    });

    const res = await request(app)
      .post("/api/admin/tools/draft-text")
      .set(admin.authHeader)
      .send({
        field: "ragQueryTemplates",
        sourceMaterial: { name: "Stub Tool" },
      });

    expect(res.status).toBe(200);
    expect(res.body.field).toBe("ragQueryTemplates");
    expect(res.body.text).toBeNull();
    expect(Array.isArray(res.body.list)).toBe(true);
    expect(res.body.list.length).toBeGreaterThan(0);
  });

  it("rejects an unknown field with 400", async () => {
    const res = await request(app)
      .post("/api/admin/tools/draft-text")
      .set(admin.authHeader)
      .send({
        field: "notARealField",
        sourceMaterial: {},
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(mockedDraftToolText).not.toHaveBeenCalledWith(
      "notARealField",
      expect.anything(),
    );
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(app)
      .post("/api/admin/tools/draft-text")
      .set(nonAdmin.authHeader)
      .send({
        field: "shortDescription",
        sourceMaterial: { name: "Stub" },
      });

    expect(res.status).toBe(403);
  });
});
