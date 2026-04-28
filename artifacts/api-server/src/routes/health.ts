import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { semanticSearchStatus } from "../lib/embeddings";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  // Augment the parsed response (the zod schema may pass through unknown
  // keys) with a semantic-search readiness block. Operators read this when
  // they need to confirm whether the running process is serving semantic or
  // FTS-only search without tailing logs.
  const status = semanticSearchStatus();
  res.json({
    ...data,
    semanticSearch: {
      ready: status.ready,
      failed: status.failed,
      reason: status.reason,
      model: status.model,
      dim: status.dim,
    },
  });
});

export default router;
