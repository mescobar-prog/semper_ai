import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { toolsTable } from "./catalog";

export interface LaunchSharedSnippet {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export const launchesTable = pgTable(
  "launches",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    toolId: varchar("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    status: varchar("status").notNull().default("token_issued"),
    // Profile field keys the user approved for this launch (e.g. ["branch", "rank"]).
    sharedFieldKeys: jsonb("shared_field_keys")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Frozen snapshot of the snippets the user approved for this launch. We
    // snapshot rather than re-querying so the audit trail and the eventual
    // context-exchange payload are deterministic.
    sharedSnippets: jsonb("shared_snippets")
      .$type<LaunchSharedSnippet[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Optional freeform note the user appended at preview time.
    additionalNote: text("additional_note"),
    // Optional "What will you ask this tool?" intent the operator typed on
    // the launch screen (Task #88). When present this string drove the RAG
    // primary query, so persisting it next to the audit-time snippets lets
    // admins / auditors see what task drove the search.
    launchIntent: text("launch_intent"),
    // ----- Launch-time affirmation audit (Task #45) -----------------------
    // The active mission preset and the context-block version that the user
    // affirmed-current at the moment we minted this launch token. Persisted
    // so admin / auditor views (Task #10) can show "launched with preset X,
    // context-block v7, affirmed N minutes prior". Nullable because legacy
    // rows minted before this gate landed do not have the metadata.
    presetId: varchar("preset_id"),
    contextBlockVersion: integer("context_block_version"),
    affirmedAt: timestamp("affirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true }),
  },
  (t) => [
    index("launches_user_id_idx").on(t.userId),
    index("launches_tool_id_idx").on(t.toolId),
  ],
);

export const launchTokensTable = pgTable(
  "launch_tokens",
  {
    token: varchar("token").primaryKey(),
    launchId: varchar("launch_id")
      .notNull()
      .references(() => launchesTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("launch_tokens_launch_id_idx").on(t.launchId)],
);

export const sessionTokensTable = pgTable(
  "tool_session_tokens",
  {
    token: varchar("token").primaryKey(),
    launchId: varchar("launch_id")
      .notNull()
      .references(() => launchesTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    toolId: varchar("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("tool_session_tokens_launch_id_idx").on(t.launchId)],
);

// Per-user "I have affirmed that this preset's context block is still
// current for what I'm about to do" record (Task #45). At most one row per
// user — the launch flow upserts this row whenever the user clicks the
// affirmation modal. The (presetId, contextBlockVersion) pair on the row
// is what binds the affirmation: switching active preset, editing the
// context block (which bumps its version), or letting the TTL elapse all
// invalidate the affirmation without us having to delete anything.
export const launchAffirmationsTable = pgTable(
  "launch_affirmations",
  {
    userId: varchar("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    presetId: varchar("preset_id").notNull(),
    contextBlockVersion: integer("context_block_version").notNull(),
    affirmedAt: timestamp("affirmed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
);

export type Launch = typeof launchesTable.$inferSelect;
export type LaunchToken = typeof launchTokensTable.$inferSelect;
export type SessionToken = typeof sessionTokensTable.$inferSelect;
export type LaunchAffirmation = typeof launchAffirmationsTable.$inferSelect;
