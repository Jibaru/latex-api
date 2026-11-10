import {
  ConflictError,
  ForbiddenError,
  InvalidProjectError,
  NotFoundError,
  RateLimitedError,
} from "../domain/errors";
import {
  cosine,
  embeddingText,
  GALLERY_LICENSE,
  GALLERY_LIMITS,
  type GalleryMetadataInput,
  type GallerySort,
  type GalleryTemplate,
  galleryKeys,
  newGalleryId,
  normalizeTags,
  slugify,
  validateMetadata,
} from "../domain/gallery";
import type { CompileJob, Principal } from "../domain/job";
import type { Project } from "../domain/project";
import type {
  Archiver,
  Embedder,
  GalleryFilter,
  GalleryRepository,
  Thumbnailer,
  UserDirectory,
} from "../ports/index";
import { CompileProject } from "./compile-project";
import type { CoreDeps } from "./deps";

export interface GalleryDeps extends CoreDeps {
  gallery: GalleryRepository;
  embedder: Embedder;
  thumbnailer: Thumbnailer;
  users: UserDirectory;
  archiver: Archiver;
  /** User ids allowed to hide or delete any template. */
  galleryAdmins: readonly string[];
}

/** Reports after which a template is hidden until an admin looks at it. */
export const AUTO_HIDE_REPORTS = 5;
/**
 * A template matches by meaning alone when its cosine similarity is at least SEMANTIC_FLOOR and
 * within SEMANTIC_BAND of the best match. Calibrated on multilingual-e5-small, whose scores
 * are compressed: related pairs land around 0.85-0.89, unrelated ones around 0.75-0.83.
 */
export const SEMANTIC_FLOOR = 0.83;
export const SEMANTIC_BAND = 0.03;

const decoder = new TextDecoder("utf-8", { fatal: false });

function requireUser(principal: Principal, action: string): string {
  if (principal.kind !== "user") {
    throw new ForbiddenError(`Sign in with your account to ${action} (\`latex-api auth login\`)`);
  }
  return principal.name;
}

function isAdmin(deps: GalleryDeps, principal: Principal | undefined): boolean {
  return principal?.kind === "user" && deps.galleryAdmins.includes(principal.name);
}

function canSee(deps: GalleryDeps, t: GalleryTemplate, viewer: Principal | undefined): boolean {
  if (!t.hidden) return true;
  return isAdmin(deps, viewer) || (viewer?.kind === "user" && viewer.name === t.author.id);
}

async function load(
  deps: GalleryDeps,
  id: string,
  viewer: Principal | undefined,
): Promise<GalleryTemplate> {
  const t = await deps.gallery.get(id);
  if (!t || !canSee(deps, t, viewer)) {
    throw new NotFoundError(`Gallery template "${id}" not found`, { templateId: id });
  }
  return t;
}

async function embedSafely(
  deps: GalleryDeps,
  t: Pick<GalleryTemplate, "name" | "description" | "tags" | "category">,
  source: string | undefined,
): Promise<number[] | undefined> {
  try {
    return await deps.embedder.embedPassage(embeddingText(t, source));
  } catch (error) {
    deps.logger.warn({ err: error }, "gallery embedding failed; template stays keyword-searchable");
    return undefined;
  }
}

function mainSource(project: Project): string | undefined {
  const main = project.files.find((f) => f.path === project.entrypoint);
  return main ? decoder.decode(main.content.subarray(0, 64 * 1024)) : undefined;
}

export interface PublishInput {
  principal: Principal;
  project: Project;
  metadata: GalleryMetadataInput;
  acceptLicense: boolean;
  /** When set, publishes a new version of this template (owner only). */
  replaceId?: string;
}

export type PublishResult =
  | { ok: true; template: GalleryTemplate; job: CompileJob }
  | { ok: false; job: CompileJob };

/**
 * Publishes (or re-publishes) a template. The project is compiled in the sandbox first; only
 * a project that produces a PDF is published. The PDF, a PNG of page one and a zip of the
 * files are stored under `gallery/<id>/v<version>/`.
 */
export class PublishGalleryTemplate {
  private readonly compile: CompileProject;
  constructor(private readonly deps: GalleryDeps) {
    this.compile = new CompileProject(deps);
  }

  async execute(input: PublishInput): Promise<PublishResult> {
    const deps = this.deps;
    const userId = requireUser(input.principal, "publish templates");
    if (!input.acceptLicense) {
      throw new InvalidProjectError(
        `Publishing requires accepting the ${GALLERY_LICENSE.name} (${GALLERY_LICENSE.id}) license for your template`,
        { license: GALLERY_LICENSE.id, licenseUrl: GALLERY_LICENSE.url },
      );
    }

    let previous: GalleryTemplate | undefined;
    if (input.replaceId) {
      previous = await load(deps, input.replaceId, input.principal);
      if (previous.author.id !== userId) {
        throw new ForbiddenError("Only the author can publish a new version");
      }
    }
    const metadata = validateMetadata({
      name: input.metadata.name ?? previous?.name,
      description: input.metadata.description ?? previous?.description,
      category: input.metadata.category ?? previous?.category,
      tags: input.metadata.tags ?? previous?.tags,
    });

    if (!previous && (await deps.gallery.countByAuthor(userId)) >= GALLERY_LIMITS.perUser) {
      throw new ConflictError(`You can publish up to ${GALLERY_LIMITS.perUser} templates`);
    }
    const decision = await deps.rateLimiter.consume(
      `gallery:publish:${userId}`,
      GALLERY_LIMITS.publishPerHour,
      3_600_000,
    );
    if (!decision.allowed) {
      throw new RateLimitedError(
        Math.ceil(decision.retryAfterMs / 1000),
        `At most ${GALLERY_LIMITS.publishPerHour} publications per hour`,
      );
    }

    const job = await this.compile.execute({ project: input.project, principal: input.principal });
    const pdf =
      job.status === "succeeded" && job.result?.pdfKey
        ? await deps.artifacts.get(job.result.pdfKey)
        : null;
    if (!pdf) return { ok: false, job };

    const now = deps.clock.now();
    const id = previous?.id ?? newGalleryId();
    const version = (previous?.version ?? 0) + 1;
    const profile = await deps.users.profile(userId).catch(() => null);
    const source = mainSource(input.project);

    await deps.artifacts.put(
      galleryKeys.archive(id, version),
      deps.archiver.zip(input.project.files),
      "application/zip",
    );
    await deps.artifacts.put(galleryKeys.pdf(id, version), pdf, "application/pdf");
    const png = await deps.thumbnailer.thumbnail(pdf).catch((error) => {
      deps.logger.warn({ err: error, templateId: id }, "gallery thumbnail failed");
      return null;
    });
    if (png) await deps.artifacts.put(galleryKeys.thumbnail(id, version), png, "image/png");

    const template: GalleryTemplate = {
      id,
      slug: slugify(metadata.name),
      ...metadata,
      engine: input.project.engine,
      entrypoint: input.project.entrypoint,
      author: {
        id: userId,
        name: profile?.name ?? previous?.author.name ?? "Anonymous",
        imageUrl: profile?.imageUrl ?? previous?.author.imageUrl,
      },
      license: GALLERY_LICENSE.id,
      version,
      fileCount: input.project.files.length,
      totalBytes: input.project.totalBytes,
      pages: job.result?.pages,
      stars: previous?.stars ?? 0,
      downloads: previous?.downloads ?? 0,
      reports: previous?.reports ?? 0,
      hidden: previous?.hidden ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      excerpt: source?.slice(0, 2000),
    };
    template.embedding = await embedSafely(deps, template, template.excerpt);

    if (previous) {
      await deps.gallery.update(template);
      await deps.artifacts
        .deletePrefix(`${galleryKeys.prefix(id)}/v${previous.version}`)
        .catch(() => undefined);
    } else {
      await deps.gallery.insert(template);
    }
    deps.logger.info({ templateId: id, version, author: userId }, "gallery template published");
    return { ok: true, template, job };
  }
}

export interface GalleryPatch {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  /** Admins only. */
  hidden?: boolean;
}

/** Edits metadata without new files (author), or hides / unhides a template (admin). */
export class UpdateGalleryTemplate {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(id: string, patch: GalleryPatch, principal: Principal): Promise<GalleryTemplate> {
    const deps = this.deps;
    const userId = requireUser(principal, "edit templates");
    const t = await load(deps, id, principal);
    const admin = isAdmin(deps, principal);
    const owner = t.author.id === userId;
    if (patch.hidden !== undefined && !admin) {
      throw new ForbiddenError("Only gallery admins can hide or unhide templates");
    }
    const editsMetadata =
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.category !== undefined ||
      patch.tags !== undefined;
    if (editsMetadata && !owner) throw new ForbiddenError("Only the author can edit a template");

    if (editsMetadata) {
      const meta = validateMetadata({
        name: patch.name ?? t.name,
        description: patch.description ?? t.description,
        category: patch.category ?? t.category,
        tags: patch.tags ?? t.tags,
      });
      Object.assign(t, meta, { slug: slugify(meta.name) });
      t.embedding = (await embedSafely(deps, t, t.excerpt)) ?? t.embedding;
      t.updatedAt = deps.clock.now();
    }
    if (patch.hidden !== undefined) {
      t.hidden = patch.hidden;
      if (!patch.hidden) t.reports = 0;
    }
    await deps.gallery.update(t);
    return t;
  }
}

export class DeleteGalleryTemplate {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(id: string, principal: Principal): Promise<void> {
    const userId = requireUser(principal, "delete templates");
    const t = await load(this.deps, id, principal);
    if (t.author.id !== userId && !isAdmin(this.deps, principal)) {
      throw new ForbiddenError("Only the author can delete a template");
    }
    await this.deps.gallery.delete(id);
    await this.deps.artifacts.deletePrefix(galleryKeys.prefix(id)).catch(() => undefined);
  }
}

export interface GalleryQuery {
  q?: string;
  tags?: string[];
  category?: string;
  /** Public author id filter is not exposed; `mine` lists the viewer's own templates. */
  mine?: boolean;
  starred?: boolean;
  sort?: GallerySort;
  limit?: number;
  offset?: number;
}

export interface GalleryPage {
  items: Array<GalleryTemplate & { starred: boolean; score?: number }>;
  total: number;
  limit: number;
  offset: number;
  sort: GallerySort;
  /** False when the query fell back to keyword matching (embedder unavailable). */
  semantic: boolean;
}

/** Lists, filters and searches the gallery. `q` triggers hybrid semantic + keyword ranking. */
export class SearchGallery {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(query: GalleryQuery, viewer?: Principal): Promise<GalleryPage> {
    const deps = this.deps;
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 24), 1), 100);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const viewerId = viewer?.kind === "user" ? viewer.name : undefined;
    if ((query.mine || query.starred) && !viewerId) {
      requireUser(viewer ?? { name: "anonymous", kind: "anonymous" }, "see your templates");
    }
    const filter: GalleryFilter = {
      category: query.category || undefined,
      tags: query.tags?.length ? normalizeTags(query.tags) : undefined,
      authorId: query.mine ? viewerId : undefined,
      starredBy: query.starred ? viewerId : undefined,
      includeHidden: query.mine || isAdmin(deps, viewer),
    };
    const q = query.q?.trim() ?? "";

    let items: Array<GalleryTemplate & { score?: number }>;
    let total: number;
    let semantic = false;
    let sort: GallerySort = query.sort ?? (q ? "relevance" : "stars");

    if (!q) {
      if (sort === "relevance") sort = "stars";
      const page = await deps.gallery.list(filter, sort, limit, offset);
      items = page.items;
      total = page.total;
    } else {
      const candidates = await deps.gallery.candidates(filter);
      let queryVector: number[] | undefined;
      try {
        queryVector = await deps.embedder.embedQuery(q);
        semantic = true;
      } catch (error) {
        deps.logger.warn({ err: error }, "query embedding failed; keyword search only");
      }
      const terms = tokens(q);
      const ranked = candidates.map((t) => ({
        t,
        keyword: keywordScore(t, terms),
        sim: queryVector && t.embedding ? cosine(queryVector, t.embedding) : 0,
      }));
      const best = Math.max(0, ...ranked.map((r) => r.sim));
      const cutoff = Math.max(SEMANTIC_FLOOR, best - SEMANTIC_BAND);
      const scored = ranked
        .filter((r) => r.keyword > 0 || r.sim >= cutoff)
        .map((r) => ({ t: r.t, score: r.sim + r.keyword }));
      if (sort === "stars") scored.sort((a, b) => b.t.stars - a.t.stars || b.score - a.score);
      else if (sort === "recent")
        scored.sort((a, b) => b.t.createdAt.getTime() - a.t.createdAt.getTime());
      else scored.sort((a, b) => b.score - a.score || b.t.stars - a.t.stars);
      total = scored.length;
      items = scored.slice(offset, offset + limit).map((s) => ({
        ...s.t,
        score: Math.round(s.score * 1000) / 1000,
      }));
    }

    const starred = viewerId
      ? await deps.gallery.starredAmong(
          viewerId,
          items.map((t) => t.id),
        )
      : new Set<string>();
    return {
      items: items.map(({ embedding: _e, ...t }) => ({ ...t, starred: starred.has(t.id) })),
      total,
      limit,
      offset,
      sort,
      semantic,
    };
  }
}

function tokens(q: string): string[] {
  return q
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Small bonus per query term found in the name (0.06), tags (0.05) or description (0.02). */
function keywordScore(t: GalleryTemplate, terms: string[]): number {
  if (terms.length === 0) return 0;
  const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const name = norm(t.name);
  const description = norm(t.description);
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 0.06;
    if (t.tags.some((tag) => tag.includes(term))) score += 0.05;
    if (description.includes(term)) score += 0.02;
  }
  return score;
}

export class GetGalleryTemplate {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(
    id: string,
    viewer?: Principal,
  ): Promise<GalleryTemplate & { starred: boolean; canEdit: boolean; canModerate: boolean }> {
    const t = await load(this.deps, id, viewer);
    const viewerId = viewer?.kind === "user" ? viewer.name : undefined;
    const starred = viewerId
      ? (await this.deps.gallery.starredAmong(viewerId, [id])).has(id)
      : false;
    const { embedding: _e, ...rest } = t;
    return {
      ...rest,
      starred,
      canEdit: viewerId === t.author.id,
      canModerate: isAdmin(this.deps, viewer),
    };
  }
}

export type GalleryAsset = "archive" | "pdf" | "thumbnail";

/** Resolves the stored file of a template; counts archive downloads. */
export class GetGalleryAsset {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(
    id: string,
    asset: GalleryAsset,
    viewer?: Principal,
  ): Promise<{ template: GalleryTemplate; key: string }> {
    const t = await load(this.deps, id, viewer);
    const key = galleryKeys[asset](t.id, t.version);
    const stat = await this.deps.artifacts.stat(key);
    if (!stat) throw new NotFoundError(`This template has no ${asset}`, { templateId: id });
    if (asset === "archive") await this.deps.gallery.incrementDownloads(id).catch(() => undefined);
    return { template: t, key };
  }
}

export class StarGalleryTemplate {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(
    id: string,
    principal: Principal,
    starred: boolean,
  ): Promise<{ stars: number; starred: boolean }> {
    const userId = requireUser(principal, "star templates");
    await load(this.deps, id, principal);
    if (starred) await this.deps.gallery.star(id, userId, this.deps.clock.now());
    else await this.deps.gallery.unstar(id, userId);
    const after = await this.deps.gallery.get(id);
    return { stars: after?.stars ?? 0, starred };
  }
}

export class ReportGalleryTemplate {
  constructor(private readonly deps: GalleryDeps) {}

  async execute(id: string, principal: Principal, reason: string): Promise<{ hidden: boolean }> {
    const userId = requireUser(principal, "report templates");
    const text = reason.trim();
    if (text.length < 5 || text.length > GALLERY_LIMITS.reportReasonMax) {
      throw new InvalidProjectError(
        `reason must be 5 to ${GALLERY_LIMITS.reportReasonMax} characters`,
      );
    }
    const t = await load(this.deps, id, principal);
    if (t.author.id === userId) throw new ConflictError("You cannot report your own template");
    await this.deps.gallery.report(id, userId, text, this.deps.clock.now());
    const after = await this.deps.gallery.get(id);
    if (after && !after.hidden && after.reports >= AUTO_HIDE_REPORTS) {
      after.hidden = true;
      await this.deps.gallery.update(after);
      this.deps.logger.warn(
        { templateId: id, reports: after.reports },
        "gallery template auto-hidden",
      );
    }
    return { hidden: after?.hidden ?? false };
  }
}

export class ListGalleryTags {
  constructor(private readonly deps: GalleryDeps) {}
  execute(limit = 40): Promise<Array<{ tag: string; count: number }>> {
    return this.deps.gallery.popularTags(Math.min(Math.max(limit, 1), 200));
  }
}
