import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export type ContextBlockScores = {
  doctrine: number;
  environment: number;
  constraints: number;
  experience: number;
};

// 6-element Context Block — the task-dependent verification gate operators
// must clear before launching tools. One row per user (enforced by the unique
// constraint on user_id), separate from the persistent profile so the two
// concerns can evolve independently.
export const contextBlocksTable = pgTable("context_blocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  doctrine: text("doctrine"),
  intent: text("intent"),
  environment: text("environment"),
  constraints: text("constraints"),
  risk: text("risk"),
  experience: text("experience"),
  // ----- Latest evaluator metadata --------------------------------------
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  scoreTotal: integer("score_total"),
  scores: jsonb("scores").$type<ContextBlockScores>(),
  status: varchar("status"),
  flags: text("flags"),
  submissionId: varchar("submission_id"),
  opsecFlag: varchar("opsec_flag").notNull().default("false"),
  // ----------------------------------------------------------------------
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ContextBlock = typeof contextBlocksTable.$inferSelect;
export type InsertContextBlock = typeof contextBlocksTable.$inferInsert;
