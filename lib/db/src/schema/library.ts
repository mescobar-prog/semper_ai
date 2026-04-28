import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const documentsTable = pgTable(
  "documents",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    title: varchar("title").notNull(),
    sourceFilename: varchar("source_filename").notNull(),
    mimeType: varchar("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    charCount: integer("char_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    status: varchar("status").notNull().default("processing"),
    errorMessage: text("error_message"),
    // Where this document originated from. Null for normal user uploads;
    // set to a stable identifier like "mos:army:11B" or "unit:marines:MALS-12"
    // for documents pulled in by the auto-ingest pipeline. Combined with
    // sourceUrl this lets us de-duplicate re-ingests of the same package.
    autoSource: varchar("auto_source"),
    sourceUrl: text("source_url"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("documents_user_id_idx").on(t.userId),
    index("documents_auto_source_idx").on(t.userId, t.autoSource),
  ],
);

export const ingestJobsTable = pgTable(
  "ingest_jobs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Same shape as documentsTable.autoSource (e.g. "mos:army:11B").
    source: varchar("source").notNull(),
    // "running" | "done" | "failed".
    status: varchar("status").notNull().default("running"),
    totalCount: integer("total_count").notNull().default(0),
    addedCount: integer("added_count").notNull().default(0),
    existingCount: integer("existing_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("ingest_jobs_user_source_idx").on(t.userId, t.source)],
);

export const docChunksTable = pgTable(
  "doc_chunks",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: varchar("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    charCount: integer("char_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("doc_chunks_document_id_idx").on(t.documentId),
    index("doc_chunks_user_id_idx").on(t.userId),
  ],
);

export type Document = typeof documentsTable.$inferSelect;
export type InsertDocument = typeof documentsTable.$inferInsert;
export type DocChunk = typeof docChunksTable.$inferSelect;
export type InsertDocChunk = typeof docChunksTable.$inferInsert;
export type IngestJob = typeof ingestJobsTable.$inferSelect;
export type InsertIngestJob = typeof ingestJobsTable.$inferInsert;
