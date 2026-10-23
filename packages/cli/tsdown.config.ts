import { defineConfig } from "tsdown";

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
});
