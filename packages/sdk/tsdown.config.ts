import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", raw: "src/raw.ts" },
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
  fixedExtension: true,
  sourcemap: true,
  external: [/^node:/],
});
