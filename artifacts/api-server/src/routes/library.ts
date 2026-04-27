import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql, sum, count } from "drizzle-orm";
import {
  db,
  documentsTable,
  docChunksTable,
} from "@workspace/db";
import { UploadTextDocumentBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { chunkText } from "../lib/rag";
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
  const { title, sourceFilename, mimeType, content } = parsed.data;
  const userId = req.user!.id;

  const chunks = chunkText(content);
  if (chunks.length === 0) {
    res.status(400).json({ error: "Document has no extractable text" });
    return;
  }

  const sizeBytes = Buffer.byteLength(content, "utf-8");
  const charCount = content.length;

  const [doc] = await db
    .insert(documentsTable)
    .values({
      userId,
      title,
      sourceFilename,
      mimeType: mimeType || "text/plain",
      sizeBytes,
      charCount,
      chunkCount: chunks.length,
      status: "ready",
      processedAt: new Date(),
    })
    .returning();

  try {
    await db.insert(docChunksTable).values(
      chunks.map((content, idx) => ({
        documentId: doc.id,
        userId,
        chunkIndex: idx,
        content,
        charCount: content.length,
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

export default router;
