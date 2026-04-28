import { eq, isNull, and, sql } from "drizzle-orm";
import { db, docChunksTable, documentsTable, EMBEDDING_DIM } from "@workspace/db";
import {
  countTokens,
  embedMany,
  EMBEDDING_MODEL,
  EmbeddingsUnavailableError,
} from "./embeddings";
import { chunkText, CHUNKER_MAX_CHARS } from "./chunker";
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
    // Atomically claim a batch of chunks before doing the network-bound
    // embedding work. Two concurrent backfill passes (e.g. a manual
    // trigger overlapping the boot pass) used to both SELECT the same
    // un-embedded rows and double-spend the embedder.
    //
    // The claim is structured as a CTE that takes a row-level lock with
    // SKIP LOCKED inside the subquery, so each concurrent pass only sees
    // rows no other pass currently holds. The outer UPDATE then re-checks
    // both `embedding IS NULL` and `embedding_started_at IS NULL` so any
    // pass that lost the lock-acquisition race still cannot overwrite a
    // claim another pass already committed.
    const claimDeadline = new Date();
    const claimResult = await db.execute(sql`
      WITH candidate AS (
        SELECT id FROM doc_chunks
        WHERE embedding IS NULL AND embedding_started_at IS NULL
        ORDER BY document_id, chunk_index
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE doc_chunks
      SET embedding_started_at = ${claimDeadline}
      WHERE id IN (SELECT id FROM candidate)
        AND embedding IS NULL
        AND embedding_started_at IS NULL
      RETURNING id, content, document_id, chunk_index, heading_trail, token_count
    `);
    const batch = (claimResult.rows as Array<{
      id: string;
      content: string;
      document_id: string;
      chunk_index: number;
      heading_trail: string | null;
      token_count: number | null;
    }>).map((r) => ({
      id: r.id,
      content: r.content,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      headingTrail: r.heading_trail,
      tokenCount: r.token_count,
    }));

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
      // Release the claim so the next run (or next pass) can retry the
      // same chunks instead of leaving them stranded with a populated
      // `embedding_started_at`.
      await releaseClaims(batch.map((c) => c.id));
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
            // Clear the claim so the row reflects "embedded" state cleanly
            // (started_at IS NULL AND embedding IS NOT NULL).
            embeddingStartedAt: null,
          })
          .where(eq(docChunksTable.id, row.id));
        embedded++;
      } catch (err) {
        failed++;
        // Release the claim on this single row so a future run can retry.
        await releaseClaims([row.id]);
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
 * Clear `embedding_started_at` for the given chunks so they're eligible
 * for re-claim on the next backfill pass. Safe to call with an empty
 * list and tolerates DB errors (logs and moves on).
 */
async function releaseClaims(chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  try {
    await db.execute(sql`
      UPDATE doc_chunks
      SET embedding_started_at = NULL
      WHERE id = ANY(${chunkIds}::varchar[])
    `);
  } catch (err) {
    logger.warn({ err, count: chunkIds.length }, "failed to release backfill claims");
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

/**
 * Re-chunk and re-embed any documents whose chunks were produced under the
 * old (larger) chunker budget. The previous chunker capped chunks at 800
 * tokens / ~3200 chars, but the embedder silently truncates anything past
 * 256 tokens — so the back half of those chunks never made it into the
 * vector. We now cap chunks at 250 tokens / ~1000 chars so each chunk fits
 * inside the embedder's budget end-to-end (see Task #86).
 *
 * Detection is by chunk size: if any chunk on a document exceeds the new
 * `CHUNKER_MAX_CHARS`, the document is treated as legacy and re-chunked
 * from its stored chunk text. After re-chunking, every chunk on the
 * document satisfies the new cap, so this routine becomes a no-op for that
 * document on subsequent boots — making the backfill naturally idempotent
 * and resumable without an explicit version column.
 *
 * Source text is reconstructed by joining the existing chunks; this mirrors
 * the heading-trail backfill above. The previous chunks' overlap shows up
 * as small duplicated regions in the joined text, which the new chunker
 * handles fine — at worst we emit a few extra near-boundary chunks.
 */

const REBUILD_DOC_BATCH = 8;
const REBUILD_MAX_DOCS_PER_RUN = 500;

export async function rebuildOversizedChunks(): Promise<{
  documentsChecked: number;
  documentsRebuilt: number;
  chunksWritten: number;
  chunksEmbedded: number;
  finished: boolean;
}> {
  const start = Date.now();
  let documentsChecked = 0;
  let documentsRebuilt = 0;
  let chunksWritten = 0;
  let chunksEmbedded = 0;

  for (let pass = 0; pass < REBUILD_MAX_DOCS_PER_RUN; pass++) {
    // Find one batch of documents that still have at least one oversized
    // chunk. Ordered by document_id so we make deterministic forward
    // progress across server restarts.
    const oversizedDocs = await db.execute(sql`
      SELECT document_id, MAX(char_count) AS max_chars
      FROM ${docChunksTable}
      WHERE char_count > ${CHUNKER_MAX_CHARS}
      GROUP BY document_id
      ORDER BY document_id
      LIMIT ${REBUILD_DOC_BATCH}
    `);
    const docRows = oversizedDocs.rows as Array<{
      document_id: string;
      max_chars: number;
    }>;
    if (docRows.length === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (documentsChecked > 0) {
        logger.info(
          {
            documentsChecked,
            documentsRebuilt,
            chunksWritten,
            chunksEmbedded,
            elapsedSec: elapsed,
          },
          "chunker-rebuild backfill complete",
        );
      }
      return {
        documentsChecked,
        documentsRebuilt,
        chunksWritten,
        chunksEmbedded,
        finished: true,
      };
    }

    for (const docRow of docRows) {
      documentsChecked++;
      const documentId = docRow.document_id;
      try {
        const result = await rebuildOneDocument(documentId);
        if (result) {
          documentsRebuilt++;
          chunksWritten += result.written;
          chunksEmbedded += result.embedded;
        }
      } catch (err) {
        if (err instanceof EmbeddingsUnavailableError) {
          logger.warn(
            { err: err.message, documentId, documentsRebuilt },
            "embeddings unavailable; chunker-rebuild paused (will resume on restart)",
          );
          return {
            documentsChecked,
            documentsRebuilt,
            chunksWritten,
            chunksEmbedded,
            finished: false,
          };
        }
        logger.warn(
          { err, documentId },
          "chunker-rebuild failed for document; skipping",
        );
      }
    }

    if (pass > 0 && pass % 5 === 0) {
      logger.info(
        { documentsChecked, documentsRebuilt, chunksWritten, chunksEmbedded },
        "chunker-rebuild backfill progress",
      );
    }
  }

  logger.info(
    { documentsChecked, documentsRebuilt, chunksWritten, chunksEmbedded },
    "chunker-rebuild backfill stopped after REBUILD_MAX_DOCS_PER_RUN; will continue on next boot",
  );
  return {
    documentsChecked,
    documentsRebuilt,
    chunksWritten,
    chunksEmbedded,
    finished: false,
  };
}

async function rebuildOneDocument(
  documentId: string,
): Promise<{ written: number; embedded: number } | null> {
  // Pull the document row up-front so we have the user_id for the new
  // chunk rows and can update char_count + chunk_count atomically.
  const [doc] = await db
    .select({
      id: documentsTable.id,
      userId: documentsTable.userId,
    })
    .from(documentsTable)
    .where(eq(documentsTable.id, documentId))
    .limit(1);
  if (!doc) {
    // Orphaned chunks — clean them up so we don't keep re-selecting them.
    await db
      .delete(docChunksTable)
      .where(eq(docChunksTable.documentId, documentId));
    return null;
  }

  const oldChunks = await db
    .select({
      content: docChunksTable.content,
    })
    .from(docChunksTable)
    .where(eq(docChunksTable.documentId, documentId))
    .orderBy(docChunksTable.chunkIndex);
  if (oldChunks.length === 0) return null;

  const reconstructed = oldChunks.map((c) => c.content).join("\n\n");
  const newChunks = chunkText(reconstructed);
  if (newChunks.length === 0) {
    // Defensive: shouldn't happen, but if it does don't blow away the doc.
    logger.warn(
      { documentId },
      "chunker-rebuild produced zero chunks; leaving original chunks in place",
    );
    return null;
  }

  // Embed the new chunks before we touch the DB. If embedding fails we
  // still proceed with the rewrite (chunks get embedding=NULL and the
  // embeddings backfill will catch them on the next pass), unless the
  // failure is "embedder offline" — in which case we propagate so the
  // caller can pause the whole rebuild.
  let embeddings: number[][] | null = null;
  try {
    embeddings = await embedMany(newChunks.map((c) => c.content));
  } catch (err) {
    if (err instanceof EmbeddingsUnavailableError) {
      throw err;
    }
    logger.warn(
      { err, documentId, chunkCount: newChunks.length },
      "embedding rebuilt chunks failed; chunks will be backfilled later",
    );
  }

  const tokenCounts = await Promise.all(
    newChunks.map(async (c) => {
      try {
        const t = await countTokens(c.content);
        return t > 0 ? t : c.estimatedTokens;
      } catch {
        return c.estimatedTokens;
      }
    }),
  );

  const now = new Date();
  // documents.charCount represents the *source* text length (matching the
  // ingestion path, which sets it to the extracted-text length). Using the
  // reconstructed length keeps that semantic — sum of new chunk lengths
  // would double-count the small per-boundary overlap.
  const sourceCharCount = reconstructed.length;

  await db.transaction(async (tx) => {
    await tx
      .delete(docChunksTable)
      .where(eq(docChunksTable.documentId, documentId));
    // Write in modest sub-batches so we don't blow Postgres' bind-parameter
    // limit on large documents.
    const INSERT_BATCH = 200;
    for (let start = 0; start < newChunks.length; start += INSERT_BATCH) {
      const end = Math.min(start + INSERT_BATCH, newChunks.length);
      const slice = newChunks.slice(start, end).map((c, i) => {
        const idx = start + i;
        return {
          documentId,
          userId: doc.userId,
          chunkIndex: idx,
          content: c.content,
          charCount: c.content.length,
          tokenCount: tokenCounts[idx],
          headingTrail: c.headingTrail || null,
          embedding: embeddings ? embeddings[idx] : null,
          embeddingModel: embeddings ? EMBEDDING_MODEL : null,
          embeddingDim: embeddings ? EMBEDDING_DIM : null,
          embeddedAt: embeddings ? now : null,
        };
      });
      await tx.insert(docChunksTable).values(slice);
    }
    await tx
      .update(documentsTable)
      .set({
        chunkCount: newChunks.length,
        charCount: sourceCharCount,
      })
      .where(eq(documentsTable.id, documentId));
  });

  logger.info(
    {
      documentId,
      newChunkCount: newChunks.length,
      previousChunkCount: oldChunks.length,
      embedded: embeddings ? newChunks.length : 0,
    },
    "rebuilt oversized document chunks",
  );

  return {
    written: newChunks.length,
    embedded: embeddings ? newChunks.length : 0,
  };
}
