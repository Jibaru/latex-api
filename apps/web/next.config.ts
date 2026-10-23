import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
