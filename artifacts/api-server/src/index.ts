import app from "./app";
import { logger } from "./lib/logger";
import { seedCatalog } from "./lib/seed";
import { warmEmbeddings, semanticSearchStatus } from "./lib/embeddings";
import {
  backfillEmbeddings,
  backfillHeadingTrails,
} from "./lib/embeddings-backfill";

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

seedCatalog().catch((err) => {
  logger.error({ err }, "Catalog seed failed");
});

// Warm the embedding model (so the first user query doesn't pay the cold-start
// cost) and then run the chunk-embedding backfill in the background. Both are
// best-effort; if the model can't load we run in FTS-only mode and the
// backfill will simply log + exit until the next restart.
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
    await backfillEmbeddings();
    await backfillHeadingTrails();
  } catch (err) {
    logger.error({ err }, "embeddings backfill crashed");
  }
})();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
