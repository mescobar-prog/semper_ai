import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Most tests are quick HTTP/DB calls; the embeddings test loads a ~25 MB
    // ONNX model on first run, so we leave plenty of headroom.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
