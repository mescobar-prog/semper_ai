import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, contextBlocksTable } from "@workspace/db";

// Mock the evaluator before importing the app so the route picks up the mock.
// The evaluator normally calls Gemini; here we deterministically return one
// of three pre-canned evaluations keyed on the doctrine field.
vi.mock("../lib/gemini-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/gemini-helpers")>();
  return {
    ...actual,
    evaluateContextBlock: vi.fn(async (sub: { doctrine: string }) => {
      const baseScores = {
        doctrine: 3 as const,
        environment: 3 as const,
        constraints: 3 as const,
        experience: 3 as const,
      };
      if (sub.doctrine.includes("OPSEC_FAIL")) {
        return {
          submissionId: "sub-opsec",
          totalScore: 0,
          status: "NO-GO" as const,
          opsecFlag: true,
          flags: "OPSEC violation detected",
          scores: { ...baseScores, doctrine: 1 as const },
        };
      }
      if (sub.doctrine.includes("SUB_THRESHOLD")) {
        return {
          submissionId: "sub-sub",
          totalScore: 7,
          status: "NO-GO" as const,
          opsecFlag: false,
          flags: "",
          scores: { ...baseScores, doctrine: 1 as const },
        };
      }
      // Edge case: evaluator returns NO-GO but the score is at/above the
      // 10/12 threshold (e.g. some future status reason that isn't tied
      // to score or OPSEC). Bypass must NOT cover this — the bypass path
      // is strictly for sub-threshold (totalScore < 10) submissions.
      if (sub.doctrine.includes("ABOVE_THRESHOLD_NOGO")) {
        return {
          submissionId: "sub-above",
          totalScore: 11,
          status: "NO-GO" as const,
          opsecFlag: false,
          flags: "Reviewer-defined hold",
          scores: baseScores,
        };
      }
      return {
        submissionId: "sub-go",
        totalScore: 12,
        status: "GO" as const,
        opsecFlag: false,
        flags: "",
        scores: baseScores,
      };
    }),
  };
});

const { default: app } = await import("../app");
const { createTestUser, cleanupTestData } = await import("./helpers/setup");

const FILLED = {
  intent: "Stand up a temporary fire base by 18:00.",
  environment: "Mountain valley, contested EW environment, wet weather.",
  constraints: "No off-shore data residency. Coalition partners may co-read.",
  risk: "Loss of comms downgrades fires coordination by one echelon.",
  experience: "Operator has 3 prior FOB stand-ups in this AOR.",
};

describe("POST /api/profile/context-block/confirm — bypass behavior", () => {
  const createdUserIds: string[] = [];
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    user = await createTestUser();
    createdUserIds.push(user.userId);
  });

  afterAll(async () => {
    await cleanupTestData({ userIds: createdUserIds });
  });

  it("rejects sub-threshold confirm without bypass and does not persist", async () => {
    const res = await request(app)
      .post("/api/profile/context-block/confirm")
      .set(user.authHeader)
      .send({
        doctrine: "SUB_THRESHOLD operational guidance.",
        ...FILLED,
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/scored 7\/12/);
    expect(res.body.evaluation?.status).toBe("NO-GO");

    // Row should not show a confirmedAt for this attempt
    const [row] = await db
      .select()
      .from(contextBlocksTable)
      .where(eq(contextBlocksTable.userId, user.userId));
    expect(row?.confirmedAt ?? null).toBeNull();
  });

  it("accepts sub-threshold confirm with bypass:true and persists bypassed=true", async () => {
    const res = await request(app)
      .post("/api/profile/context-block/confirm")
      .set(user.authHeader)
      .send({
        doctrine: "SUB_THRESHOLD operational guidance.",
        ...FILLED,
        bypass: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.contextBlock.bypassed).toBe(true);
    expect(res.body.contextBlock.confirmedAt).toBeTruthy();
    expect(res.body.evaluation.totalScore).toBe(7);

    const [row] = await db
      .select()
      .from(contextBlocksTable)
      .where(eq(contextBlocksTable.userId, user.userId));
    expect(row?.bypassed).toBe("true");
    expect(row?.scoreTotal).toBe(7);
  });

  it("rejects OPSEC violations even with bypass:true (hard reject)", async () => {
    const res = await request(app)
      .post("/api/profile/context-block/confirm")
      .set(user.authHeader)
      .send({
        doctrine: "OPSEC_FAIL leaks operative names and locations.",
        ...FILLED,
        bypass: true,
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/OPSEC/);
    expect(res.body.evaluation.opsecFlag).toBe(true);

    // Bypassed row from the previous test must remain unchanged
    const [row] = await db
      .select()
      .from(contextBlocksTable)
      .where(eq(contextBlocksTable.userId, user.userId));
    expect(row?.bypassed).toBe("true");
    expect(row?.scoreTotal).toBe(7);
  });

  it("rejects bypass when score is at/above 10/12 even on a NO-GO status", async () => {
    // Strict guard: bypass is only valid for sub-threshold scores. A
    // NO-GO with totalScore >= 10 (e.g. a future non-score-based hold)
    // must NOT be bypassable through this path.
    const res = await request(app)
      .post("/api/profile/context-block/confirm")
      .set(user.authHeader)
      .send({
        doctrine: "ABOVE_THRESHOLD_NOGO operational guidance.",
        ...FILLED,
        bypass: true,
      });
    expect(res.status).toBe(422);
    expect(res.body.evaluation.totalScore).toBe(11);
    expect(res.body.evaluation.status).toBe("NO-GO");

    // Row from earlier sub-threshold bypass must remain unchanged.
    const [row] = await db
      .select()
      .from(contextBlocksTable)
      .where(eq(contextBlocksTable.userId, user.userId));
    expect(row?.bypassed).toBe("true");
    expect(row?.scoreTotal).toBe(7);
  });

  it("clears the bypassed flag on a subsequent in-threshold (GO) confirm", async () => {
    const res = await request(app)
      .post("/api/profile/context-block/confirm")
      .set(user.authHeader)
      .send({
        doctrine: "Clean GO doctrine snippet.",
        ...FILLED,
      });
    expect(res.status).toBe(200);
    expect(res.body.contextBlock.bypassed).toBe(false);
    expect(res.body.evaluation.status).toBe("GO");

    const [row] = await db
      .select()
      .from(contextBlocksTable)
      .where(eq(contextBlocksTable.userId, user.userId));
    expect(row?.bypassed).toBe("false");
    expect(row?.scoreTotal).toBe(12);
  });
});
