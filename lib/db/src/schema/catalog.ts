import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const categoriesTable = pgTable(
  "categories",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar("slug").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    icon: varchar("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("categories_slug_idx").on(t.slug)],
);

export const toolsTable = pgTable(
  "tools",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar("slug").notNull(),
    name: varchar("name").notNull(),
    vendor: varchar("vendor").notNull(),
    shortDescription: text("short_description").notNull(),
    longDescription: text("long_description").notNull(),
    purpose: text("purpose").notNull().default(""),
    ragQueryTemplates: jsonb("rag_query_templates")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    categoryId: varchar("category_id").references(() => categoriesTable.id, {
      onDelete: "set null",
    }),
    atoStatus: varchar("ato_status").notNull().default("in_review"),
    impactLevels: jsonb("impact_levels").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    dataClassification: varchar("data_classification").notNull().default("cui"),
    version: varchar("version"),
    badges: jsonb("badges").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    homepageUrl: varchar("homepage_url"),
    launchUrl: varchar("launch_url").notNull(),
    documentationUrl: varchar("documentation_url"),
    logoUrl: varchar("logo_url"),
    contactEmail: varchar("contact_email"),
    isActive: varchar("is_active").notNull().default("true"),
    submissionStatus: varchar("submission_status").notNull().default("approved"),
    submitterId: varchar("submitter_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewerId: varchar("reviewer_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewComment: text("review_comment"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdBy: varchar("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("tools_slug_idx").on(t.slug)],
);

export const favoritesTable = pgTable(
  "favorites",
  {
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    toolId: varchar("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.toolId] })],
);

export type Category = typeof categoriesTable.$inferSelect;
export type Tool = typeof toolsTable.$inferSelect;
export type InsertTool = typeof toolsTable.$inferInsert;
export type Favorite = typeof favoritesTable.$inferSelect;
