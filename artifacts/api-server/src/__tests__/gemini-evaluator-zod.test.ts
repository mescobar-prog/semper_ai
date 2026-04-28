import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Gemini integration so we can drive the evaluator's response
// text without hitting a real API. We control `response.text` per-test.
const mockGenerateContent = vi.fn();
vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    models: {
      generateContent: (...args: unknown[]) => mockGenerateContent(...args),
    },
  },
}));

const { evaluateContextBlock } = await import("../lib/gemini-helpers");

const SUB = {
  doctrine: "MCDP-4 references for sustainment.",
  intent: "Establish FARP by 18:00.",
  environment: "Mountain valley, contested EW.",
  constraints: "No off-shore data.",
  risk: "Bad fires coordination if hallucinated.",
  experience: "Prior FARP stand-ups in this AOR.",
};

describe("evaluateContextBlock — Zod safeParse on model output", () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  it("returns NO-GO with schema-mismatch flag when the model returns a malformed shape", async () => {
    // Missing `scores` entirely — zod schema requires it.
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        submission_id: "s1",
        status: "GO",
        flags: "None",
      }),
    });
    const result = await evaluateContextBlock(SUB);
    expect(result.status).toBe("NO-GO");
    expect(result.totalScore).toBe(0);
    expect(result.flags).toMatch(/schema/i);
    expect(result.opsecFlag).toBe(false);
  });

  it("returns NO-GO when scores contain non-numeric junk that can't be coerced", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        submission_id: "s2",
        scores: {
          criterion_1_doctrine: "not-a-number",
          criterion_2_environment: 3,
          criterion_3_constraints: 3,
          criterion_4_experience: 3,
        },
        status: "GO",
        flags: "None",
      }),
    });
    const result = await evaluateContextBlock(SUB);
    expect(result.status).toBe("NO-GO");
    expect(result.flags).toMatch(/schema/i);
  });

  it("throws a clean evaluator-unavailable error when generateContent rejects", async () => {
    mockGenerateContent.mockRejectedValueOnce(
      new Error("safety filter triggered"),
    );
    await expect(evaluateContextBlock(SUB)).rejects.toThrow(
      /evaluator unavailable/i,
    );
  });

  it("throws a clean unparseable-response error when the text is not JSON", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: "I cannot evaluate this submission.",
    });
    await expect(evaluateContextBlock(SUB)).rejects.toThrow(
      /unparseable/i,
    );
  });

  it("scores GO normally when the model returns a well-formed schema-valid response", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        submission_id: "s5",
        scores: {
          criterion_1_doctrine: 3,
          criterion_2_environment: 3,
          criterion_3_constraints: 3,
          criterion_4_experience: 3,
        },
        total_score: 12,
        status: "GO",
        flags: "None",
      }),
    });
    const result = await evaluateContextBlock(SUB);
    expect(result.status).toBe("GO");
    expect(result.totalScore).toBe(12);
    expect(result.opsecFlag).toBe(false);
  });

  it("forces NO-GO with opsecFlag when flags mention OPSEC even on a GO status", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        submission_id: "s6",
        scores: {
          criterion_1_doctrine: 3,
          criterion_2_environment: 3,
          criterion_3_constraints: 3,
          criterion_4_experience: 3,
        },
        total_score: 12,
        status: "GO",
        flags: "Possible OPSEC concern: grid coordinates",
      }),
    });
    const result = await evaluateContextBlock(SUB);
    expect(result.status).toBe("NO-GO");
    expect(result.opsecFlag).toBe(true);
    expect(result.totalScore).toBe(0);
  });
});
