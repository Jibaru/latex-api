import { randomBytes } from "node:crypto";
import type { Engine } from "./engine";
import { InvalidProjectError } from "./errors";
import type { TemplateManifest } from "./template";

/** Every template in the public gallery is published under this license. */
export const GALLERY_LICENSE = {
  id: "CC-BY-4.0",
  name: "Creative Commons Attribution 4.0 International",
  url: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export type GalleryCategory = TemplateManifest["category"];
export const GALLERY_CATEGORIES: readonly GalleryCategory[] = [
  "paper",
  "cv",
  "brochure",
  "poster",
  "report",
  "letter",
  "other",
];

export type GallerySort = "stars" | "recent" | "relevance";

export interface GalleryAuthor {
  /** Identity provider user id (`user_...`). Never shown publicly. */
  id: string;
  /** Public display name, snapshotted when the template is published or updated. */
  name: string;
  imageUrl?: string;
}

/** A user-published template. Files, PDF and thumbnail live in the artifact store. */
export interface GalleryTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: GalleryCategory;
  tags: string[];
  engine: Engine;
  entrypoint: string;
  author: GalleryAuthor;
  license: string;
  /** Increases each time the owner uploads new files. */
  version: number;
  fileCount: number;
  totalBytes: number;
  pages?: number;
  stars: number;
  downloads: number;
  reports: number;
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** First characters of the entrypoint source, kept to re-embed after metadata edits. */
  excerpt?: string;
  /** Embedding of name, description, tags and the start of the source, for semantic search. */
  embedding?: number[];
  /** Model that produced `embedding`; vectors from another model are never compared. */
  embeddingModel?: string;
}

export const galleryKeys = {
  prefix: (id: string) => `gallery/${id}`,
  archive: (id: string, version: number) => `gallery/${id}/v${version}/project.zip`,
  pdf: (id: string, version: number) => `gallery/${id}/v${version}/preview.pdf`,
  thumbnail: (id: string, version: number) => `gallery/${id}/v${version}/thumbnail.png`,
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function newGalleryId(): string {
  let out = "gt_";
  for (const b of randomBytes(10)) out += BASE62[b % 62];
  return out;
}
export const GALLERY_ID = /^gt_[0-9A-Za-z]{10}$/;

export const GALLERY_LIMITS = {
  nameMax: 80,
  descriptionMin: 20,
  descriptionMax: 1000,
  tagsMax: 8,
  tagMax: 24,
  /** Templates a single user may publish. */
  perUser: 50,
  /** Publications (new or updated) per user per hour. */
  publishPerHour: 10,
  reportReasonMax: 500,
} as const;

export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "template"
  );
}

/** Lower-case, accents removed, `[a-z0-9-]`, deduplicated. Throws on bad input. */
export function normalizeTags(input: readonly string[]): string[] {
  const tags: string[] = [];
  for (const raw of input) {
    const tag = slugify(String(raw)).slice(0, GALLERY_LIMITS.tagMax);
    if (!tag || tag === "template") {
      if (String(raw).trim()) throw new InvalidProjectError(`Invalid tag: "${raw}"`);
      continue;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > GALLERY_LIMITS.tagsMax) {
    throw new InvalidProjectError(`At most ${GALLERY_LIMITS.tagsMax} tags`);
  }
  return tags;
}

export interface GalleryMetadataInput {
  name?: string;
  description?: string;
  category?: string;
  tags?: readonly string[];
}

export interface GalleryMetadata {
  name: string;
  description: string;
  category: GalleryCategory;
  tags: string[];
}

/** Validates metadata for a new template (all fields required except tags). */
export function validateMetadata(input: GalleryMetadataInput): GalleryMetadata {
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > GALLERY_LIMITS.nameMax) {
    throw new InvalidProjectError(`name must be 3 to ${GALLERY_LIMITS.nameMax} characters`);
  }
  const description = (input.description ?? "").trim();
  if (
    description.length < GALLERY_LIMITS.descriptionMin ||
    description.length > GALLERY_LIMITS.descriptionMax
  ) {
    throw new InvalidProjectError(
      `description must be ${GALLERY_LIMITS.descriptionMin} to ${GALLERY_LIMITS.descriptionMax} characters`,
    );
  }
  const category = (input.category ?? "other") as GalleryCategory;
  if (!GALLERY_CATEGORIES.includes(category)) {
    throw new InvalidProjectError(`category must be one of: ${GALLERY_CATEGORIES.join(", ")}`);
  }
  return { name, description, category, tags: normalizeTags(input.tags ?? []) };
}

/** Text that represents a template for semantic search. */
export function embeddingText(
  meta: Pick<GalleryTemplate, "name" | "description" | "tags" | "category">,
  source?: string,
): string {
  const head = source ? latexToText(source).slice(0, 500) : "";
  return [meta.name, meta.description, `${meta.category}. ${meta.tags.join(", ")}`, head]
    .filter(Boolean)
    .join("\n");
}

/**
 * Visible words of a LaTeX document body: no preamble, comments, commands, options, math or
 * braces. Markup makes every template look alike to the embedding model, so it is removed.
 */
export function latexToText(source: string): string {
  const begin = source.indexOf("\\begin{document}");
  const body = begin >= 0 ? source.slice(begin + "\\begin{document}".length) : source;
  return body
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, " ")
    .replace(/\\(begin|end)\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/\\./g, " ")
    .replace(/[{}[\]&~^_#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
