import { sql } from "drizzle-orm";
import { db } from "./index";

// Required Postgres extensions for our schema. `vector` powers the pgvector
// embedding column on doc_chunks plus its HNSW index; without it
// `vector(384)` and the `<=>` operator are unrecognised types/operators.
const REQUIRED_EXTENSIONS = ["vector"] as const;

let ensurePromise: Promise<void> | null = null;

/**
 * Idempotently create any Postgres extensions our schema relies on.
 * Memoised so repeated callers (server startup, test setup) only hit the DB
 * once per process.
 */
export async function ensureExtensions(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    for (const ext of REQUIRED_EXTENSIONS) {
      // Identifier cannot be parameterised, but `REQUIRED_EXTENSIONS` is a
      // hard-coded allowlist so injection is impossible.
      await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS ${ext}`));
    }
  })().catch((err) => {
    // Reset so a future call retries instead of permanently failing.
    ensurePromise = null;
    throw err;
  });
  return ensurePromise;
}
