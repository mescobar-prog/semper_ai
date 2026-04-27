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
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("documents_user_id_idx").on(t.userId)],
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
