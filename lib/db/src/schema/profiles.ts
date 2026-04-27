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
  primaryMission: text("primary_mission"),
  aiUseCases: jsonb("ai_use_cases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  freeFormContext: text("free_form_context"),
  isAdmin: varchar("is_admin").notNull().default("false"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Profile = typeof profilesTable.$inferSelect;
export type InsertProfile = typeof profilesTable.$inferInsert;
