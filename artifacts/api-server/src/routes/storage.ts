import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Allowed library document types. Keep in sync with the file picker
// `accept` attribute in artifacts/marketplace/src/pages/Library.tsx and
// extractDocumentText() in artifacts/api-server/src/lib/document-extract.ts.
const ALLOWED_UPLOAD_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
  // Some browsers report markdown as one of these:
  "text/x-markdown",
  "application/octet-stream", // fallback when browser can't sniff (e.g. .md on Windows)
]);

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", requireAuth, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  const { name, size, contentType } = parsed.data;

  if (typeof size === "number" && size > MAX_UPLOAD_SIZE_BYTES) {
    res.status(413).json({
      error: `File too large. Maximum size is ${Math.floor(
        MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
      )} MB.`,
    });
    return;
  }

  if (contentType && !ALLOWED_UPLOAD_MIME_TYPES.has(contentType)) {
    res.status(415).json({
      error:
        "Unsupported file type. Allowed: PDF, DOCX, Markdown (.md), or plain text (.txt).",
    });
    return;
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*filePath
 *
 * Serve admin-uploaded installer binaries (and other private object-entity
 * uploads) to authenticated marketplace users. Personal-library uploads are
 * intentionally NOT served from here — those are processed entirely
 * server-side via the SDK in lib/document-processing.ts.
 *
 * The Catalog API serializes installer download URLs as
 * `/api/storage/objects/<objectKey>`, so this endpoint is the authenticated
 * source for that link. We require auth so installer binaries don't leak to
 * unauthenticated visitors.
 */
router.get(
  "/storage/objects/*filePath",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${filePath}`;
      const file = await objectStorageService.getObjectEntityFile(objectPath);
      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, "Error serving private object");
      const status =
        error instanceof Error && error.name === "ObjectNotFoundError"
          ? 404
          : 500;
      res
        .status(status)
        .json({ error: status === 404 ? "File not found" : "Failed to serve object" });
    }
  },
);

export default router;
