import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { documentsTable } from "./library";

export interface PresetProfileSnapshot {
  branch: string | null;
  rank: string | null;
  mosCode: string | null;
  dutyTitle: string | null;
  unit: string | null;
  baseLocation: string | null;
  securityClearance: string | null;
  deploymentStatus: string | null;
  command: string | null;
  billets: string[];
  freeFormContext: string | null;
}

export const presetsTable = pgTable(
  "presets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    profileSnapshot: jsonb("profile_snapshot")
      .$type<PresetProfileSnapshot>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("presets_user_id_idx").on(t.userId),
    uniqueIndex("presets_user_name_idx").on(t.userId, t.name),
  ],
);

export const presetDocumentsTable = pgTable(
  "preset_documents",
  {
    presetId: varchar("preset_id")
      .notNull()
      .references(() => presetsTable.id, { onDelete: "cascade" }),
    documentId: varchar("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.presetId, t.documentId] }),
    index("preset_documents_document_id_idx").on(t.documentId),
  ],
);

export type Preset = typeof presetsTable.$inferSelect;
export type InsertPreset = typeof presetsTable.$inferInsert;
export type PresetDocument = typeof presetDocumentsTable.$inferSelect;
