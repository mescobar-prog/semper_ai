import { eq, sql } from "drizzle-orm";
import { db, documentsTable, docChunksTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { extractDocumentText } from "./document-extract";
import { chunkText } from "./rag";
import { ingestChunks } from "./chunk-ingest";
import { logger } from "./logger";

const objectStorage = new ObjectStorageService();

async function downloadObjectToBuffer(objectPath: string): Promise<Buffer> {
  const file = await objectStorage.getObjectEntityFile(objectPath);
  const [bytes] = await file.download();
  return bytes;
}

async function markFailed(documentId: string, message: string): Promise<void> {
  await db
    .update(documentsTable)
    .set({
      status: "failed",
      errorMessage: message,
      processedAt: new Date(),
    })
    .where(eq(documentsTable.id, documentId));
}

/**
 * Process a document that has been uploaded to object storage.
 *
 * State machine: uploaded -> processing -> ready | failed
 *
 * The status field is the source of truth for the UI; on failure the
 * errorMessage field carries a user-friendly explanation.
 */
export async function processStoredDocument(documentId: string): Promise<void> {
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.id, documentId))
    .limit(1);

  if (!doc) {
    logger.warn({ documentId }, "processStoredDocument: doc not found");
    return;
  }
  if (!doc.storageObjectPath) {
    await markFailed(documentId, "Document has no associated upload.");
    return;
  }

  // Move to processing so the UI shows a spinner instead of "uploaded".
  await db
    .update(documentsTable)
    .set({ status: "processing", errorMessage: null })
    .where(eq(documentsTable.id, documentId));

  let buffer: Buffer;
  try {
    buffer = await downloadObjectToBuffer(doc.storageObjectPath);
  } catch (err) {
    logger.warn(
      { err, documentId, storageObjectPath: doc.storageObjectPath },
      "failed to download uploaded file from object storage",
    );
    await markFailed(
      documentId,
      "Could not download the uploaded file. Try uploading again.",
    );
    return;
  }

  let extracted: { text: string; mimeType: string };
  try {
    extracted = await extractDocumentText({
      buffer,
      mimeType: doc.mimeType,
      sourceFilename: doc.sourceFilename,
    });
  } catch (err) {
    logger.warn({ err, documentId }, "extraction failed");
    const msg =
      err instanceof Error
        ? `Could not extract text: ${err.message}`
        : "Could not extract text from this file.";
    await markFailed(documentId, msg);
    return;
  }

  const text = extracted.text.trim();
  if (text.length === 0) {
    await markFailed(
      documentId,
      "No extractable text found. Scanned-image PDFs and password-protected files are not supported.",
    );
    return;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    await markFailed(documentId, "Document has no extractable text.");
    return;
  }

  let result;
  try {
    result = await ingestChunks(doc.id, doc.userId, chunks);
  } catch (err) {
    logger.error({ err, documentId }, "chunk insert failed");
    await markFailed(documentId, "Failed to index extracted text.");
    return;
  }

  // If embeddings failed, the chunks are still written and FTS still works,
  // so we mark the doc ready but surface a non-fatal warning the UI can show.
  // Backfill on the next server boot will retry the embeddings.
  const errorMessage = result.embeddingError
    ? "Indexed for keyword search; semantic search will activate once embeddings finish processing."
    : null;

  await db
    .update(documentsTable)
    .set({
      status: "ready",
      mimeType: extracted.mimeType,
      sizeBytes: buffer.byteLength,
      charCount: text.length,
      chunkCount: chunks.length,
      errorMessage,
      processedAt: new Date(),
    })
    .where(eq(documentsTable.id, documentId));
}

/**
 * Re-run extraction against an already-uploaded blob in object storage for
 * a single failed document. Caller must have already verified the row is
 * owned by the current user, currently `failed`, and has a usable
 * `storageObjectPath`.
 *
 * Always increments `retryCount`, regardless of outcome, so the route
 * handler / UI can decide when to stop offering Retry and ask the user to
 * re-upload the file from scratch. Returns the post-retry document row.
 */
export async function retryFailedStoredDocument(
  doc: typeof documentsTable.$inferSelect,
): Promise<typeof documentsTable.$inferSelect> {
  if (!doc.storageObjectPath) {
    throw new Error("Document has no stored upload to retry against.");
  }

  // Bump retry count + flip status to processing in one update so polling
  // clients immediately see the spinner. processStoredDocument will set
  // status again (also to "processing") which is a harmless no-op.
  await db
    .update(documentsTable)
    .set({
      status: "processing",
      errorMessage: null,
      retryCount: sql`${documentsTable.retryCount} + 1`,
    })
    .where(eq(documentsTable.id, doc.id));

  // Drop any chunks left over from a previous attempt before processing
  // re-inserts. A failed row should never have chunks, but defend in depth.
  await db
    .delete(docChunksTable)
    .where(eq(docChunksTable.documentId, doc.id));

  await processStoredDocument(doc.id);

  const [updated] = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.id, doc.id))
    .limit(1);
  return updated;
}
