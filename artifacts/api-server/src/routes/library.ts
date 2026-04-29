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
  retryFailedAutoDocument,
} from "../lib/auto-ingest";
import { ensureActivePreset } from "../lib/profile-helpers";
import { parseAutoSource } from "@workspace/mil-data";
import { logger } from "../lib/logger";
import { respondInvalidRequest } from "../lib/respond";
import {
  processStoredDocument,
  retryFailedStoredDocument,
} from "../lib/document-processing";
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
    retryCount: d.retryCount ?? 0,
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
    respondInvalidRequest(
      res,
      parsed.error,
      "Invalid document upload",
      "POST /library/documents",
    );
    return;
  }
  const {
    title,
    sourceFilename,
    mimeType,
    content,
    storageObjectPath,
    sizeBytes,
    replacesDocumentId,
  } = parsed.data;
  const userId = req.user!.id;

  // If this upload is replacing a failed auto-ingested row, validate the
  // target up front and grab the metadata we need to inherit (autoSource,
  // sourceUrl, preset tags). Doing this before any heavy lifting keeps the
  // error path simple.
  let supersedeTarget: typeof documentsTable.$inferSelect | null = null;
  let inheritedPresetIds: string[] = [];
  if (typeof replacesDocumentId === "string" && replacesDocumentId.length > 0) {
    const [target] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, replacesDocumentId),
          eq(documentsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!target) {
      res
        .status(404)
        .json({ error: "Document to be replaced not found" });
      return;
    }
    if (target.status !== "failed") {
      res.status(400).json({
        error: "Can only supersede a document that is in the failed state",
      });
      return;
    }
    if (!target.autoSource) {
      res.status(400).json({
        error: "Can only supersede an auto-ingested document",
      });
      return;
    }
    supersedeTarget = target;
    const presetMap = await loadDocPresetMap(userId, [target.id]);
    inheritedPresetIds = presetMap.get(target.id) ?? [];
  }

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

    // When superseding a failed auto row, delete the old row + create the
    // new one + carry over preset tags inside a single transaction so the
    // user never sees a duplicate or a moment with neither row.
    const doc = await db.transaction(async (tx) => {
      if (supersedeTarget) {
        await tx
          .delete(documentsTable)
          .where(eq(documentsTable.id, supersedeTarget.id));
      }
      const [newDoc] = await tx
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
          autoSource: supersedeTarget?.autoSource ?? null,
          sourceUrl: supersedeTarget?.sourceUrl ?? null,
        })
        .returning();
      if (supersedeTarget && inheritedPresetIds.length > 0) {
        await tx
          .insert(presetDocumentsTable)
          .values(
            inheritedPresetIds.map((pid) => ({
              presetId: pid,
              documentId: newDoc.id,
            })),
          )
          .onConflictDoNothing();
      }
      return newDoc;
    });

    // Kick off background processing — do NOT await; the client will poll
    // /library/documents to watch the status field flip to "processing" and
    // then "ready" or "failed".
    void processStoredDocument(doc.id).catch((err) => {
      logger.error({ err, documentId: doc.id }, "background processing crashed");
    });

    res.json(serializeDocument(doc, inheritedPresetIds));
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

  // For non-supersede uploads we auto-link into the active preset (so the
  // new doc is immediately in scope). For supersede uploads we instead
  // inherit the failed row's preset tags exactly.
  const { preset } = supersedeTarget
    ? { preset: null as { id: string } | null }
    : await ensureActivePreset(userId);

  // Atomically delete the failed supersede target (if any) and insert the
  // replacement row in `processing` state, so the user never observes a
  // duplicate or empty gap and never sees a "ready" doc with zero chunks
  // if ingestion subsequently fails. Embedding ingestion happens after
  // this transaction because it issues network calls that must not run
  // inside a DB transaction; we only flip the row to `ready` once that
  // succeeds.
  const doc = await db.transaction(async (tx) => {
    if (supersedeTarget) {
      await tx
        .delete(documentsTable)
        .where(eq(documentsTable.id, supersedeTarget.id));
    }
    const [newDoc] = await tx
      .insert(documentsTable)
      .values({
        userId,
        title,
        sourceFilename,
        mimeType: extracted.mimeType,
        sizeBytes: buffer.byteLength,
        charCount: text.length,
        chunkCount: chunks.length,
        status: "processing",
        autoSource: supersedeTarget?.autoSource ?? null,
        sourceUrl: supersedeTarget?.sourceUrl ?? null,
      })
      .returning();
    return newDoc;
  });

  let postIngestDoc = doc;
  try {
    const result = await ingestChunks(doc.id, userId, chunks);
    // Ingest succeeded — promote the row to `ready`. If embeddings were
    // unavailable, the chunks are still written and FTS still works, so
    // we mark the doc ready but surface a non-fatal warning.
    const errorMessage = result.embeddingError
      ? "Indexed for keyword search; semantic search will activate once embeddings finish processing."
      : null;
    const [updated] = await db
      .update(documentsTable)
      .set({
        status: "ready",
        processedAt: new Date(),
        errorMessage,
      })
      .where(eq(documentsTable.id, doc.id))
      .returning();
    if (updated) postIngestDoc = updated;
  } catch (err) {
    logger.error({ err, documentId: doc.id }, "chunk insert failed");
    // Mark the row failed instead of deleting it so the user can retry
    // from the UI rather than re-pasting their text. Match the wording
    // surfaced by the document-processing pipeline for consistency.
    await db
      .update(documentsTable)
      .set({
        status: "failed",
        errorMessage: "Failed to index extracted text.",
        processedAt: new Date(),
      })
      .where(eq(documentsTable.id, doc.id));
    res.status(500).json({ error: "Failed to index document" });
    return;
  }

  // For supersede uploads, inherit the failed row's preset tags exactly.
  // For fresh uploads, auto-link into the active preset so the doc is
  // immediately in mission scope.
  const presetIdsToLink = supersedeTarget
    ? inheritedPresetIds
    : preset
      ? [preset.id]
      : [];
  if (presetIdsToLink.length > 0) {
    await db
      .insert(presetDocumentsTable)
      .values(
        presetIdsToLink.map((pid) => ({
          presetId: pid,
          documentId: doc.id,
        })),
      )
      .onConflictDoNothing();
  }

  res.json(serializeDocument(postIngestDoc, presetIdsToLink));
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
      respondInvalidRequest(
        res,
        parsed.error,
        "Invalid preset tag update",
        "PUT /library/documents/:id/preset-tags",
      );
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

    // Atomic delete + insert so a crash mid-update never leaves the doc
    // with no tags. Both writes commit or neither does.
    await db.transaction(async (tx) => {
      await tx
        .delete(presetDocumentsTable)
        .where(eq(presetDocumentsTable.documentId, docId));

      if (ownedPresetIds.length > 0) {
        await tx
          .insert(presetDocumentsTable)
          .values(
            ownedPresetIds.map((pid) => ({
              presetId: pid,
              documentId: docId,
            })),
          );
      }
    });

    res.json(serializeDocument(doc, ownedPresetIds));
  },
);

// Cap how many times a user can retry an in-place upload extraction before
// we force them to re-upload the file. Two attempts is enough to recover
// from a transient extractor / embedding hiccup; beyond that the file is
// almost certainly the problem (corrupt, password-protected, etc.).
const MAX_UPLOAD_RETRIES = 2;

router.post("/library/documents/:id/retry", requireAuth, async (req, res) => {
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
  if (doc.status !== "failed") {
    res.status(400).json({
      error: "Only failed documents can be retried",
    });
    return;
  }

  // Path A — user-uploaded doc backed by an object-storage blob. Re-runs
  // extraction against the existing GCS object. Capped so a user with a
  // truly bad file isn't stuck retrying forever.
  if (doc.storageObjectPath) {
    if ((doc.retryCount ?? 0) >= MAX_UPLOAD_RETRIES) {
      res.status(400).json({
        error:
          "Already retried this upload twice without success. Please delete it and upload the file again.",
      });
      return;
    }
    const updated = await retryFailedStoredDocument(doc);
    const presetMap = await loadDocPresetMap(userId, [updated.id]);
    res.json(serializeDocument(updated, presetMap.get(updated.id) ?? []));
    return;
  }

  // Path B — auto-ingested doctrine doc. Re-runs the original URL fetch +
  // extract pipeline.
  if (doc.autoSource && doc.sourceUrl) {
    const updated = await retryFailedAutoDocument(doc);
    const presetMap = await loadDocPresetMap(userId, [updated.id]);
    res.json(serializeDocument(updated, presetMap.get(updated.id) ?? []));
    return;
  }

  res.status(400).json({
    error:
      "This document has no retryable source (no stored upload and no auto-ingest URL).",
  });
});

// Bounded character budget for the doctrine-picker snippet (Task #85).
// Sized so multiple selections in the Context Block textbox don't blow past
// reasonable evaluator/textarea limits, while still pasting enough actual
// doctrine text (not just a citation) to be useful.
const SNIPPET_CHAR_BUDGET = 1500;

// Returns a representative text excerpt for a single document, used by the
// Doctrine & Orders picker on the Catalog page. We pull the first 1–2 chunks
// (the ones most likely to contain the document's title page / overview /
// purpose statement), concatenate them, and cap at SNIPPET_CHAR_BUDGET so a
// single selection can't dominate the textarea.
router.get(
  "/library/documents/:id/snippet",
  requireAuth,
  async (req, res) => {
    const docId = String(req.params.id);
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, docId),
          eq(documentsTable.userId, req.user!.id),
        ),
      )
      .limit(1);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (doc.status !== "ready") {
      res.status(400).json({
        error: `Document is not ready yet (status: ${doc.status}).`,
      });
      return;
    }

    const chunks = await db
      .select({ content: docChunksTable.content })
      .from(docChunksTable)
      .where(eq(docChunksTable.documentId, doc.id))
      .orderBy(asc(docChunksTable.chunkIndex))
      .limit(2);

    if (chunks.length === 0) {
      res
        .status(400)
        .json({ error: "Document has no extractable chunks." });
      return;
    }

    const joined = chunks.map((c) => c.content.trim()).join("\n\n");
    let snippet = joined;
    let truncated = false;
    if (snippet.length > SNIPPET_CHAR_BUDGET) {
      snippet = snippet.slice(0, SNIPPET_CHAR_BUDGET).trimEnd();
      truncated = true;
    } else if (doc.chunkCount > chunks.length) {
      // Document continues beyond the chunks we sampled — flag truncation
      // even though we didn't hit the byte cap, so the UI can render a "…"
      // marker indicating there's more doctrine the user could review.
      truncated = true;
    }

    res.json({
      documentId: doc.id,
      title: doc.title,
      snippet,
      truncated,
      charCount: snippet.length,
    });
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

  // Best-effort delete of the underlying object-storage blob so we don't
  // accumulate orphans. Tolerate ObjectNotFoundError (already gone) and
  // any storage-layer failure — the document row is the source of truth
  // and is already deleted, so we surface success regardless.
  const deleted = result[0];
  if (deleted.storageObjectPath) {
    try {
      await objectStorageService.deleteObjectEntity(deleted.storageObjectPath);
    } catch (err) {
      logger.warn(
        { err, documentId: deleted.id, storageObjectPath: deleted.storageObjectPath },
        "failed to delete document blob from object storage; row already deleted",
      );
    }
  }

  res.json({ success: true });
});

router.post("/library/auto-ingest", requireAuth, async (req, res) => {
  const parsed = TriggerAutoIngestBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalidRequest(
      res,
      parsed.error,
      "Invalid auto-ingest request",
      "POST /library/auto-ingest",
    );
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
    respondInvalidRequest(
      res,
      parsed.error,
      "Invalid query",
      "POST /library/test-query",
    );
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
