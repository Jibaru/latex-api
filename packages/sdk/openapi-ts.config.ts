import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../openapi/openapi.json",
  output: { path: "src/client", clean: true, postProcess: [] },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/typescript",
    { name: "@hey-api/sdk", operations: { strategy: "flat" } },
  ],
});
