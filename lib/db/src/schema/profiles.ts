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

export const profilesTable = pgTable("profiles", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  branch: varchar("branch"),
  rank: varchar("rank"),
  mosCode: varchar("mos_code"),
  dutyTitle: varchar("duty_title"),
  unit: varchar("unit"),
  baseLocation: varchar("base_location"),
  securityClearance: varchar("security_clearance"),
  deploymentStatus: varchar("deployment_status"),
  primaryMission: text("primary_mission"),
  aiUseCases: jsonb("ai_use_cases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  freeFormContext: text("free_form_context"),
  isAdmin: varchar("is_admin").notNull().default("false"),
  // Pointer to the user's currently active mission preset (presets.id).
  // Nullable so we can lazily backfill via ensureActivePreset for users
  // created before the presets feature shipped.
  activePresetId: varchar("active_preset_id"),
  // ----- 6-element Context Block (verification gate before catalog) -----
  cbDoctrine: text("cb_doctrine"),
  cbIntent: text("cb_intent"),
  cbEnvironment: text("cb_environment"),
  cbConstraints: text("cb_constraints"),
  cbRisk: text("cb_risk"),
  cbExperience: text("cb_experience"),
  cbConfirmedAt: timestamp("cb_confirmed_at", { withTimezone: true }),
  cbScoreTotal: integer("cb_score_total"),
  cbScores: jsonb("cb_scores").$type<ContextBlockScores>(),
  cbStatus: varchar("cb_status"),
  cbFlags: text("cb_flags"),
  cbSubmissionId: varchar("cb_submission_id"),
  cbOpsecFlag: varchar("cb_opsec_flag").notNull().default("false"),
  // ----------------------------------------------------------------------
  // "preview" (default) or "direct" — controls whether the launch flow opens
  // the pre-launch context preview panel or mints a token immediately.
  launchPreference: varchar("launch_preference").notNull().default("preview"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Profile = typeof profilesTable.$inferSelect;
export type InsertProfile = typeof profilesTable.$inferInsert;
