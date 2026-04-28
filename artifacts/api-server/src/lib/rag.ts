import { sql, type SQL } from "drizzle-orm";
import { db, docChunksTable, documentsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  embedOne,
  EmbeddingsUnavailableError,
  toPgVectorLiteral,
} from "./embeddings";

// Re-export the structure-aware token chunker so existing imports of
// `chunkText` from this module keep working. The new chunker returns
// `{content, estimatedTokens, headingTrail}` instead of a bare string array.
export { chunkText, type Chunk } from "./chunker";

export interface RagSnippet {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  /**
   * Cosine similarity (0-1, higher is better) when sourced from semantic
   * search; ts_rank score when sourced from FTS fallback. The two scoring
   * regimes intentionally share a field — Task #20 will introduce a unified
   * hybrid ranker on top of this. Until then, callers should treat `score` as
   * "higher is better within the same result set".
   */
  score: number;
  /** "semantic" | "fts" — lets callers / logs see which path served them. */
  source?: "semantic" | "fts";
  /** Heading trail recorded at chunk time, if any. */
  headingTrail?: string | null;
}

// Tokenize an arbitrary user/LLM query string into space-separated keywords
// safe to feed to to_tsquery as OR'd terms. We strip stopwords and
// non-alphanumeric chars and OR the lexemes together so any matching keyword
// in a chunk produces a hit (instead of plainto_tsquery's restrictive AND).
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was", "were",
  "will", "with", "this", "these", "those", "i", "we", "you", "they", "their",
  "our", "your", "into", "about", "than", "then", "if", "but", "so", "do", "does",
  "did", "not", "no", "any", "all", "some", "such", "what", "which", "who",
]);

function tokenizeForOrQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export interface SearchOptions {
  // When provided, restrict the candidate set to chunks belonging to these
  // document ids. An empty array means "no candidate documents" — we return
  // [] without touching the database, because Postgres rejects an empty IN ().
  documentIds?: string[];
  /**
   * Minimum cosine similarity required for a semantic match to count. If the
   * top hit doesn't clear this floor we fall back to FTS so users don't see
   * "the model thinks this is best, but it's actually irrelevant" results.
   * Tuned empirically for all-MiniLM-L6-v2.
   */
  minSimilarity?: number;
}

const DEFAULT_MIN_SIMILARITY = 0.2;

/**
 * Semantic-first chunk search with FTS fallback. Order of operations:
 *  1. Try to embed the query.
 *  2. Run cosine top-K against pgvector, scoped to userId (and optional
 *     documentIds).
 *  3. If the embedding step fails, the top hit is below the floor, or no
 *     hits come back, fall back to keyword (FTS) search and log it.
 *
 * Returns up to `limit` snippets ordered by similarity (or ts_rank in
 * fallback mode).
 */
export async function searchChunks(
  userId: string,
  query: string,
  limit = 5,
  opts: SearchOptions = {},
): Promise<RagSnippet[]> {
  if (opts.documentIds !== undefined && opts.documentIds.length === 0) {
    // Caller explicitly scoped to "no documents" — short-circuit for the
    // same reason the FTS branch does (Postgres rejects an empty IN list,
    // and "match nothing" is the user's intent).
    return [];
  }
  if (query.trim().length === 0) return [];

  // 1. Try semantic search first.
  try {
    const semantic = await semanticSearch(userId, query, limit, opts);
    const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    if (semantic.length > 0 && semantic[0].score >= minSim) {
      return semantic;
    }
    if (semantic.length > 0) {
      logger.info(
        { userId, topScore: semantic[0].score, minSim },
        "semantic search top hit below similarity floor; falling back to FTS",
      );
    } else {
      logger.info(
        { userId },
        "semantic search returned no candidates; falling back to FTS",
      );
    }
  } catch (err) {
    if (err instanceof EmbeddingsUnavailableError) {
      logger.warn(
        { err: err.message },
        "semantic search unavailable; falling back to FTS",
      );
    } else {
      logger.error({ err }, "semantic search crashed; falling back to FTS");
    }
  }

  // 2. FTS fallback.
  return ftsSearch(userId, query, limit, opts);
}

async function semanticSearch(
  userId: string,
  query: string,
  limit: number,
  opts: SearchOptions,
): Promise<RagSnippet[]> {
  const vec = await embedOne(query);
  const literal = toPgVectorLiteral(vec);

  let scopeClause: SQL = sql``;
  if (opts.documentIds !== undefined) {
    scopeClause = sql`AND dc.document_id IN (${sql.join(
      opts.documentIds.map((id) => sql`${id}`),
      sql`, `,
    )})`;
  }

  // pgvector's `<=>` is cosine distance (lower is better); convert to
  // similarity (1 - distance) for the unified score interface.
  const rows = await db.execute(sql`
    SELECT
      dc.id            AS "chunkId",
      dc.document_id   AS "documentId",
      d.title          AS "documentTitle",
      dc.chunk_index   AS "chunkIndex",
      dc.content       AS "content",
      dc.heading_trail AS "headingTrail",
      1 - (dc.embedding <=> ${literal}::vector) AS "score"
    FROM ${docChunksTable} dc
    JOIN ${documentsTable} d ON d.id = dc.document_id
    WHERE dc.user_id = ${userId}
      AND dc.embedding IS NOT NULL
      ${scopeClause}
    ORDER BY dc.embedding <=> ${literal}::vector
    LIMIT ${limit}
  `);

  return (rows.rows as unknown as Array<RagSnippet & { score: unknown }>).map(
    (r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      chunkIndex: r.chunkIndex,
      content: r.content,
      score: Number(r.score),
      source: "semantic" as const,
      headingTrail: r.headingTrail ?? null,
    }),
  );
}

async function ftsSearch(
  userId: string,
  query: string,
  limit: number,
  opts: SearchOptions,
): Promise<RagSnippet[]> {
  const tokens = tokenizeForOrQuery(query);
  if (tokens.length === 0) return [];

  // OR the tokens together; use ':*' for prefix matching so "uas" matches
  // both "uas" and "uass" etc. Each token already escaped (alphanumeric only).
  const tsqueryStr = tokens.map((t) => `${t}:*`).join(" | ");

  let scopeClause: SQL = sql``;
  if (opts.documentIds !== undefined) {
    scopeClause = sql`AND dc.document_id IN (${sql.join(
      opts.documentIds.map((id) => sql`${id}`),
      sql`, `,
    )})`;
  }

  const rows = await db.execute(sql`
    SELECT
      dc.id            AS "chunkId",
      dc.document_id   AS "documentId",
      d.title          AS "documentTitle",
      dc.chunk_index   AS "chunkIndex",
      dc.content       AS "content",
      dc.heading_trail AS "headingTrail",
      ts_rank(
        to_tsvector('english', dc.content),
        to_tsquery('english', ${tsqueryStr})
      )                AS "score"
    FROM ${docChunksTable} dc
    JOIN ${documentsTable} d ON d.id = dc.document_id
    WHERE dc.user_id = ${userId}
      AND to_tsvector('english', dc.content) @@ to_tsquery('english', ${tsqueryStr})
      ${scopeClause}
    ORDER BY "score" DESC
    LIMIT ${limit}
  `);

  return (rows.rows as unknown as Array<RagSnippet & { score: unknown }>).map(
    (r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      chunkIndex: r.chunkIndex,
      content: r.content,
      score: Number(r.score),
      source: "fts" as const,
      headingTrail: r.headingTrail ?? null,
    }),
  );
}

export async function searchChunksMultiQuery(
  userId: string,
  queries: string[],
  perQuery = 4,
  totalLimit = 12,
  opts: SearchOptions = {},
): Promise<RagSnippet[]> {
  const all = await Promise.all(
    queries.map((q) => searchChunks(userId, q, perQuery, opts)),
  );

  const seen = new Set<string>();
  const merged: RagSnippet[] = [];
  for (const list of all) {
    for (const s of list) {
      if (seen.has(s.chunkId)) continue;
      seen.add(s.chunkId);
      merged.push(s);
    }
  }
  // Sort by score descending. Note that FTS scores and cosine similarities
  // live on different scales — Task #20 introduces a true hybrid ranker; until
  // then, results from the same source dominate the order naturally because
  // we don't typically mix the two within one merged list (semantic returns
  // first when available, FTS only when it falls back).
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, totalLimit);
}
