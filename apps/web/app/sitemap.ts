import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/shared";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    changeFrequency: "weekly" as const,
    priority: page.slugs.length === 0 ? 0.8 : 0.6,
  }));
  return [{ url: siteUrl, changeFrequency: "weekly", priority: 1 }, ...docs];
}
