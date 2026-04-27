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
    return { text: result.text ?? "", mimeType: mime };
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
