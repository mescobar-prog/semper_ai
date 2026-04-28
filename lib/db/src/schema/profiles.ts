import { sql } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

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
  // Combatant Command alignment (e.g. "USINDOPACOM"). Validated against the
  // curated COMBATANT_COMMANDS list in @workspace/mil-data.
  command: varchar("command"),
  // Free-text billet titles the operator currently holds (e.g.
  // "Platoon Sergeant", "S3 OPSO"). Stored as a JSON string array; UI
  // renders each entry as a removable chip.
  billets: jsonb("billets").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  freeFormContext: text("free_form_context"),
  isAdmin: varchar("is_admin").notNull().default("false"),
  // Pointer to the user's currently active mission preset (presets.id).
  // Nullable so we can lazily backfill via ensureActivePreset for users
  // created before the presets feature shipped.
  activePresetId: varchar("active_preset_id"),
  // "preview" (default) or "direct" — controls whether the launch flow opens
  // the pre-launch context preview panel or mints a token immediately. Lives
  // on profiles (persistent identity), not on the task-dependent Context
  // Block, because it's a per-operator preference that survives across
  // missions.
  launchPreference: varchar("launch_preference").notNull().default("preview"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Profile = typeof profilesTable.$inferSelect;
export type InsertProfile = typeof profilesTable.$inferInsert;
