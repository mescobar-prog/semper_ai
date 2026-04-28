import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  documentsTable,
  docChunksTable,
  ingestJobsTable,
  presetDocumentsTable,
  presetsTable,
} from "@workspace/db";
import {
  UploadTextDocumentBody,
  TestLibraryQueryBody,
  TriggerAutoIngestBody,
  SetDocumentPresetTagsBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { chunkText, searchChunks } from "../lib/rag";
import { ingestChunks } from "../lib/chunk-ingest";
import { extractDocumentText } from "../lib/document-extract";
import {
  ingestMosPackage,
  ingestUnitPackage,
} from "../lib/auto-ingest";
import { ensureActivePreset } from "../lib/profile-helpers";
import { parseAutoSource } from "@workspace/mil-data";
import { logger } from "../lib/logger";
import { processStoredDocument } from "../lib/document-processing";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { getObjectAclPolicy, setObjectAclPolicy } from "../lib/objectAcl";
import { MAX_UPLOAD_SIZE_BYTES } from "./storage";

const objectStorageService = new ObjectStorageService();

const router: IRouter = Router();

router.get("/library/stats", requireAuth, async (req, res) => {
  const [stats] = await db
    .select({
      documentCount: sql<number>`COUNT(DISTINCT ${documentsTable.id})::int`,
      chunkCount: sql<number>`COUNT(${docChunksTable.id})::int`,
      totalChars: sql<number>`COALESCE(SUM(${docChunksTable.charCount}), 0)::int`,
    })
    .from(documentsTable)
    .leftJoin(
      docChunksTable,
      eq(docChunksTable.documentId, documentsTable.id),
    )
    .where(eq(documentsTable.userId, req.user!.id));

  res.json({
    documentCount: Number(stats?.documentCount ?? 0),
    chunkCount: Number(stats?.chunkCount ?? 0),
    totalChars: Number(stats?.totalChars ?? 0),
  });
});

function serializeDocument(
  d: typeof documentsTable.$inferSelect,
  presetIds: string[] = [],
) {
  return {
    id: d.id,
    title: d.title,
    sourceFilename: d.sourceFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    charCount: d.charCount,
    chunkCount: d.chunkCount,
    status: d.status,
    autoSource: d.autoSource ?? null,
    sourceUrl: d.sourceUrl ?? null,
    errorMessage: d.errorMessage ?? null,
    uploadedAt: d.uploadedAt.toISOString(),
    processedAt: d.processedAt ? d.processedAt.toISOString() : null,
    presetIds,
  };
}

function serializeJob(j: typeof ingestJobsTable.$inferSelect) {
  return {
    id: j.id,
    source: j.source,
    status: j.status,
    totalCount: j.totalCount,
    addedCount: j.addedCount,
    existingCount: j.existingCount,
    failedCount: j.failedCount,
    errorMessage: j.errorMessage ?? null,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

async function loadDocPresetMap(
  userId: string,
  docIds: string[],
): Promise<Map<string, string[]>> {
  if (docIds.length === 0) return new Map();
  const rows = await db
    .select({
      documentId: presetDocumentsTable.documentId,
      presetId: presetDocumentsTable.presetId,
    })
    .from(presetDocumentsTable)
    .innerJoin(presetsTable, eq(presetsTable.id, presetDocumentsTable.presetId))
    .where(
      and(
        eq(presetsTable.userId, userId),
        inArray(presetDocumentsTable.documentId, docIds),
      ),
    );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.documentId) ?? [];
    arr.push(r.presetId);
    map.set(r.documentId, arr);
  }
  return map;
}

router.get("/library/documents", requireAuth, async (req, res) => {
  // Make sure the user has at least one preset (lazy migration) so brand-new
  // accounts immediately see a meaningful presetIds value on every doc.
  await ensureActivePreset(req.user!.id);

  // Optional ?presetId=... filter: when supplied, only return documents
  // that are linked to that preset (and that preset must be owned by the
  // user). An unknown/cross-user preset id silently returns [].
  const presetIdFilterRaw = req.query.presetId;
  const presetIdFilter =
    typeof presetIdFilterRaw === "string" && presetIdFilterRaw.trim().length > 0
      ? presetIdFilterRaw.trim()
      : null;

  let allowedDocIds: Set<string> | null = null;
  if (presetIdFilter) {
    const [ownedPreset] = await db
      .select({ id: presetsTable.id })
      .from(presetsTable)
      .where(
        and(
          eq(presetsTable.id, presetIdFilter),
          eq(presetsTable.userId, req.user!.id),
        ),
      )
      .limit(1);
    if (!ownedPreset) {
      res.json([]);
      return;
    }
    const linkedRows = await db
      .select({ documentId: presetDocumentsTable.documentId })
      .from(presetDocumentsTable)
      .where(eq(presetDocumentsTable.presetId, presetIdFilter));
    allowedDocIds = new Set(linkedRows.map((r) => r.documentId));
    if (allowedDocIds.size === 0) {
      res.json([]);
      return;
    }
  }

  const docs = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.userId, req.user!.id))
    .orderBy(desc(documentsTable.uploadedAt));

  const filtered = allowedDocIds
    ? docs.filter((d) => allowedDocIds!.has(d.id))
    : docs;

  const presetMap = await loadDocPresetMap(
    req.user!.id,
    filtered.map((d) => d.id),
  );
  res.json(filtered.map((d) => serializeDocument(d, presetMap.get(d.id) ?? [])));
});

router.post("/library/documents", requireAuth, async (req, res) => {
  const parsed = UploadTextDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid document upload" });
    return;
  }
  const { title, sourceFilename, mimeType, content, storageObjectPath, sizeBytes } =
    parsed.data;
  const userId = req.user!.id;

  // Path A: storage-backed binary upload — file already in GCS via presigned URL.
  // Create the document in "uploaded" state and process asynchronously.
  if (typeof storageObjectPath === "string" && storageObjectPath.length > 0) {
    if (!storageObjectPath.startsWith("/objects/")) {
      res
        .status(400)
        .json({ error: "Invalid storageObjectPath — must start with /objects/" });
      return;
    }

    if (typeof sizeBytes === "number" && sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
      res.status(413).json({
        error: `File too large. Maximum size is ${Math.floor(
          MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
        )} MB.`,
      });
      return;
    }

    // Verify the uploaded object exists and claim ownership via ACL metadata.
    // - If no ACL is set yet, this is a fresh upload — record the current user
    //   as owner so future operations on this object can be authorized.
    // - If an ACL is already set with a different owner, reject. This blocks an
    //   IDOR-style attack where one user POSTs another user's object path
    //   (paths are random UUIDs so the realistic attack surface is small, but
    //   we still defend in depth).
    let objectFile;
    try {
      objectFile = await objectStorageService.getObjectEntityFile(
        storageObjectPath,
      );
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res
          .status(404)
          .json({ error: "Uploaded file not found in object storage" });
        return;
      }
      logger.error({ err, storageObjectPath }, "failed to load uploaded object");
      res.status(500).json({ error: "Could not access uploaded file" });
      return;
    }

    try {
      const existingAcl = await getObjectAclPolicy(objectFile);
      if (existingAcl && existingAcl.owner !== userId) {
        res
          .status(403)
          .json({ error: "You do not own this uploaded file" });
        return;
      }
      if (!existingAcl) {
        await setObjectAclPolicy(objectFile, {
          owner: userId,
          visibility: "private",
        });
      }
    } catch (err) {
      logger.error({ err, storageObjectPath }, "failed to claim object ACL");
      res.status(500).json({ error: "Could not register uploaded file" });
      return;
    }

    const [doc] = await db
      .insert(documentsTable)
      .values({
        userId,
        title,
        sourceFilename,
        mimeType: mimeType || "application/octet-stream",
        sizeBytes: typeof sizeBytes === "number" ? sizeBytes : 0,
        charCount: 0,
        chunkCount: 0,
        status: "uploaded",
        storageObjectPath,
      })
      .returning();

    // Kick off background processing — do NOT await; the client will poll
    // /library/documents to watch the status field flip to "processing" and
    // then "ready" or "failed".
    void processStoredDocument(doc.id).catch((err) => {
      logger.error({ err, documentId: doc.id }, "background processing crashed");
    });

    res.json(serializeDocument(doc));
    return;
  }

  // Path B: paste-text upload — process synchronously (small payload, no GCS).
  if (typeof content !== "string" || content.length === 0) {
    res
      .status(400)
      .json({ error: "Either content or storageObjectPath must be provided" });
    return;
  }

  const buffer = Buffer.from(content, "utf-8");

  let extracted: { text: string; mimeType: string };
  try {
    extracted = await extractDocumentText({
      buffer,
      mimeType: mimeType || "text/plain",
      sourceFilename,
    });
  } catch (err) {
    logger.warn({ err, sourceFilename }, "document extraction failed");
    res.status(400).json({
      error:
        err instanceof Error
          ? `Could not extract text from document: ${err.message}`
          : "Could not extract text from document",
    });
    return;
  }

  const text = extracted.text.trim();
  if (text.length === 0) {
    res.status(400).json({
      error: "No extractable text found in this document.",
    });
    return;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    res.status(400).json({ error: "Document has no extractable text" });
    return;
  }

  const [doc] = await db
    .insert(documentsTable)
    .values({
      userId,
      title,
      sourceFilename,
      mimeType: extracted.mimeType,
      sizeBytes: buffer.byteLength,
      charCount: text.length,
      chunkCount: chunks.length,
      status: "ready",
      processedAt: new Date(),
    })
    .returning();

  try {
    const result = await ingestChunks(doc.id, userId, chunks);
    if (result.embeddingError) {
      // Document is still searchable via FTS; embeddings will be backfilled
      // on the next backfill pass. Surface the warning to the user.
      await db
        .update(documentsTable)
        .set({
          errorMessage:
            "Indexed for keyword search; semantic search will activate once embeddings finish processing.",
        })
        .where(eq(documentsTable.id, doc.id));
    }
  } catch (err) {
    logger.error({ err }, "chunk insert failed");
    await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
    res.status(500).json({ error: "Failed to index document" });
    return;
  }

  // Auto-link new uploads to the active preset so freshly uploaded material
  // is immediately part of the user's current mission scope.
  const { preset } = await ensureActivePreset(userId);
  await db
    .insert(presetDocumentsTable)
    .values({ presetId: preset.id, documentId: doc.id })
    .onConflictDoNothing();

  res.json(serializeDocument(doc, [preset.id]));
});

router.get("/library/documents/:id", requireAuth, async (req, res) => {
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.id, String(req.params.id)),
        eq(documentsTable.userId, req.user!.id),
      ),
    )
    .limit(1);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const chunks = await db
    .select()
    .from(docChunksTable)
    .where(eq(docChunksTable.documentId, doc.id))
    .orderBy(asc(docChunksTable.chunkIndex))
    .limit(20);

  const presetMap = await loadDocPresetMap(req.user!.id, [doc.id]);

  res.json({
    ...serializeDocument(doc, presetMap.get(doc.id) ?? []),
    chunks: chunks.map((c) => ({
      id: c.id,
      chunkIndex: c.chunkIndex,
      content: c.content,
      charCount: c.charCount,
    })),
  });
});

router.put(
  "/library/documents/:id/presets",
  requireAuth,
  async (req, res) => {
    const parsed = SetDocumentPresetTagsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preset tag update" });
      return;
    }
    const userId = req.user!.id;
    const docId = String(req.params.id);

    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, docId),
          eq(documentsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Restrict assignment to presets the user actually owns.
    const ownedPresets =
      parsed.data.presetIds.length === 0
        ? []
        : await db
            .select({ id: presetsTable.id })
            .from(presetsTable)
            .where(
              and(
                eq(presetsTable.userId, userId),
                inArray(presetsTable.id, parsed.data.presetIds),
              ),
            );
    const ownedPresetIds = ownedPresets.map((p) => p.id);

    await db
      .delete(presetDocumentsTable)
      .where(eq(presetDocumentsTable.documentId, docId));

    if (ownedPresetIds.length > 0) {
      await db
        .insert(presetDocumentsTable)
        .values(
          ownedPresetIds.map((pid) => ({
            presetId: pid,
            documentId: docId,
          })),
        );
    }

    res.json(serializeDocument(doc, ownedPresetIds));
  },
);

router.delete("/library/documents/:id", requireAuth, async (req, res) => {
  const result = await db
    .delete(documentsTable)
    .where(
      and(
        eq(documentsTable.id, String(req.params.id)),
        eq(documentsTable.userId, req.user!.id),
      ),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json({ success: true });
});

router.post("/library/auto-ingest", requireAuth, async (req, res) => {
  const parsed = TriggerAutoIngestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid auto-ingest request" });
    return;
  }
  const { source } = parsed.data;
  const parsedSource = parseAutoSource(source);
  if (!parsedSource) {
    res.status(400).json({ error: "Unrecognized source identifier" });
    return;
  }

  // Resolve labels for ingest helpers, which expect the user-facing branch
  // string. Both helpers return null when the curated package is empty.
  const branchLabel = parsedSource.branchCode;
  const result =
    parsedSource.kind === "mos"
      ? await ingestMosPackage(req.user!.id, branchLabel, parsedSource.identifier)
      : await ingestUnitPackage(req.user!.id, branchLabel, parsedSource.identifier);

  if (!result) {
    res.status(400).json({
      error: "No curated doctrine package available for that source",
    });
    return;
  }
  res.json(result.summary);
});

router.get("/library/auto-ingest/status", requireAuth, async (req, res) => {
  const source = String(req.query.source ?? "").trim();
  if (!source) {
    res.status(400).json({ error: "source query param is required" });
    return;
  }
  const [job] = await db
    .select()
    .from(ingestJobsTable)
    .where(
      and(
        eq(ingestJobsTable.userId, req.user!.id),
        eq(ingestJobsTable.source, source),
      ),
    )
    .orderBy(desc(ingestJobsTable.createdAt))
    .limit(1);
  res.json({ source, job: job ? serializeJob(job) : null });
});

router.post("/library/test-query", requireAuth, async (req, res) => {
  const parsed = TestLibraryQueryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const { query, limit } = parsed.data;
  const snippets = await searchChunks(
    req.user!.id,
    query,
    Math.min(Math.max(limit ?? 6, 1), 20),
  );
  res.json({ query, snippets });
});

export default router;
