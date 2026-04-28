import { and, eq, sql } from "drizzle-orm";
import {
  db,
  documentsTable,
  docChunksTable,
  ingestJobsTable,
} from "@workspace/db";
import {
  buildMosAutoSource,
  buildUnitAutoSource,
  branchCode,
  findMosEntry,
  getMosDoctrinePackage,
  getUnitDoctrinePackage,
  hasUnitDoctrinePackage,
  type DoctrineEntry,
} from "@workspace/mil-data";
import { extractDocumentText } from "./document-extract";
import { chunkText } from "./chunker";
import { ingestChunks } from "./chunk-ingest";
import type { Chunk } from "./chunker";
import { logger } from "./logger";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_CONCURRENCY = 3;

export interface IngestSummary {
  source: string;
  total: number;
  added: number;
  existing: number;
  failed: number;
}

async function fetchDocBytes(
  url: string,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "DoD-AI-Marketplace-AutoIngest/1.0 (+marketplace.dod.ai)",
      },
    });
    if (!resp.ok) {
      throw new Error(
        resp.statusText?.trim() ? resp.statusText : "Request failed",
      );
    }
    const arr = new Uint8Array(await resp.arrayBuffer());
    if (arr.byteLength > MAX_DOC_BYTES) {
      throw new Error(
        `Doc too large (${arr.byteLength} bytes; limit ${MAX_DOC_BYTES})`,
      );
    }
    return {
      buffer: Buffer.from(arr),
      contentType: resp.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch + extract + chunk one doctrine URL. Returns the chunks and the
 * resolved metadata, or throws with a user-facing message on any failure
 * along the way (network, extraction, empty text, zero chunks).
 *
 * Used by both the initial ingest path and the single-doc retry path so
 * both behave identically (same fetch, same limits, same extraction).
 */
async function fetchAndExtract(
  url: string,
  sourceFilename: string,
  mimeTypeHint?: string,
): Promise<{
  buffer: Buffer;
  mimeType: string;
  text: string;
  chunks: Chunk[];
}> {
  const { buffer, contentType } = await fetchDocBytes(url);
  const mime = contentType || mimeTypeHint || "application/pdf";
  const extracted = await extractDocumentText({
    buffer,
    mimeType: mime,
    sourceFilename,
  });
  const text = extracted.text.trim();
  if (text.length === 0) {
    throw new Error(
      "No extractable text (the PDF is likely scanned images).",
    );
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error("Document chunked to zero pieces");
  }
  return { buffer, mimeType: extracted.mimeType, text, chunks };
}

async function ingestOne(
  userId: string,
  autoSource: string,
  entry: DoctrineEntry,
): Promise<"added" | "existing" | "failed"> {
  // Skip if already present for this user with same auto_source + url.
  const existing = await db
    .select({ id: documentsTable.id })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.userId, userId),
        eq(documentsTable.autoSource, autoSource),
        eq(documentsTable.sourceUrl, entry.url),
      ),
    )
    .limit(1);
  if (existing.length > 0) return "existing";

  const sourceFilename =
    entry.url.split("/").pop()?.split("?")[0] || "doctrine.pdf";

  try {
    const { buffer, mimeType, text, chunks } = await fetchAndExtract(
      entry.url,
      sourceFilename,
      entry.mimeTypeHint,
    );
    const [doc] = await db
      .insert(documentsTable)
      .values({
        userId,
        title: entry.title,
        sourceFilename,
        mimeType,
        sizeBytes: buffer.byteLength,
        charCount: text.length,
        chunkCount: chunks.length,
        status: "ready",
        autoSource,
        sourceUrl: entry.url,
        processedAt: new Date(),
      })
      .returning();
    try {
      const result = await ingestChunks(doc.id, userId, chunks);
      if (result.embeddingError) {
        await db
          .update(documentsTable)
          .set({
            errorMessage:
              "Indexed for keyword search; semantic search will activate once embeddings finish processing.",
          })
          .where(eq(documentsTable.id, doc.id));
      }
    } catch (err) {
      logger.error(
        { err, docId: doc.id },
        "auto-ingest chunk insert failed; rolling back document",
      );
      await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
      throw err;
    }
    return "added";
  } catch (err) {
    // Persist a failed-row so the user can see what we tried to pull and why.
    logger.warn(
      { err, url: entry.url, autoSource },
      "auto-ingest doc failed",
    );
    await db.insert(documentsTable).values({
      userId,
      title: entry.title,
      sourceFilename,
      mimeType: entry.mimeTypeHint,
      sizeBytes: 0,
      charCount: 0,
      chunkCount: 0,
      status: "failed",
      autoSource,
      sourceUrl: entry.url,
      errorMessage:
        err instanceof Error ? err.message.slice(0, 500) : "Fetch failed",
      processedAt: new Date(),
    });
    return "failed";
  }
}

/**
 * Re-run the auto-ingest fetch/extract pipeline for a single existing
 * document row, updating it in place. Caller must have already verified
 * the row is owned by the current user, currently `failed`, and has a
 * usable `sourceUrl`.
 *
 * Always increments `retryCount`, regardless of outcome, so the UI can
 * decide whether to surface the manual-upload fallback. Returns the
 * post-retry document row.
 */
export async function retryFailedAutoDocument(
  doc: typeof documentsTable.$inferSelect,
): Promise<typeof documentsTable.$inferSelect> {
  if (!doc.sourceUrl) {
    throw new Error("Document has no source URL to retry against.");
  }

  // Flip to processing so polling clients see a spinner immediately.
  await db
    .update(documentsTable)
    .set({ status: "processing", errorMessage: null })
    .where(eq(documentsTable.id, doc.id));

  try {
    const { buffer, mimeType, text, chunks } = await fetchAndExtract(
      doc.sourceUrl,
      doc.sourceFilename,
      doc.mimeType || undefined,
    );

    // Drop any chunks that may have been left over from a previous attempt
    // before inserting the fresh ones.
    await db
      .delete(docChunksTable)
      .where(eq(docChunksTable.documentId, doc.id));

    const ingestResult = await ingestChunks(doc.id, doc.userId, chunks);

    const [updated] = await db
      .update(documentsTable)
      .set({
        status: "ready",
        mimeType,
        sizeBytes: buffer.byteLength,
        charCount: text.length,
        chunkCount: chunks.length,
        // If embeddings failed mid-retry, keep the doc as ready (FTS still
        // works) but surface a warning so the UI can hint that semantic
        // search will activate after backfill.
        errorMessage: ingestResult.embeddingError
          ? "Indexed for keyword search; semantic search will activate once embeddings finish processing."
          : null,
        processedAt: new Date(),
        retryCount: sql`${documentsTable.retryCount} + 1`,
      })
      .where(eq(documentsTable.id, doc.id))
      .returning();
    return updated;
  } catch (err) {
    logger.warn(
      { err, docId: doc.id, url: doc.sourceUrl },
      "auto-ingest retry failed",
    );
    const [updated] = await db
      .update(documentsTable)
      .set({
        status: "failed",
        charCount: 0,
        chunkCount: 0,
        errorMessage:
          err instanceof Error ? err.message.slice(0, 500) : "Fetch failed",
        processedAt: new Date(),
        retryCount: sql`${documentsTable.retryCount} + 1`,
      })
      .where(eq(documentsTable.id, doc.id))
      .returning();
    return updated;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  limit = MAX_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runIngestPackage(
  userId: string,
  autoSource: string,
  pkg: DoctrineEntry[],
): Promise<IngestSummary> {
  // Open a job row up-front so the UI can poll status.
  const [job] = await db
    .insert(ingestJobsTable)
    .values({
      userId,
      source: autoSource,
      status: "running",
      totalCount: pkg.length,
    })
    .returning();

  let added = 0;
  let existing = 0;
  let failed = 0;
  try {
    const results = await runWithConcurrency(pkg, (entry) =>
      ingestOne(userId, autoSource, entry),
    );
    for (const r of results) {
      if (r === "added") added++;
      else if (r === "existing") existing++;
      else failed++;
    }
    await db
      .update(ingestJobsTable)
      .set({
        status: "done",
        addedCount: added,
        existingCount: existing,
        failedCount: failed,
      })
      .where(eq(ingestJobsTable.id, job.id));
  } catch (err) {
    logger.error({ err, autoSource }, "auto-ingest package crashed");
    await db
      .update(ingestJobsTable)
      .set({
        status: "failed",
        addedCount: added,
        existingCount: existing,
        failedCount: failed,
        errorMessage:
          err instanceof Error ? err.message.slice(0, 500) : "Ingest crashed",
      })
      .where(eq(ingestJobsTable.id, job.id));
  }
  return {
    source: autoSource,
    total: pkg.length,
    added,
    existing,
    failed,
  };
}

/**
 * Look up the MOS doctrine package and ingest it for the user. Returns the
 * canonical autoSource used (e.g. "mos:army:11B") or null if the
 * branch/MOS combination is not recognized.
 */
export async function ingestMosPackage(
  userId: string,
  branch: string | null | undefined,
  mosCode: string | null | undefined,
): Promise<{ autoSource: string; summary: IngestSummary } | null> {
  const code = branchCode(branch);
  if (!code || !mosCode) return null;
  const trimmed = mosCode.trim();
  if (!trimmed) return null;
  // Only ingest for known MOS codes — the dataset is the source of truth.
  const entry = findMosEntry(code, trimmed);
  if (!entry) return null;
  const autoSource = buildMosAutoSource(code, entry.code);
  const pkg = getMosDoctrinePackage(code, entry.code);
  if (pkg.length === 0) return null;
  const summary = await runIngestPackage(userId, autoSource, pkg);
  return { autoSource, summary };
}

export async function ingestUnitPackage(
  userId: string,
  branch: string | null | undefined,
  unit: string | null | undefined,
): Promise<{ autoSource: string; summary: IngestSummary } | null> {
  const code = branchCode(branch);
  if (!code || !unit) return null;
  const trimmed = unit.trim();
  if (!trimmed) return null;
  if (!hasUnitDoctrinePackage(code, trimmed)) return null;
  const autoSource = buildUnitAutoSource(code, trimmed);
  const pkg = getUnitDoctrinePackage(code, trimmed);
  if (pkg.length === 0) return null;
  const summary = await runIngestPackage(userId, autoSource, pkg);
  return { autoSource, summary };
}

/** Fire-and-forget helper used by the profile route. Errors are logged, not thrown. */
export function startIngestPackage(
  fn: () => Promise<unknown>,
  context: { userId: string; source: string },
): void {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      logger.error({ err, ...context }, "background auto-ingest failed");
    });
}
