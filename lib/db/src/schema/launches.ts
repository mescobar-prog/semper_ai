import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { toolsTable } from "./catalog";

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

export type Launch = typeof launchesTable.$inferSelect;
export type LaunchToken = typeof launchTokensTable.$inferSelect;
export type SessionToken = typeof sessionTokensTable.$inferSelect;
