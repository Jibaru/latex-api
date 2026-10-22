import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
  },
  test: { include: ["test/**/*.integration.test.ts"], testTimeout: 300_000, hookTimeout: 300_000 },
});
