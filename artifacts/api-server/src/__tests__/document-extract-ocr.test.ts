import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pdf-parse so we can control the extracted text deterministically
// without shipping a sample PDF in the repo. The production code imports
// the inner module path to skip pdf-parse's import-time self-test.
const mockPdfParse = vi.fn();
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({
  default: mockPdfParse,
}));

const { extractDocumentText, OcrRequiredError } = await import(
  "../lib/document-extract"
);

describe("extractDocumentText (PDF) — OCR_REQUIRED sentinel", () => {
  beforeEach(() => {
    mockPdfParse.mockReset();
  });

  it("throws OcrRequiredError when the PDF has only whitespace text", async () => {
    mockPdfParse.mockResolvedValueOnce({ text: "  \n\t  \n  " });
    await expect(
      extractDocumentText({
        buffer: Buffer.from("%PDF-1.4 fake"),
        mimeType: "application/pdf",
        sourceFilename: "scanned.pdf",
      }),
    ).rejects.toBeInstanceOf(OcrRequiredError);
  });

  it("throws OcrRequiredError when the PDF returns null/empty text", async () => {
    mockPdfParse.mockResolvedValueOnce({ text: "" });
    await expect(
      extractDocumentText({
        buffer: Buffer.from("%PDF-1.4 fake"),
        mimeType: "application/pdf",
        sourceFilename: "scanned.pdf",
      }),
    ).rejects.toBeInstanceOf(OcrRequiredError);
  });

  it("returns extracted text when the PDF has a real text layer", async () => {
    mockPdfParse.mockResolvedValueOnce({
      text: "Field Manual 3-21.8 — Infantry Rifle Platoon and Squad",
    });
    const result = await extractDocumentText({
      buffer: Buffer.from("%PDF-1.4 fake"),
      mimeType: "application/pdf",
      sourceFilename: "real.pdf",
    });
    expect(result.mimeType).toBe("application/pdf");
    expect(result.text).toContain("Field Manual");
  });

  it("OcrRequiredError carries the OCR_REQUIRED code so callers can branch on it", () => {
    const err = new OcrRequiredError();
    expect(err.code).toBe("OCR_REQUIRED");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/scanned image|OCR/i);
  });
});
