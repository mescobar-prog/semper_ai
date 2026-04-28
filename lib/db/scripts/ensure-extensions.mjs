#!/usr/bin/env node
// Ensure required Postgres extensions exist before any schema operation
// (drizzle-kit push, app startup, etc). Drizzle-kit does not provision
// extensions on its own, so a fresh database would fail to create the
// `vector(384)` column on doc_chunks unless this runs first.
//
// Idempotent — safe to run on every push and every server boot.

import pg from "pg";

const REQUIRED_EXTENSIONS = ["vector"];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set; cannot ensure Postgres extensions.",
    );
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const ext of REQUIRED_EXTENSIONS) {
      // Identifiers in CREATE EXTENSION cannot be parameterised, but the list
      // above is a hard-coded allowlist so injection is not possible.
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[ensure-extensions] failed:", err);
  process.exit(1);
});
