import { sql } from "drizzle-orm";
import {
  bigint,
  index,
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
    hostingType: varchar("hosting_type").notNull().default("cloud"),
    installerUrl: varchar("installer_url"),
    installerObjectKey: varchar("installer_object_key"),
    installerFilename: varchar("installer_filename"),
    installerSizeBytes: integer("installer_size_bytes"),
    installerPlatform: varchar("installer_platform"),
    installInstructions: text("install_instructions"),
    localLaunchUrlPattern: varchar("local_launch_url_pattern"),
    gitRepoOwner: varchar("git_repo_owner"),
    gitRepoName: varchar("git_repo_name"),
    gitDefaultBranch: varchar("git_default_branch"),
    gitLatestReleaseTag: varchar("git_latest_release_tag"),
    gitLatestCommitSha: varchar("git_latest_commit_sha"),
    gitLicenseSpdx: varchar("git_license_spdx"),
    gitStars: integer("git_stars"),
    gitLastSyncedAt: timestamp("git_last_synced_at", { withTimezone: true }),
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

// Tracks in-progress installer uploads so that an admin can resume after a
// network drop or page reload without re-uploading bytes that already made
// it to GCS. The (user_id, file_fingerprint) combination is unique among
// rows that haven't completed yet, which lets the client reconnect to a
// session by re-presenting the same file. fingerprint = `${name}|${size}|${lastModified}`.
export const installerUploadsTable = pgTable(
  "installer_uploads",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    objectKey: varchar("object_key").notNull(),
    sessionUri: text("session_uri").notNull(),
    filename: varchar("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: varchar("content_type").notNull(),
    fileFingerprint: varchar("file_fingerprint").notNull(),
    bytesUploaded: bigint("bytes_uploaded", { mode: "number" })
      .notNull()
      .default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Partial-style uniqueness simulated by adding completed_at to the key:
    // two completed rows with the same fingerprint coexist, but only one
    // pending row (completed_at IS NULL → distinct in btree across rows).
    uniqueIndex("installer_uploads_pending_idx")
      .on(t.userId, t.fileFingerprint)
      .where(sql`completed_at IS NULL`),
    index("installer_uploads_user_idx").on(t.userId),
  ],
);

export type Category = typeof categoriesTable.$inferSelect;
export type Tool = typeof toolsTable.$inferSelect;
export type InsertTool = typeof toolsTable.$inferInsert;
export type Favorite = typeof favoritesTable.$inferSelect;
export type InstallerUpload = typeof installerUploadsTable.$inferSelect;
export type InsertInstallerUpload = typeof installerUploadsTable.$inferInsert;
