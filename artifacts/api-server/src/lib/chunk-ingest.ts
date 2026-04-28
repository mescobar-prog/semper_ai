import { db, docChunksTable, EMBEDDING_DIM } from "@workspace/db";
import { logger } from "./logger";
import {
  countTokens,
  embedMany,
  EMBEDDING_MODEL,
  EmbeddingsUnavailableError,
} from "./embeddings";
import type { Chunk } from "./chunker";

export interface IngestChunksResult {
  /** Total chunks written. */
  written: number;
  /** Chunks that successfully got an embedding. */
  embedded: number;
  /** True if the embedder threw — chunks were still written, ready for backfill. */
  embeddingError: EmbeddingsUnavailableError | null;
  /** Sum of token counts (estimated when the model wasn't available). */
  totalTokens: number;
}

/**
 * Persist a batch of chunks for one document, embedding each chunk in the
 * same write where possible. If embedding fails (model unavailable, OOM,
 * etc.) the rows are still inserted with `embedding = NULL` so the backfill
 * routine can fill them in later — we never throw away extracted text.
 *
 * The caller is responsible for the document row itself; this helper only
 * touches `doc_chunks`.
 */
export async function ingestChunks(
  documentId: string,
  userId: string,
  chunks: Chunk[],
): Promise<IngestChunksResult> {
  if (chunks.length === 0) {
    return { written: 0, embedded: 0, embeddingError: null, totalTokens: 0 };
  }

  // Try to embed all chunks up-front. On failure we still persist the rows
  // so the user's text isn't lost; the backfill loop will retry embeddings.
  let embeddings: number[][] | null = null;
  let embeddingError: EmbeddingsUnavailableError | null = null;
  try {
    embeddings = await embedMany(chunks.map((c) => c.content));
  } catch (err) {
    if (err instanceof EmbeddingsUnavailableError) {
      embeddingError = err;
      logger.warn(
        { err: err.message, documentId, chunkCount: chunks.length },
        "embedding ingestion failed; chunks will be backfilled later",
      );
    } else {
      throw err;
    }
  }

  // Recompute real token counts from the model's tokenizer when possible.
  // Fall back to the chunker's estimate so the column still gets a value.
  const tokenCounts = await Promise.all(
    chunks.map(async (c) => {
      try {
        const t = await countTokens(c.content);
        return t > 0 ? t : c.estimatedTokens;
      } catch {
        return c.estimatedTokens;
      }
    }),
  );

  // drizzle-orm's vector column accepts a number[] and serializes it to a
  // proper pgvector literal under the hood. We chunk the insert so big
  // documents (e.g. 1000+ chunks) stay under Postgres' bind-parameter limit.
  const now = new Date();
  const inserted = await chunkedInsert(
    documentId,
    userId,
    chunks,
    embeddings,
    tokenCounts,
    now,
  );

  const totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0);
  if (embeddings) {
    logger.info(
      {
        documentId,
        chunkCount: inserted,
        totalTokens,
        model: EMBEDDING_MODEL,
      },
      "ingested chunks with embeddings",
    );
  }

  return {
    written: inserted,
    embedded: embeddings ? inserted : 0,
    embeddingError,
    totalTokens,
  };
}

const INSERT_BATCH = 200;

async function chunkedInsert(
  documentId: string,
  userId: string,
  chunks: Chunk[],
  embeddings: number[][] | null,
  tokenCounts: number[],
  now: Date,
): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
    const end = Math.min(start + INSERT_BATCH, chunks.length);
    const slice = chunks.slice(start, end).map((c, i) => {
      const idx = start + i;
      return {
        documentId,
        userId,
        chunkIndex: idx,
        content: c.content,
        charCount: c.content.length,
        tokenCount: tokenCounts[idx],
        headingTrail: c.headingTrail || null,
        // Drizzle accepts number[] and serializes it via the vector column's
        // mapToDriverValue — yielding a properly bound vector literal.
        embedding: embeddings ? embeddings[idx] : null,
        embeddingModel: embeddings ? EMBEDDING_MODEL : null,
        embeddingDim: embeddings ? EMBEDDING_DIM : null,
        embeddedAt: embeddings ? now : null,
      };
    });
    await db.insert(docChunksTable).values(slice);
    inserted += slice.length;
  }
  return inserted;
}
