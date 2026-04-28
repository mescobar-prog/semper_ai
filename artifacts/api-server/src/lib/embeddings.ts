import { logger } from "./logger";

/**
 * Identifier of the embedding model in use. Stored on every embedded chunk so
 * Task #22 (model upgrades) can detect drift and schedule re-embeds. Pick a
 * lightweight 384-d model so the bundle stays small and CPU inference stays
 * fast (~10-30 ms per short doc on a single core).
 */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

/**
 * Hard cap the model will accept; longer inputs are truncated by the
 * tokenizer. Our chunker targets ~500 tokens with an 800-token cap, so
 * truncation is rare.
 */
const MODEL_MAX_TOKENS = 256;

/**
 * Default batch size for `embedMany`. all-MiniLM-L6-v2 is small enough that
 * larger batches buy us very little; keep it modest so we don't hold a 128-row
 * batch's worth of memory hostage during ingestion.
 */
const DEFAULT_BATCH_SIZE = 16;

/**
 * Thrown when the embedding pipeline cannot be loaded or invoked. Callers
 * (search, ingestion) catch this to fall back to FTS / mark a doc as
 * "embedding pending" instead of crashing the request.
 */
export class EmbeddingsUnavailableError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "EmbeddingsUnavailableError";
  }
}

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean" | "cls" | "none"; normalize: boolean },
) => Promise<{
  data: Float32Array;
  dims: number[];
  size: number;
}>;

type Tokenizer = (
  texts: string[],
  options?: { padding?: boolean; truncation?: boolean },
) => { input_ids: { dims: number[] } };

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let tokenizerPromise: Promise<Tokenizer> | null = null;
// Latched once we've successfully invoked the pipeline once. Used by
// `isSemanticSearchActive` so the /healthz endpoint can answer truthfully
// without paying for a real inference call.
let semanticReady = false;
// Latched once we've conclusively failed to load the pipeline. Once latched,
// further calls short-circuit so we don't waste seconds re-loading on every
// request — the user has to fix the underlying problem and restart.
let semanticFailed: { reason: string } | null = null;

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  if (semanticFailed) {
    throw new EmbeddingsUnavailableError(semanticFailed.reason);
  }
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      try {
        const transformers = await import("@xenova/transformers");
        // Disable the local-files-only path; transformers.js will pull the
        // model from the Hugging Face CDN on first run and cache it under
        // `node_modules/@xenova/transformers/.cache` for subsequent boots.
        transformers.env.allowLocalModels = false;
        // Quantized int8 weights cut the download to ~25 MB and roughly
        // halve cold-start memory at a negligible accuracy hit on retrieval.
        const pipeline = await transformers.pipeline(
          "feature-extraction",
          EMBEDDING_MODEL,
          { quantized: true },
        );
        return pipeline as unknown as FeatureExtractionPipeline;
      } catch (err) {
        const reason =
          err instanceof Error
            ? `Failed to load embedding model: ${err.message}`
            : "Failed to load embedding model";
        semanticFailed = { reason };
        // Reset so a retry after a fix can attempt again.
        pipelinePromise = null;
        throw new EmbeddingsUnavailableError(reason, err);
      }
    })();
  }
  return pipelinePromise;
}

async function loadTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const transformers = await import("@xenova/transformers");
      const tok = await transformers.AutoTokenizer.from_pretrained(
        EMBEDDING_MODEL,
        { quantized: true },
      );
      return tok as unknown as Tokenizer;
    })();
  }
  return tokenizerPromise;
}

/**
 * Count tokens for one or more strings using the model's own tokenizer. The
 * chunker uses this to size chunks against the model's real budget instead of
 * a character-count proxy that wildly mis-estimates code/acronym-heavy text.
 */
export async function countTokens(text: string): Promise<number> {
  if (text.length === 0) return 0;
  try {
    const tok = await loadTokenizer();
    const enc = tok([text], { padding: false, truncation: false });
    // input_ids shape is [1, seq_len]; subtract 2 for [CLS]/[SEP].
    const seqLen = enc.input_ids.dims[1] ?? 0;
    return Math.max(0, seqLen - 2);
  } catch (err) {
    // Fall back to a coarse approximation (≈ chars / 4) so callers aren't
    // forced to handle this; chunker correctness is preserved by the hard
    // character cap layered on top of the token cap.
    logger.warn({ err }, "tokenizer unavailable; using char-based estimate");
    return Math.ceil(text.length / 4);
  }
}

/**
 * Embed a batch of texts. Returns a parallel array of 384-d unit vectors
 * (already L2-normalized so cosine similarity is just a dot product).
 *
 * Throws `EmbeddingsUnavailableError` if the pipeline cannot be loaded;
 * callers (search, ingestion) catch this to fall back gracefully.
 */
export async function embedMany(
  texts: string[],
  opts: { batchSize?: number } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipeline = await loadPipeline();
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);

  const out: number[][] = new Array(texts.length);
  for (let start = 0; start < texts.length; start += batchSize) {
    const slice = texts.slice(start, start + batchSize);
    // Mean-pool over the token embeddings + L2-normalize so cosine = dot.
    const result = await runWithRetry(() =>
      pipeline(slice, { pooling: "mean", normalize: true }),
    );
    const dim = result.dims[result.dims.length - 1] ?? EMBEDDING_DIM;
    if (dim !== EMBEDDING_DIM) {
      throw new EmbeddingsUnavailableError(
        `Unexpected embedding dim ${dim}; expected ${EMBEDDING_DIM}`,
      );
    }
    for (let i = 0; i < slice.length; i++) {
      const offset = i * dim;
      const vec = new Array<number>(dim);
      for (let j = 0; j < dim; j++) vec[j] = result.data[offset + j];
      out[start + i] = vec;
    }
  }
  semanticReady = true;
  return out;
}

/**
 * Convenience wrapper for the single-input case used by search-time query
 * embedding. Returns a single vector or throws `EmbeddingsUnavailableError`.
 */
export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedMany([text]);
  return v;
}

/**
 * Format a JS number array as a pgvector literal (`[0.1,0.2,...]`). pg's
 * pgvector driver accepts text in this shape and parses it into a `vector`.
 */
export function toPgVectorLiteral(vec: number[]): string {
  // Use 6 significant digits to keep the wire payload small without losing
  // meaningful retrieval precision.
  return `[${vec.map((v) => v.toFixed(6)).join(",")}]`;
}

async function runWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Bounded exponential backoff: 200 ms, 400 ms.
      const wait = 200 * Math.pow(2, i);
      logger.warn({ err, attempt: i + 1, wait }, "embedding call failed; retrying");
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr instanceof Error
    ? new EmbeddingsUnavailableError(
        `Embedding pipeline failed after ${attempts} attempts: ${lastErr.message}`,
        lastErr,
      )
    : new EmbeddingsUnavailableError("Embedding pipeline failed");
}

/**
 * Quickly tells callers whether semantic search is currently active. Used by
 * `/healthz`, the startup banner, and the search-fallback log line.
 */
export function semanticSearchStatus(): {
  ready: boolean;
  failed: boolean;
  reason: string | null;
  model: string;
  dim: number;
  maxInputTokens: number;
} {
  return {
    ready: semanticReady,
    failed: !!semanticFailed,
    reason: semanticFailed?.reason ?? null,
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    maxInputTokens: MODEL_MAX_TOKENS,
  };
}

/**
 * Eagerly load the model so the first user-facing search doesn't pay the
 * cold-start cost. Safe to call on a fire-and-forget basis at server boot.
 * Logs success / failure so operators can see in startup logs whether
 * semantic search is active.
 */
export async function warmEmbeddings(): Promise<void> {
  try {
    await embedMany(["warmup"], { batchSize: 1 });
    logger.info(
      { model: EMBEDDING_MODEL, dim: EMBEDDING_DIM },
      "semantic search active (in-process embeddings)",
    );
  } catch (err) {
    logger.warn(
      { err, model: EMBEDDING_MODEL },
      "semantic search disabled; falling back to keyword (FTS) search",
    );
  }
}
