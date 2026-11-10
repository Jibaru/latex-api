// Runs PgGalleryRepository and the migrations against real Postgres (PGlite, in-process WASM),
// so SQL mistakes such as untyped parameters fail here instead of in production.
import { PGlite } from "@electric-sql/pglite";
import type { GalleryTemplate } from "@latex-api/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgGalleryRepository } from "../src/gallery-repositories";
import { migrate } from "../src/pg/client";

let db: PGlite;
let pool: pg.Pool;

/** The subset of pg.Pool the repository and the migrator use. */
function poolFor(lite: PGlite): pg.Pool {
  const query = async (text: string, params?: unknown[]) => {
    if (!params?.length && /;\s*\S/.test(text.trim())) {
      const results = await lite.exec(text);
      const last = results[results.length - 1];
      return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
    }
    const res = await lite.query(text, params as never[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  };
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as pg.Pool;
}

function template(id: string, overrides: Partial<GalleryTemplate> = {}): GalleryTemplate {
  const now = new Date("2026-11-10T12:00:00Z");
  return {
    id,
    slug: "tesis",
    name: "Tesis",
    description: "Plantilla de tesis con normas APA 7.",
    category: "report",
    tags: ["tesis", "apa"],
    engine: "pdflatex",
    entrypoint: "main.tex",
    author: { id: "user_a", name: "Ana" },
    license: "CC-BY-4.0",
    version: 1,
    fileCount: 3,
    totalBytes: 1200,
    pages: 4,
    stars: 0,
    downloads: 0,
    reports: 0,
    hidden: false,
    createdAt: now,
    updatedAt: now,
    excerpt: "Introducción",
    embedding: [0.1, 0.2, 0.3],
    embeddingModel: "m1",
    ...overrides,
  };
}

describe("PgGalleryRepository on Postgres", () => {
  beforeAll(async () => {
    db = new PGlite();
    pool = poolFor(db);
    await migrate(pool);
  });
  afterAll(async () => {
    await db.close();
  });

  it("inserts, updates without touching counters, and reads back", async () => {
    const repo = new PgGalleryRepository(pool);
    await repo.insert(template("gt_aaaaaaaaaa"));
    expect(await repo.star("gt_aaaaaaaaaa", "user_b", new Date())).toBe(true);
    expect(await repo.star("gt_aaaaaaaaaa", "user_b", new Date())).toBe(false);
    await repo.incrementDownloads("gt_aaaaaaaaaa");

    // A stale copy (stars 0, downloads 0) must not reset the counters.
    await repo.update(
      template("gt_aaaaaaaaaa", { version: 2, name: "Tesis v2", embeddingModel: "m2" }),
    );
    const got = await repo.get("gt_aaaaaaaaaa");
    expect(got).toMatchObject({ name: "Tesis v2", version: 2, stars: 1, downloads: 1 });
    expect(got?.embedding).toHaveLength(3);
    expect(got?.embeddingModel).toBe("m2");
  });

  it("filters, sorts, finds stale embeddings and counts tags", async () => {
    const repo = new PgGalleryRepository(pool);
    await repo.insert(
      template("gt_bbbbbbbbbb", { tags: ["cv"], category: "cv", embeddingModel: undefined }),
    );
    await repo.insert(template("gt_cccccccccc", { hidden: true }));
    const page = await repo.list({ tags: ["tesis"] }, "stars", 10, 0);
    expect(page.items.map((t) => t.id)).toEqual(["gt_aaaaaaaaaa"]);
    expect((await repo.list({ category: "cv" }, "recent", 10, 0)).total).toBe(1);
    expect((await repo.list({ starredBy: "user_b" }, "stars", 10, 0)).total).toBe(1);
    expect((await repo.candidates({ includeHidden: true })).length).toBe(3);
    const stale = await repo.staleEmbeddings("m2", 10);
    expect(stale.map((t) => t.id).sort()).toEqual(["gt_bbbbbbbbbb", "gt_cccccccccc"]);
    expect(await repo.starredAmong("user_b", ["gt_aaaaaaaaaa", "gt_bbbbbbbbbb"])).toEqual(
      new Set(["gt_aaaaaaaaaa"]),
    );
    expect(await repo.report("gt_aaaaaaaaaa", "user_c", "spam", new Date())).toBe(true);
    expect((await repo.get("gt_aaaaaaaaaa"))?.reports).toBe(1);
    expect(await repo.popularTags(5)).toEqual(
      expect.arrayContaining([
        { tag: "tesis", count: 1 },
        { tag: "cv", count: 1 },
      ]),
    );
    expect(await repo.unstar("gt_aaaaaaaaaa", "user_b")).toBe(true);
    await repo.delete("gt_aaaaaaaaaa");
    expect(await repo.get("gt_aaaaaaaaaa")).toBeNull();
  });
});
