import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The chunker tests are pure-function and instant; the embeddings test
    // loads a ~25 MB ONNX model and can take a while on the first run.
    testTimeout: 120_000,
    pool: "forks",
  },
});
