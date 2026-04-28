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
import { extractDocumentText } from "../lib/document-extract";
import {
  ingestMosPackage,
  ingestUnitPackage,
} from "../lib/auto-ingest";
import { ensureActivePreset } from "../lib/profile-helpers";
import { parseAutoSource } from "@workspace/mil-data";
import { logger } from "../lib/logger";

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
  const { title, sourceFilename, mimeType, content, contentBase64 } =
    parsed.data;
  const userId = req.user!.id;

  // Determine the source bytes. Either content (UTF-8 text) or contentBase64
  // (binary, e.g. PDF/DOCX) must be provided.
  let buffer: Buffer;
  if (typeof content === "string" && content.length > 0) {
    buffer = Buffer.from(content, "utf-8");
  } else if (typeof contentBase64 === "string" && contentBase64.length > 0) {
    // Node's Buffer.from(..., 'base64') is permissive — it silently drops
    // invalid characters instead of throwing. To actually reject malformed
    // payloads we strip whitespace, require the alphabet+padding to be valid,
    // and confirm a round-trip re-encode matches the (whitespace-stripped)
    // input exactly.
    const stripped = contentBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
      res.status(400).json({ error: "Invalid base64 contentBase64 payload" });
      return;
    }
    try {
      buffer = Buffer.from(stripped, "base64");
      if (buffer.toString("base64") !== stripped) {
        res
          .status(400)
          .json({ error: "Invalid base64 contentBase64 payload" });
        return;
      }
    } catch (err) {
      logger.warn({ err }, "invalid base64 payload");
      res.status(400).json({ error: "Invalid base64 contentBase64 payload" });
      return;
    }
  } else {
    res
      .status(400)
      .json({ error: "Either content or contentBase64 must be provided" });
    return;
  }

  let extracted: { text: string; mimeType: string };
  try {
    extracted = await extractDocumentText({
      buffer,
      mimeType: mimeType || "",
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
      error:
        "No extractable text found in this document. PDFs that are scanned images or password-protected are not supported.",
    });
    return;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    res.status(400).json({ error: "Document has no extractable text" });
    return;
  }

  const sizeBytes = buffer.byteLength;
  const charCount = text.length;

  const [doc] = await db
    .insert(documentsTable)
    .values({
      userId,
      title,
      sourceFilename,
      mimeType: extracted.mimeType,
      sizeBytes,
      charCount,
      chunkCount: chunks.length,
      status: "ready",
      processedAt: new Date(),
    })
    .returning();

  try {
    await db.insert(docChunksTable).values(
      chunks.map((c, idx) => ({
        documentId: doc.id,
        userId,
        chunkIndex: idx,
        content: c,
        charCount: c.length,
      })),
    );
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
