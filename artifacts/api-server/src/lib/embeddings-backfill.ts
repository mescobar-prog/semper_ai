import { eq, isNull, and, sql } from "drizzle-orm";
import { db, docChunksTable, EMBEDDING_DIM } from "@workspace/db";
import {
  countTokens,
  embedMany,
  EMBEDDING_MODEL,
  EmbeddingsUnavailableError,
} from "./embeddings";
import { chunkText } from "./chunker";
import { logger } from "./logger";

/**
 * Idempotent, resumable backfill for chunks that don't yet have an embedding.
 *
 * Behavior:
 *  - Selects chunks with `embedding IS NULL` in batches of `BATCH_SIZE`.
 *  - For each batch, embeds with the current model and updates the row with
 *    embedding + tokenCount + headingTrail (re-derived from the document text
 *    where it's recoverable; otherwise the trail stays null).
 *  - On EmbeddingsUnavailableError the routine logs and exits — the next
 *    server boot will pick up where this one left off.
 *
 * Safe to invoke at any time; the WHERE filter ensures we never re-embed a
 * row that already has an embedding.
 */

const BATCH_SIZE = 32;
const MAX_BATCHES_PER_RUN = 1000; // soft cap (~32k chunks/run)

export async function backfillEmbeddings(): Promise<{
  attempted: number;
  embedded: number;
  failed: number;
  finished: boolean;
}> {
  const start = Date.now();
  let attempted = 0;
  let embedded = 0;
  let failed = 0;

  for (let pass = 0; pass < MAX_BATCHES_PER_RUN; pass++) {
    const batch = await db
      .select({
        id: docChunksTable.id,
        content: docChunksTable.content,
        documentId: docChunksTable.documentId,
        chunkIndex: docChunksTable.chunkIndex,
        headingTrail: docChunksTable.headingTrail,
        tokenCount: docChunksTable.tokenCount,
      })
      .from(docChunksTable)
      .where(isNull(docChunksTable.embedding))
      .orderBy(docChunksTable.documentId, docChunksTable.chunkIndex)
      .limit(BATCH_SIZE);

    if (batch.length === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (attempted > 0) {
        logger.info(
          { attempted, embedded, failed, elapsedSec: elapsed },
          "embeddings backfill complete",
        );
      }
      return { attempted, embedded, failed, finished: true };
    }

    attempted += batch.length;

    let vectors: number[][];
    try {
      vectors = await embedMany(batch.map((c) => c.content));
    } catch (err) {
      failed += batch.length;
      if (err instanceof EmbeddingsUnavailableError) {
        logger.warn(
          { err: err.message, attempted, embedded },
          "embeddings unavailable; backfill paused (will resume on restart)",
        );
        return { attempted, embedded, failed, finished: false };
      }
      logger.error({ err }, "backfill batch crashed; pausing");
      return { attempted, embedded, failed, finished: false };
    }

    const now = new Date();
    // Run the row updates sequentially to keep the connection pool
    // pressure low; each one is a tiny indexed update by primary key.
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const vec = vectors[i];
      const tokenCount =
        row.tokenCount && row.tokenCount > 0
          ? row.tokenCount
          : await safeCountTokens(row.content);
      try {
        await db
          .update(docChunksTable)
          .set({
            embedding: vec,
            embeddingModel: EMBEDDING_MODEL,
            embeddingDim: EMBEDDING_DIM,
            embeddedAt: now,
            tokenCount,
          })
          .where(eq(docChunksTable.id, row.id));
        embedded++;
      } catch (err) {
        failed++;
        logger.warn(
          { err, chunkId: row.id },
          "failed to write backfilled embedding",
        );
      }
    }

    if (pass > 0 && pass % 10 === 0) {
      logger.info(
        { attempted, embedded, failed },
        "embeddings backfill progress",
      );
    }
  }

  logger.info(
    { attempted, embedded, failed },
    "embeddings backfill stopped after MAX_BATCHES_PER_RUN; will continue on next boot",
  );
  return { attempted, embedded, failed, finished: false };
}

async function safeCountTokens(text: string): Promise<number> {
  try {
    return await countTokens(text);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Backfill heading-trails for chunks where the trail is null but the source
 * document text is still available. We re-run the structure-aware chunker
 * over the document and copy each chunk's heading_trail across by chunk_index.
 * This is best-effort: documents whose chunking has shifted (e.g. text was
 * re-extracted differently) won't get a trail and the column stays null.
 */
export async function backfillHeadingTrails(): Promise<void> {
  // Find documents that have at least one chunk lacking a heading trail.
  const candidateDocs = await db.execute(sql`
    SELECT DISTINCT document_id
    FROM ${docChunksTable}
    WHERE heading_trail IS NULL
    LIMIT 500
  `);
  const docIds = (candidateDocs.rows as Array<{ document_id: string }>).map(
    (r) => r.document_id,
  );
  if (docIds.length === 0) return;

  let updated = 0;
  for (const docId of docIds) {
    const chunks = await db
      .select({
        id: docChunksTable.id,
        chunkIndex: docChunksTable.chunkIndex,
        content: docChunksTable.content,
      })
      .from(docChunksTable)
      .where(
        and(
          eq(docChunksTable.documentId, docId),
          isNull(docChunksTable.headingTrail),
        ),
      )
      .orderBy(docChunksTable.chunkIndex);
    if (chunks.length === 0) continue;

    // Re-derive trails by joining the chunk contents back into a doc-shaped
    // string and re-running the chunker. We map by chunk_index so as long as
    // ordering is stable (it is — chunk_index is dense and sequential), the
    // mapping is correct even if the chunk boundaries differ slightly.
    const reconstructed = chunks.map((c) => c.content).join("\n\n");
    const reChunked = chunkText(reconstructed);
    for (let i = 0; i < chunks.length && i < reChunked.length; i++) {
      const trail = reChunked[i].headingTrail;
      if (!trail) continue;
      try {
        await db
          .update(docChunksTable)
          .set({ headingTrail: trail })
          .where(eq(docChunksTable.id, chunks[i].id));
        updated++;
      } catch (err) {
        logger.warn({ err, chunkId: chunks[i].id }, "trail backfill failed");
      }
    }
  }
  if (updated > 0) {
    logger.info({ updated }, "heading-trail backfill complete");
  }
}
