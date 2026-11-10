import "server-only";
import { auth } from "@clerk/nextjs/server";
import { serverApiBase } from "./shared";

export type GalleryCategory =
  | "paper"
  | "cv"
  | "brochure"
  | "poster"
  | "report"
  | "letter"
  | "other";
export type GallerySort = "stars" | "recent" | "relevance";

export const CATEGORIES: Array<{ id: GalleryCategory; label: string }> = [
  { id: "paper", label: "Papers" },
  { id: "report", label: "Reports & theses" },
  { id: "cv", label: "Résumés" },
  { id: "poster", label: "Posters" },
  { id: "brochure", label: "Brochures" },
  { id: "letter", label: "Letters" },
  { id: "other", label: "Other" },
];

export interface GalleryItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: GalleryCategory;
  tags: string[];
  engine: string;
  entrypoint: string;
  author: { name: string; imageUrl?: string };
  license: { id: string; name: string; url: string };
  version: number;
  fileCount: number;
  totalBytes: number;
  pages?: number;
  stars: number;
  downloads: number;
  hidden: boolean;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
  links: { self: string; web: string; archive: string; pdf: string; thumbnail: string };
}

export interface GalleryDetail extends GalleryItem {
  canEdit: boolean;
  canModerate: boolean;
  reports?: number;
}

export interface GalleryPage {
  items: GalleryItem[];
  total: number;
  limit: number;
  offset: number;
  sort: GallerySort;
  semantic: boolean;
}

/** The signed-in user's Clerk session token, or undefined when signed out. */
export async function sessionToken(): Promise<string | undefined> {
  try {
    const { getToken } = await auth();
    return (await getToken()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function get<T>(path: string): Promise<{ data?: T; status: number }> {
  const token = await sessionToken();
  try {
    const res = await fetch(`${serverApiBase()}${path}`, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { status: res.status };
    return { data: (await res.json()) as T, status: res.status };
  } catch {
    return { status: 0 };
  }
}

export interface GalleryQuery {
  q?: string;
  tags?: string[];
  category?: string;
  sort?: GallerySort;
  mine?: boolean;
  starred?: boolean;
  limit?: number;
  offset?: number;
}

export async function searchGallery(query: GalleryQuery) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.tags?.length) params.set("tags", query.tags.join(","));
  if (query.category) params.set("category", query.category);
  if (query.sort) params.set("sort", query.sort);
  if (query.mine) params.set("mine", "true");
  if (query.starred) params.set("starred", "true");
  params.set("limit", String(query.limit ?? 24));
  if (query.offset) params.set("offset", String(query.offset));
  return get<GalleryPage>(`/v1/gallery?${params}`);
}

export async function galleryTags(limit = 24) {
  const res = await get<{ tags: Array<{ tag: string; count: number }> }>(
    `/v1/gallery/tags?limit=${limit}`,
  );
  return res.data?.tags ?? [];
}

export async function getGalleryTemplate(id: string) {
  if (!/^gt_[0-9A-Za-z]{10}$/.test(id))
    return { status: 404 } as { data?: undefined; status: number };
  return get<{ template: GalleryDetail }>(`/v1/gallery/${id}`);
}

/** API links are absolute to the public URL; the browser can use them as they are. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
