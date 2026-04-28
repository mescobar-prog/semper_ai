import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * Dimensionality of the chunk embedding vectors. Pinned to 384 because the
 * default embedding model (Xenova/all-MiniLM-L6-v2) produces 384-d vectors.
 * Changing the model in the future requires re-embedding (Task #22), which is
 * why each chunk row also stores `embeddingModel` and `embeddingDim`.
 */
export const EMBEDDING_DIM = 384;

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
    // For binary uploads (PDF/DOCX), the object-storage path of the uploaded
    // file (e.g. "/objects/uploads/<uuid>"). Null for paste-text and for
    // auto-ingested documents.
    storageObjectPath: varchar("storage_object_path"),
    // Number of times the user has manually retried processing this row.
    // 0 = never retried; >=1 = at least one retry attempt has happened.
    // Used by the UI to switch a failed auto-ingested row from a "Retry"
    // button to the "Manual upload required" fallback after the first retry.
    retryCount: integer("retry_count").notNull().default(0),
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
    // Token count as reported by the embedding model's tokenizer. Used by
    // the chunker to honour the per-chunk token budget and by the backfill
    // routine to skip work that's already been done. Nullable so old rows
    // from before the chunker upgrade aren't lost.
    tokenCount: integer("token_count"),
    // Short, human-readable trail derived from surrounding section headings,
    // e.g. "FM 3-21.8 > Ch. 4 > Reconnaissance". Used by future citation
    // rendering and ranking improvements. Nullable for the same reason.
    headingTrail: text("heading_trail"),
    // Stored embedding for semantic search. Nullable so the column can be
    // backfilled incrementally and so chunks remain queryable via FTS while
    // their embedding catches up (or when no API key is configured).
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    // Identifier of the embedding model used to produce the vector above
    // (e.g. "Xenova/all-MiniLM-L6-v2"). Combined with `embeddingDim` this
    // gives Task #22 the data it needs to detect a model change and
    // schedule a re-embed.
    embeddingModel: varchar("embedding_model"),
    embeddingDim: integer("embedding_dim"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("doc_chunks_document_id_idx").on(t.documentId),
    index("doc_chunks_user_id_idx").on(t.userId),
    // HNSW index for cosine-distance similarity search on the embedding
    // column. pgvector's `vector_cosine_ops` opclass pairs with the `<=>`
    // operator. Created via raw SQL because drizzle-orm's index builder
    // does not yet expose vector index types.
    index("doc_chunks_embedding_hnsw_idx")
      .using("hnsw", sql`${t.embedding} vector_cosine_ops`),
  ],
);

export type Document = typeof documentsTable.$inferSelect;
export type InsertDocument = typeof documentsTable.$inferInsert;
export type DocChunk = typeof docChunksTable.$inferSelect;
export type InsertDocChunk = typeof docChunksTable.$inferInsert;
export type IngestJob = typeof ingestJobsTable.$inferSelect;
export type InsertIngestJob = typeof ingestJobsTable.$inferInsert;
