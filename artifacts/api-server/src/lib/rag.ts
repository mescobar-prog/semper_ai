import { sql, type SQL } from "drizzle-orm";
import { db, docChunksTable, documentsTable } from "@workspace/db";

const TARGET_CHUNK_CHARS = 900;
const MAX_CHUNK_CHARS = 1400;

export function chunkText(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (trimmed.length > MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if ((buf + " " + s).length > TARGET_CHUNK_CHARS && buf) {
          chunks.push(buf.trim());
          buf = s;
        } else {
          buf = buf ? `${buf} ${s}` : s;
        }
      }
      if (buf) chunks.push(buf.trim());
      continue;
    }

    if ((current + "\n\n" + trimmed).length > TARGET_CHUNK_CHARS && current) {
      chunks.push(current);
      current = trimmed;
    } else {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface RagSnippet {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
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
}

export async function searchChunks(
  userId: string,
  query: string,
  limit = 5,
  opts: SearchOptions = {},
): Promise<RagSnippet[]> {
  const tokens = tokenizeForOrQuery(query);
  if (tokens.length === 0) return [];

  // OR the tokens together; use ':*' for prefix matching so "uas" matches
  // both "uas" and "uass" etc. Each token already escaped (alphanumeric only).
  const tsqueryStr = tokens.map((t) => `${t}:*`).join(" | ");

  // Document-scope filter for active mission preset. Note we early-return on
  // an explicit empty list so the caller's "preset has no docs" semantics
  // produce zero results instead of being silently ignored.
  let scopeClause: SQL | undefined;
  if (opts.documentIds !== undefined) {
    if (opts.documentIds.length === 0) return [];
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
      ts_rank(
        to_tsvector('english', dc.content),
        to_tsquery('english', ${tsqueryStr})
      )                AS "score"
    FROM ${docChunksTable} dc
    JOIN ${documentsTable} d ON d.id = dc.document_id
    WHERE dc.user_id = ${userId}
      AND to_tsvector('english', dc.content) @@ to_tsquery('english', ${tsqueryStr})
      ${scopeClause ?? sql``}
    ORDER BY "score" DESC
    LIMIT ${limit}
  `);

  return (rows.rows as unknown as RagSnippet[]).map((r) => ({
    ...r,
    score: Number(r.score),
  }));
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
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, totalLimit);
}
