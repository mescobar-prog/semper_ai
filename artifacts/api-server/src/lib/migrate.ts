import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot, idempotent schema + data migration that splits the persistent
 * profile from the task-dependent 6-element Context Block.
 *
 * Steps (each guarded so re-running is a no-op):
 *  1. Create the context_blocks table.
 *  2. Add the new persistent profile columns (command, billets).
 *  3. Copy each existing profile's cb_* / evaluation fields into a matching
 *     context_blocks row, keyed by user_id. Existing rows are not touched.
 *  4. Drop the obsolete profile columns (primary_mission, ai_use_cases, all
 *     cb_* fields).
 *
 * This runs at server boot before request serving. After a successful run
 * the live schema matches lib/db/src/schema/* and any future drizzle-kit
 * push against the same DB is a no-op.
 */
export async function runProfileSplitMigration(): Promise<void> {
  // --- 1. Create context_blocks table -----------------------------------
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS context_blocks (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      doctrine text,
      intent text,
      environment text,
      constraints text,
      risk text,
      experience text,
      confirmed_at timestamp with time zone,
      score_total integer,
      scores jsonb,
      status varchar,
      flags text,
      submission_id varchar,
      opsec_flag varchar NOT NULL DEFAULT 'false',
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  // --- 2. Add the new persistent profile columns ------------------------
  // `active_preset_id` is also ensured here because the upstream mission-
  // presets feature (Task #7) introduced it via drizzle-kit migrations,
  // which we don't run automatically on boot. Idempotent IF NOT EXISTS.
  await db.execute(sql`
    ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS command varchar,
      ADD COLUMN IF NOT EXISTS billets jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS active_preset_id varchar,
      ADD COLUMN IF NOT EXISTS launch_preference varchar NOT NULL DEFAULT 'preview',
      ADD COLUMN IF NOT EXISTS view_mode varchar NOT NULL DEFAULT 'admin'
  `);

  // --- 3. Copy cb_* and evaluation fields into context_blocks -----------
  // Only operates if the cb_doctrine column still exists on profiles. This
  // makes the data copy a no-op once the columns have been dropped on a
  // subsequent boot.
  const cbColumnExistsRow = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'cb_doctrine'
    LIMIT 1
  `);
  const cbColumnExists = (cbColumnExistsRow.rows ?? cbColumnExistsRow).length > 0;
  if (cbColumnExists) {
    // Insert one row per profile row that has anything to migrate, skipping
    // users that already have a context_blocks row (ON CONFLICT DO NOTHING).
    await db.execute(sql`
      INSERT INTO context_blocks (
        user_id, doctrine, intent, environment, constraints, risk, experience,
        confirmed_at, score_total, scores, status, flags, submission_id,
        opsec_flag
      )
      SELECT
        p.user_id,
        p.cb_doctrine, p.cb_intent, p.cb_environment, p.cb_constraints,
        p.cb_risk, p.cb_experience,
        p.cb_confirmed_at, p.cb_score_total, p.cb_scores, p.cb_status,
        p.cb_flags, p.cb_submission_id,
        COALESCE(p.cb_opsec_flag, 'false')
      FROM profiles p
      WHERE p.cb_doctrine IS NOT NULL
         OR p.cb_intent IS NOT NULL
         OR p.cb_environment IS NOT NULL
         OR p.cb_constraints IS NOT NULL
         OR p.cb_risk IS NOT NULL
         OR p.cb_experience IS NOT NULL
         OR p.cb_confirmed_at IS NOT NULL
         OR p.cb_score_total IS NOT NULL
      ON CONFLICT (user_id) DO NOTHING
    `);
    logger.info("context_blocks rows backfilled from profile cb_* columns");
  }

  // --- 3b. Ensure mission-presets tables (upstream Task #7) -------------
  // These tables ship in lib/db/src/schema/presets.ts but the only schema
  // sync we have at boot is this script — drizzle-kit push is interactive
  // and not run automatically. ensureActivePreset (called from GET /profile
  // and the launch flow) writes to both tables, so missing them surfaces
  // as 500s on every page.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS presets (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name varchar NOT NULL,
      description text,
      profile_snapshot jsonb NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS presets_user_id_idx ON presets (user_id)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS presets_user_name_idx
      ON presets (user_id, name)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS preset_documents (
      preset_id varchar NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
      document_id varchar NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY (preset_id, document_id)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS preset_documents_document_id_idx
      ON preset_documents (document_id)
  `);

  // --- 3c. Ensure tool_reviews table (upstream reviews feature) ---------
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tool_reviews (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_id varchar NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      rating integer NOT NULL,
      comment text,
      hidden_at timestamp with time zone,
      hidden_reason text,
      hidden_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tool_reviews_user_tool_idx
      ON tool_reviews (user_id, tool_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS tool_reviews_tool_id_idx
      ON tool_reviews (tool_id)
  `);

  // --- 3d. Ensure new launches columns (upstream redaction feature +
  //         Task #45 launch-time affirmation audit) ---------------------
  await db.execute(sql`
    ALTER TABLE launches
      ADD COLUMN IF NOT EXISTS shared_field_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS shared_snippets jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS additional_note text,
      ADD COLUMN IF NOT EXISTS launch_intent text,
      ADD COLUMN IF NOT EXISTS preset_id varchar,
      ADD COLUMN IF NOT EXISTS context_block_version integer,
      ADD COLUMN IF NOT EXISTS affirmed_at timestamp with time zone
  `);

  // --- 3d.1. Context-block monotonic version + launch_affirmations table
  // (Task #45). The version column is bumped every time a context_blocks
  // row is confirmed; the launch_affirmations row binds (user, preset,
  // version) for a 30-min TTL so re-launching within that window skips
  // the modal but any preset switch / cb edit / TTL elapse invalidates.
  await db.execute(sql`
    ALTER TABLE context_blocks
      ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1
  `);
  // --- 3d.2. Operator-bypass flag (Task #99). When the operator confirms
  // a sub-threshold (NO-GO, no-OPSEC) Context Block via the explicit
  // "Confirm anyway" path, the row is persisted with bypassed='true' so
  // the launch-time affirmation modal and admin audit can surface the
  // lower assurance level. OPSEC violations cannot bypass.
  await db.execute(sql`
    ALTER TABLE context_blocks
      ADD COLUMN IF NOT EXISTS bypassed varchar NOT NULL DEFAULT 'false'
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS launch_affirmations (
      user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preset_id varchar NOT NULL,
      context_block_version integer NOT NULL,
      affirmed_at timestamp with time zone NOT NULL DEFAULT now(),
      expires_at timestamp with time zone NOT NULL
    )
  `);

  // --- 3e. Ensure new documents column (upstream object-storage upload) -
  await db.execute(sql`
    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS storage_object_path varchar
  `);

  // --- 3e.1. Single-use launch tokens (Task #119 fix #6). Adds the
  // `used_at` column the launch-exchange route claims atomically so a
  // second exchange of the same token returns 401 even within the TTL.
  // Idempotent IF NOT EXISTS — older deployments boot, then this column
  // appears as NULL on existing tokens (which is the intended initial
  // state: unused).
  await db.execute(sql`
    ALTER TABLE launch_tokens
      ADD COLUMN IF NOT EXISTS used_at timestamp with time zone
  `);

  // --- 3e.2. Embeddings backfill claim column (Task #119 fix #7). Lets
  // the backfill loop atomically claim a chunk before it does the
  // network-bound embedding call, so two concurrent backfill passes
  // can't double-process the same row. Cleared on success/failure by
  // the loop itself; never bumped by ingestion.
  await db.execute(sql`
    ALTER TABLE doc_chunks
      ADD COLUMN IF NOT EXISTS embedding_started_at timestamp with time zone
  `);

  // --- 3f. Ensure new tools columns (upstream hosting + git-sync) -------
  // The toolsTable schema in lib/db/src/schema/catalog.ts grew columns for
  // self-hosted installer metadata, local launch URL templating, and
  // GitHub repo sync. INSERT ... RETURNING * fails (and surfaces as a 500
  // on POST /api/submissions) when these columns are missing in the DB.
  await db.execute(sql`
    ALTER TABLE tools
      ADD COLUMN IF NOT EXISTS hosting_type varchar NOT NULL DEFAULT 'cloud',
      ADD COLUMN IF NOT EXISTS installer_url varchar,
      ADD COLUMN IF NOT EXISTS installer_object_key varchar,
      ADD COLUMN IF NOT EXISTS installer_filename varchar,
      ADD COLUMN IF NOT EXISTS installer_size_bytes integer,
      ADD COLUMN IF NOT EXISTS installer_platform varchar,
      ADD COLUMN IF NOT EXISTS install_instructions text,
      ADD COLUMN IF NOT EXISTS local_launch_url_pattern varchar,
      ADD COLUMN IF NOT EXISTS git_repo_owner varchar,
      ADD COLUMN IF NOT EXISTS git_repo_name varchar,
      ADD COLUMN IF NOT EXISTS git_default_branch varchar,
      ADD COLUMN IF NOT EXISTS git_selected_branch varchar,
      ADD COLUMN IF NOT EXISTS git_latest_release_tag varchar,
      ADD COLUMN IF NOT EXISTS git_latest_commit_sha varchar,
      ADD COLUMN IF NOT EXISTS git_license_spdx varchar,
      ADD COLUMN IF NOT EXISTS git_stars integer,
      ADD COLUMN IF NOT EXISTS git_last_synced_at timestamp with time zone
  `);

  // --- 3g. Ensure pgvector extension + doc_chunks RAG columns -----------
  // The upstream RAG work (token-aware chunker + in-process embeddings)
  // added heading_trail / token_count / embedding / embedding_model /
  // embedding_dim / embedded_at to doc_chunks, plus an HNSW index. The
  // backfill job at boot SELECTs these columns so they must exist before
  // the first query runs.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`
    ALTER TABLE doc_chunks
      ADD COLUMN IF NOT EXISTS token_count integer,
      ADD COLUMN IF NOT EXISTS heading_trail text,
      ADD COLUMN IF NOT EXISTS embedding vector(384),
      ADD COLUMN IF NOT EXISTS embedding_model varchar,
      ADD COLUMN IF NOT EXISTS embedding_dim integer,
      ADD COLUMN IF NOT EXISTS embedded_at timestamp with time zone
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS doc_chunks_embedding_hnsw_idx
      ON doc_chunks USING hnsw (embedding vector_cosine_ops)
  `);

  // --- 4. Drop the obsolete profile columns -----------------------------
  await db.execute(sql`
    ALTER TABLE profiles
      DROP COLUMN IF EXISTS primary_mission,
      DROP COLUMN IF EXISTS ai_use_cases,
      DROP COLUMN IF EXISTS cb_doctrine,
      DROP COLUMN IF EXISTS cb_intent,
      DROP COLUMN IF EXISTS cb_environment,
      DROP COLUMN IF EXISTS cb_constraints,
      DROP COLUMN IF EXISTS cb_risk,
      DROP COLUMN IF EXISTS cb_experience,
      DROP COLUMN IF EXISTS cb_confirmed_at,
      DROP COLUMN IF EXISTS cb_score_total,
      DROP COLUMN IF EXISTS cb_scores,
      DROP COLUMN IF EXISTS cb_status,
      DROP COLUMN IF EXISTS cb_flags,
      DROP COLUMN IF EXISTS cb_submission_id,
      DROP COLUMN IF EXISTS cb_opsec_flag
  `);

  logger.info("profile-split migration complete");

  await runGitSelectedBranchBackfill();
}

/**
 * Idempotent backfill: tools imported before per-branch GitSync existed
 * stored only `git_default_branch` (the repo's default at import time).
 * Mirror that into `git_selected_branch` so the admin UI shows a branch
 * chip immediately and re-syncs target the same branch the catalog has
 * historically been hosted from. Only touches GitHub-linked tools whose
 * selected branch is still NULL — running this repeatedly is a no-op.
 */
export async function runGitSelectedBranchBackfill(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE tools
       SET git_selected_branch = git_default_branch
     WHERE git_selected_branch IS NULL
       AND git_default_branch IS NOT NULL
       AND git_repo_owner IS NOT NULL
       AND git_repo_name IS NOT NULL
  `);
  // node-postgres returns rowCount; drizzle wraps it.
  const rowCount =
    (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
  if (rowCount > 0) {
    logger.info({ rowCount }, "git_selected_branch backfill complete");
  }
}
