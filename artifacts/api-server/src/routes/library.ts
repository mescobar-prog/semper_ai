import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  documentsTable,
  docChunksTable,
} from "@workspace/db";
import { UploadTextDocumentBody, TestLibraryQueryBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { chunkText, searchChunks } from "../lib/rag";
import { extractDocumentText } from "../lib/document-extract";
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

function serializeDocument(d: typeof documentsTable.$inferSelect) {
  return {
    id: d.id,
    title: d.title,
    sourceFilename: d.sourceFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    charCount: d.charCount,
    chunkCount: d.chunkCount,
    status: d.status,
    uploadedAt: d.uploadedAt.toISOString(),
    processedAt: d.processedAt ? d.processedAt.toISOString() : null,
  };
}

router.get("/library/documents", requireAuth, async (req, res) => {
  const docs = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.userId, req.user!.id))
    .orderBy(desc(documentsTable.uploadedAt));
  res.json(docs.map(serializeDocument));
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

  res.json(serializeDocument(doc));
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

  res.json({
    ...serializeDocument(doc),
    chunks: chunks.map((c) => ({
      id: c.id,
      chunkIndex: c.chunkIndex,
      content: c.content,
      charCount: c.charCount,
    })),
  });
});

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
