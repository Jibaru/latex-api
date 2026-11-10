import type {
  Engine,
  GalleryCategory,
  GalleryFilter,
  GalleryRepository,
  GalleryTemplate,
} from "@latex-api/core";
import type pg from "pg";

interface Row {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  engine: string;
  entrypoint: string;
  author_id: string;
  author_name: string;
  author_image: string | null;
  license: string;
  version: number;
  file_count: number;
  total_bytes: string | number;
  pages: number | null;
  stars: number;
  downloads: number;
  reports: number;
  hidden: boolean;
  created_at: Date;
  updated_at: Date;
  excerpt: string | null;
  embedding?: number[] | null;
  embedding_model?: string | null;
}

function toTemplate(row: Row): GalleryTemplate {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category as GalleryCategory,
    tags: row.tags ?? [],
    engine: row.engine as Engine,
    entrypoint: row.entrypoint,
    author: {
      id: row.author_id,
      name: row.author_name,
      imageUrl: row.author_image ?? undefined,
    },
    license: row.license,
    version: row.version,
    fileCount: row.file_count,
    totalBytes: Number(row.total_bytes),
    pages: row.pages ?? undefined,
    stars: row.stars,
    downloads: row.downloads,
    reports: row.reports,
    hidden: row.hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    excerpt: row.excerpt ?? undefined,
    embedding: row.embedding ?? undefined,
    embeddingModel: row.embedding_model ?? undefined,
  };
}

const BASE_COLUMNS =
  "id, slug, name, description, category, tags, engine, entrypoint, author_id, author_name, author_image, license, version, file_count, total_bytes, pages, stars, downloads, reports, hidden, created_at, updated_at, excerpt";

function values(t: GalleryTemplate): unknown[] {
  return [
    t.id,
    t.slug,
    t.name,
    t.description,
    t.category,
    t.tags,
    t.engine,
    t.entrypoint,
    t.author.id,
    t.author.name,
    t.author.imageUrl ?? null,
    t.license,
    t.version,
    t.fileCount,
    t.totalBytes,
    t.pages ?? null,
    t.stars,
    t.downloads,
    t.reports,
    t.hidden,
    t.createdAt,
    t.updatedAt,
    t.excerpt ?? null,
    t.embedding ?? null,
    t.embeddingModel ?? null,
  ];
}

/** Builds the WHERE clause shared by list and candidates. */
function where(filter: GalleryFilter, params: unknown[]): string {
  const clauses: string[] = [];
  if (!filter.includeHidden) clauses.push("g.hidden = false");
  if (filter.category) {
    params.push(filter.category);
    clauses.push(`g.category = $${params.length}`);
  }
  if (filter.tags?.length) {
    params.push(filter.tags);
    clauses.push(`g.tags @> $${params.length}::text[]`);
  }
  if (filter.authorId) {
    params.push(filter.authorId);
    clauses.push(`g.author_id = $${params.length}`);
  }
  if (filter.starredBy) {
    params.push(filter.starredBy);
    clauses.push(
      `EXISTS (SELECT 1 FROM gallery_stars s WHERE s.template_id = g.id AND s.user_id = $${params.length})`,
    );
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export class PgGalleryRepository implements GalleryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(t: GalleryTemplate): Promise<void> {
    const v = values(t);
    await this.pool.query(
      `INSERT INTO gallery_templates (${BASE_COLUMNS}, embedding, embedding_model) VALUES (${v.map((_, i) => `$${i + 1}`).join(",")})`,
      v,
    );
  }

  async update(t: GalleryTemplate): Promise<void> {
    const v = values(t);
    const cols = `${BASE_COLUMNS}, embedding, embedding_model`.split(", ");
    // stars/downloads/reports are counters maintained by their own statements.
    const sets = cols
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c !== "id" && c !== "stars" && c !== "downloads")
      .map(([c, i]) => `${c} = $${i + 1}`);
    await this.pool.query(`UPDATE gallery_templates SET ${sets.join(", ")} WHERE id = $1`, v);
  }

  async get(id: string): Promise<GalleryTemplate | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${BASE_COLUMNS}, embedding, embedding_model FROM gallery_templates WHERE id = $1`,
      [id],
    );
    return rows[0] ? toTemplate(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query("DELETE FROM gallery_templates WHERE id = $1", [id]);
  }

  async list(filter: GalleryFilter, sort: "stars" | "recent", limit: number, offset: number) {
    const params: unknown[] = [];
    const w = where(filter, params);
    const order =
      sort === "recent" ? "g.created_at DESC" : "g.stars DESC, g.downloads DESC, g.created_at DESC";
    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM gallery_templates g ${w}`,
      params,
    );
    params.push(limit, offset);
    const { rows } = await this.pool.query<Row>(
      `SELECT ${BASE_COLUMNS.split(", ")
        .map((c) => `g.${c}`)
        .join(
          ", ",
        )} FROM gallery_templates g ${w} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows.map(toTemplate), total: Number(total.rows[0]?.n ?? 0) };
  }

  async candidates(filter: GalleryFilter): Promise<GalleryTemplate[]> {
    const params: unknown[] = [];
    const { rows } = await this.pool.query<Row>(
      `SELECT ${BASE_COLUMNS.split(", ")
        .map((c) => `g.${c}`)
        .join(
          ", ",
        )}, g.embedding, g.embedding_model FROM gallery_templates g ${where(filter, params)} LIMIT 20000`,
      params,
    );
    return rows.map(toTemplate);
  }

  async countByAuthor(authorId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM gallery_templates WHERE author_id = $1",
      [authorId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async star(id: string, userId: string, at: Date): Promise<boolean> {
    const res = await this.pool.query(
      `WITH ins AS (
         INSERT INTO gallery_stars (template_id, user_id, created_at) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING 1
       )
       UPDATE gallery_templates SET stars = stars + 1 WHERE id = $1 AND EXISTS (SELECT 1 FROM ins)`,
      [id, userId, at],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async unstar(id: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `WITH del AS (
         DELETE FROM gallery_stars WHERE template_id = $1 AND user_id = $2 RETURNING 1
       )
       UPDATE gallery_templates SET stars = GREATEST(stars - 1, 0)
       WHERE id = $1 AND EXISTS (SELECT 1 FROM del)`,
      [id, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async starredAmong(userId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await this.pool.query<{ template_id: string }>(
      "SELECT template_id FROM gallery_stars WHERE user_id = $1 AND template_id = ANY($2::text[])",
      [userId, ids],
    );
    return new Set(rows.map((r) => r.template_id));
  }

  async incrementDownloads(id: string): Promise<void> {
    await this.pool.query("UPDATE gallery_templates SET downloads = downloads + 1 WHERE id = $1", [
      id,
    ]);
  }

  async report(id: string, userId: string, reason: string, at: Date): Promise<boolean> {
    const res = await this.pool.query(
      `WITH ins AS (
         INSERT INTO gallery_reports (template_id, user_id, reason, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING 1
       )
       UPDATE gallery_templates SET reports = reports + 1 WHERE id = $1 AND EXISTS (SELECT 1 FROM ins)`,
      [id, userId, reason, at],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async staleEmbeddings(model: string, limit: number): Promise<GalleryTemplate[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${BASE_COLUMNS}, embedding, embedding_model FROM gallery_templates
       WHERE embedding_model IS DISTINCT FROM $1 ORDER BY created_at LIMIT $2`,
      [model, limit],
    );
    return rows.map(toTemplate);
  }

  async popularTags(limit: number) {
    const { rows } = await this.pool.query<{ tag: string; count: string }>(
      `SELECT tag, count(*)::text AS count FROM gallery_templates, unnest(tags) AS tag
       WHERE hidden = false GROUP BY tag ORDER BY count(*) DESC, tag LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }
}

// ---------------------------------------------------------------------------
// Memory (development without DATABASE_URL, tests)
// ---------------------------------------------------------------------------

export class MemoryGalleryRepository implements GalleryRepository {
  private readonly rows = new Map<string, GalleryTemplate>();
  private readonly stars = new Map<string, Set<string>>();
  private readonly reports = new Map<string, Set<string>>();

  private matches(t: GalleryTemplate, f: GalleryFilter): boolean {
    if (!f.includeHidden && t.hidden) return false;
    if (f.category && t.category !== f.category) return false;
    if (f.tags?.some((tag) => !t.tags.includes(tag))) return false;
    if (f.authorId && t.author.id !== f.authorId) return false;
    if (f.starredBy && !this.stars.get(t.id)?.has(f.starredBy)) return false;
    return true;
  }

  async insert(t: GalleryTemplate) {
    this.rows.set(t.id, structuredClone(t));
  }
  async update(t: GalleryTemplate) {
    const current = this.rows.get(t.id);
    this.rows.set(t.id, {
      ...structuredClone(t),
      stars: current?.stars ?? t.stars,
      downloads: current?.downloads ?? t.downloads,
    });
  }
  async get(id: string) {
    const t = this.rows.get(id);
    return t ? structuredClone(t) : null;
  }
  async delete(id: string) {
    this.rows.delete(id);
    this.stars.delete(id);
    this.reports.delete(id);
  }
  async list(filter: GalleryFilter, sort: "stars" | "recent", limit: number, offset: number) {
    const all = Array.from(this.rows.values())
      .filter((t) => this.matches(t, filter))
      .sort((a, b) =>
        sort === "recent"
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : b.stars - a.stars ||
            b.downloads - a.downloads ||
            b.createdAt.getTime() - a.createdAt.getTime(),
      );
    return {
      items: all.slice(offset, offset + limit).map(({ embedding: _e, ...t }) => structuredClone(t)),
      total: all.length,
    };
  }
  async candidates(filter: GalleryFilter) {
    return Array.from(this.rows.values())
      .filter((t) => this.matches(t, filter))
      .map((t) => structuredClone(t));
  }
  async countByAuthor(authorId: string) {
    let n = 0;
    for (const t of this.rows.values()) if (t.author.id === authorId) n++;
    return n;
  }
  async star(id: string, userId: string) {
    const set = this.stars.get(id) ?? new Set<string>();
    if (set.has(userId)) return false;
    set.add(userId);
    this.stars.set(id, set);
    const t = this.rows.get(id);
    if (t) t.stars++;
    return true;
  }
  async unstar(id: string, userId: string) {
    const set = this.stars.get(id);
    if (!set?.delete(userId)) return false;
    const t = this.rows.get(id);
    if (t) t.stars = Math.max(0, t.stars - 1);
    return true;
  }
  async starredAmong(userId: string, ids: string[]) {
    return new Set(ids.filter((id) => this.stars.get(id)?.has(userId)));
  }
  async incrementDownloads(id: string) {
    const t = this.rows.get(id);
    if (t) t.downloads++;
  }
  async report(id: string, userId: string) {
    const set = this.reports.get(id) ?? new Set<string>();
    if (set.has(userId)) return false;
    set.add(userId);
    this.reports.set(id, set);
    const t = this.rows.get(id);
    if (t) t.reports++;
    return true;
  }
  async staleEmbeddings(model: string, limit: number) {
    return Array.from(this.rows.values())
      .filter((t) => t.embeddingModel !== model)
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }
  async popularTags(limit: number) {
    const counts = new Map<string, number>();
    for (const t of this.rows.values()) {
      if (t.hidden) continue;
      for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts, ([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, limit);
  }
}
