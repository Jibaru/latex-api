import document from "@latex-api/openapi/openapi.json";
import type { Document } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

/**
 * Server-side OpenAPI instance. The document is imported (bundled) rather than read
 * from disk so the standalone build never depends on the monorepo layout at runtime.
 * The id must match `scripts/generate-api-docs.mjs`.
 */
export const openapi = createOpenAPI({
  input: { "latex-api": document as unknown as Document },
});
