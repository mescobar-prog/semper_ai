import mammoth from "mammoth";
import { logger } from "./logger";

const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB hard cap

export interface ExtractInput {
  buffer: Buffer;
  mimeType: string;
  sourceFilename: string;
}

export interface ExtractResult {
  text: string;
  mimeType: string;
}

/**
 * Sentinel error thrown by the PDF branch when extraction yields only
 * whitespace, which is the signal a PDF is a scanned image (no text
 * layer). The processor catches this by `code` and surfaces a
 * user-facing message that we don't yet support OCR. We do NOT silently
 * persist an empty document — the upload must visibly fail so the user
 * knows to convert their file.
 */
export class OcrRequiredError extends Error {
  readonly code = "OCR_REQUIRED" as const;
  constructor(message = "PDF appears to be a scanned image — no extractable text.") {
    super(message);
    this.name = "OcrRequiredError";
    Object.setPrototypeOf(this, OcrRequiredError.prototype);
  }
}

function inferMimeType(filename: string, declared: string | undefined): string {
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "txt") return "text/plain";
  return "text/plain";
}

export async function extractDocumentText(
  input: ExtractInput,
): Promise<ExtractResult> {
  if (input.buffer.byteLength > MAX_DOC_BYTES) {
    throw new Error(
      `Document is too large (${input.buffer.byteLength} bytes; limit ${MAX_DOC_BYTES}).`,
    );
  }
  const mime = inferMimeType(input.sourceFilename, input.mimeType);

  if (mime === "application/pdf") {
    // pdf-parse ships a self-test that runs at import time and reads a sample
    // PDF off disk, which crashes in our esbuild bundle. Import the inner
    // module directly to skip that.
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const result = await pdfParse(input.buffer);
    const text = result.text ?? "";
    // A PDF that returns only whitespace is almost always a scanned-image
    // PDF: pdf-parse extracts the text layer and there isn't one. We do
    // not have OCR yet, so refuse the upload with a clear sentinel the
    // processor maps to a user-friendly failure message.
    if (text.trim().length === 0) {
      throw new OcrRequiredError();
    }
    return { text, mimeType: mime };
  }

  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  ) {
    const result = await mammoth.extractRawText({ buffer: input.buffer });
    return { text: result.value ?? "", mimeType: mime };
  }

  // text/plain, text/markdown, anything else — treat as UTF-8 text
  try {
    return { text: input.buffer.toString("utf-8"), mimeType: mime };
  } catch (err) {
    logger.warn({ err, mime }, "fallback text decode failed");
    return { text: "", mimeType: mime };
  }
}
