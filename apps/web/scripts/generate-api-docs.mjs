// Generates one MDX page per endpoint from packages/openapi/openapi.json into
// content/docs/api/<tag>/<slug>.mdx. Runs before `next build` and `tsc`.

import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, "..", "content", "docs", "api");
const schemaPath = require.resolve("@latex-api/openapi/openapi.json");

/** Human slugs for endpoints; the schema has no operationIds. */
const names = {
  "post /v1/compile": "compile",
  "post /v1/demo/compile": "demo-compile",
  "post /v1/jobs": "create-job",
  "get /v1/jobs/{id}": "get-job",
  "delete /v1/jobs/{id}": "cancel-job",
  "get /v1/jobs/{id}/pdf": "job-pdf",
  "get /v1/jobs/{id}/log": "job-log",
  "get /v1/jobs/{id}/events": "job-events",
  "get /v1/templates": "list-templates",
  "get /v1/templates/{id}": "get-template",
  "get /v1/templates/{id}/files/{path}": "template-file",
  "get /v1/templates/{id}/archive": "template-archive",
  "get /v1/templates/{id}/preview": "template-preview",
  "post /v1/templates/{id}/compile": "template-compile",
  "post /v1/templates/{id}/jobs": "template-job",
  "get /v1/limits": "limits",
  "get /v1/stats": "stats",
  "get /health": "health",
};

const openapi = createOpenAPI({
  input: { "latex-api": schemaPath },
});

// Remove previously generated folders (keep the hand-written index.mdx / meta.json).
for (const entry of readdirSync(output, { withFileTypes: true })) {
  if (entry.isDirectory()) rmSync(path.join(output, entry.name), { recursive: true, force: true });
}

await generateFiles({
  input: openapi,
  output,
  per: "operation",
  groupBy: "tag",
  includeDescription: true,
  addGeneratedComment: true,
  name(entry) {
    if (entry.type === "operation") {
      const key = `${entry.item.method.toLowerCase()} ${entry.item.path}`;
      return names[key] ?? key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    }
    return entry.type === "webhook" ? entry.item.name : "index";
  },
});

// Sidebar titles for the per-tag folders.
const folderTitles = { compile: "Compile", jobs: "Jobs", templates: "Templates", meta: "Meta" };
for (const entry of readdirSync(output, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const title = folderTitles[entry.name] ?? entry.name;
  writeFileSync(
    path.join(output, entry.name, "meta.json"),
    `${JSON.stringify({ title }, null, 2)}\n`,
  );
}

console.log(`[web] API reference generated in ${path.relative(process.cwd(), output)}`);
