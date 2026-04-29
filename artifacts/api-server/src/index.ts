import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { seedCatalog } from "./lib/seed";
import { warmEmbeddings, semanticSearchStatus } from "./lib/embeddings";
import {
  backfillEmbeddings,
  backfillHeadingTrails,
  rebuildOversizedChunks,
} from "./lib/embeddings-backfill";
import { runProfileSplitMigration } from "./lib/migrate";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function bootstrap() {
  // Migration MUST complete before we serve any requests, because routes
  // (profile, dashboard, launches) read/write the new context_blocks table
  // and the new profile columns added by this migration. Failing fast here
  // is correct: a half-migrated DB would surface as undefined/500 errors on
  // first traffic.
  await runProfileSplitMigration();

  // Catalog seed is non-fatal — if it fails we still want the API up so an
  // operator can investigate via the UI/admin endpoints.
  try {
    await seedCatalog();
  } catch (err) {
    logger.error({ err }, "Catalog seed failed");
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, (err) => {
      if (err) {
        reject(err);
        return;
      }
      logger.info({ port }, "Server listening");
      resolve(s);
    });
  });

  installShutdownHandlers(server);

  // Warm the embedding model (so the first user query doesn't pay the
  // cold-start cost) and then run the chunk-embedding backfill in the
  // background. Both are best-effort; if the model can't load we run in
  // FTS-only mode and the backfill will simply log + exit until the next
  // restart. This MUST start after runProfileSplitMigration completes
  // because the backfill SELECTs columns added by that migration.
  void (async () => {
    await warmEmbeddings();
    const status = semanticSearchStatus();
    if (status.failed) {
      logger.warn(
        { reason: status.reason },
        "skipping embeddings backfill — semantic search is offline",
      );
      return;
    }
    try {
      // Re-chunk legacy documents first: their chunks were sized for the
      // old (larger) chunker and the back half of every chunk was being
      // truncated by the embedder. The in-process embedder is CPU-bound
      // and a doc with hundreds of chunks blocks the event loop long
      // enough to stall HTTP requests, so this is opt-in via env var.
      // Set RUN_CHUNK_REBUILD_ON_BOOT=1 to run it at the next boot.
      if (process.env["RUN_CHUNK_REBUILD_ON_BOOT"] === "1") {
        await rebuildOversizedChunks();
      }
      await backfillEmbeddings();
      await backfillHeadingTrails();
    } catch (err) {
      logger.error({ err }, "embeddings backfill crashed");
    }
  })();
}

function installShutdownHandlers(server: Server) {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, "second shutdown signal received — forcing exit");
      process.exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutdown started");

    // Fallback: if close() hangs on a stuck connection, exit anyway so the
    // workflow's port is freed and the next start can bind.
    const forceExit = setTimeout(() => {
      logger.warn("shutdown timed out — forcing exit");
      process.exit(0);
    }, 5000);
    forceExit.unref();

    server.close((err) => {
      if (err) {
        logger.error({ err }, "error while closing server");
      }
      logger.info("shutdown complete");
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  logger.error({ err }, "Server bootstrap failed");
  process.exit(1);
});
