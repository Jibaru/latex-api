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
  // Gallery uploads go through a server action (zip of the project, up to 20 MB).
  experimental: { serverActions: { bodySizeLimit: "21mb" } },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
