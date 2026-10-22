/**
 * Writes the OpenAPI document to packages/openapi/openapi.json without starting Next.js.
 * Usage: pnpm --filter @latex-api/api openapi
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PUBLIC_URL ??= "https://latex-api.crafter.run";
process.env.API_KEYS ??= "export:unused";

const { createHttpApp } = await import("../src/http/app");
const { build } = await import("../src/container");
const { loadConfig } = await import("@latex-api/infra");

const container = build(
  loadConfig({ ...process.env, DATA_DIR: path.join(process.cwd(), ".data-export") }),
);
const app = createHttpApp(() => container);
const res = await app.request("/openapi.json");
const doc = (await res.json()) as Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../../packages/openapi/openapi.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys((doc.paths as object) ?? {}).length} paths)`);
process.exit(0);
