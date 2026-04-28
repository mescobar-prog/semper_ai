import { describe, it, expect, beforeAll } from "vitest";
import {
  embedMany,
  embedOne,
  countTokens,
  toPgVectorLiteral,
  semanticSearchStatus,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
} from "./embeddings";

/**
 * These tests load the all-MiniLM-L6-v2 model from disk (or fetch it from the
 * Hugging Face CDN on the very first run). They are slower than the chunker
 * tests but still well under a minute on a warm cache.
 *
 * If the runtime can't load the model (no network, ONNX bindings missing,
 * etc.) the embedMany call throws EmbeddingsUnavailableError; we test the
 * happy path here and rely on the rag.ts fallback path for the error case.
 */
describe("embeddings", () => {
  beforeAll(async () => {
    // Warm the model up-front so the first assertion isn't dragged down by
    // a 10-second cold start.
    await embedMany(["warmup"]);
  });

  it("embeds a single string into a 384-d unit vector", async () => {
    const vec = await embedOne("hello world");
    expect(vec).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    // L2-normalized so cosine = dot.
    expect(Math.abs(norm - 1)).toBeLessThan(1e-3);
  });

  it("batches: result count matches input count and order is preserved", async () => {
    const texts = ["alpha", "bravo", "charlie", "delta"];
    const out = await embedMany(texts, { batchSize: 2 });
    expect(out).toHaveLength(4);
    for (const v of out) expect(v).toHaveLength(EMBEDDING_DIM);
    // Re-embedding "alpha" alone should match the first vector closely.
    const alphaAlone = await embedOne("alpha");
    let dot = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) dot += alphaAlone[i] * out[0][i];
    expect(dot).toBeGreaterThan(0.99);
  });

  it("captures meaningful semantic similarity (paraphrase > unrelated)", async () => {
    const [a, b, c] = await embedMany([
      "drone reconnaissance",
      "unmanned aerial system surveillance",
      "best chocolate cake recipe",
    ]);
    let simParaphrase = 0;
    let simUnrelated = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      simParaphrase += a[i] * b[i];
      simUnrelated += a[i] * c[i];
    }
    // Paraphrase should beat unrelated by a clear margin. With MiniLM these
    // typically sit around 0.7 vs 0.05 — we use a loose 0.2 margin to keep
    // the test stable across model revisions.
    expect(simParaphrase).toBeGreaterThan(simUnrelated + 0.2);
  });

  it("counts tokens reasonably", async () => {
    const t = await countTokens("hello world");
    // "hello world" is two words, expect ~2-4 tokens.
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(5);
    expect(await countTokens("")).toBe(0);
  });

  it("formats pgvector literal correctly", () => {
    const lit = toPgVectorLiteral([0.1, -0.2, 0.3]);
    expect(lit).toBe("[0.100000,-0.200000,0.300000]");
  });

  it("reports ready=true after a successful embed", () => {
    const status = semanticSearchStatus();
    expect(status.ready).toBe(true);
    expect(status.failed).toBe(false);
    expect(status.model).toBe(EMBEDDING_MODEL);
    expect(status.dim).toBe(EMBEDDING_DIM);
  });
});
