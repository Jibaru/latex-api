import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";

/** `import text from "./file.md?raw"` embeds the file as a string (Vite/Vitest do this natively). */
const rawText = {
  name: "raw-text",
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith("?raw") || !importer) return null;
    return `${path.resolve(path.dirname(importer), source.slice(0, -4))}?raw`;
  },
  load(id: string) {
    if (!id.endsWith("?raw")) return null;
    return `export default ${JSON.stringify(readFileSync(id.slice(0, -4), "utf8"))};`;
  },
};

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node20",
  dts: false,
  clean: true,
  fixedExtension: true,
  sourcemap: false,
  shims: true,
  plugins: [rawText],
});
