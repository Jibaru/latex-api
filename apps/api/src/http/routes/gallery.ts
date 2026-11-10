import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createProject,
  GALLERY_CATEGORIES,
  GALLERY_LICENSE,
  type GalleryTemplate,
  InvalidProjectError,
} from "@latex-api/core";
import type { Context } from "hono";
import type { Env } from "../auth";
import { decodeJsonFiles, fromRequest, type ParsedProjectInput } from "../body";
import { EngineSchema, ProblemSchema, ProjectFileSchema } from "../schemas";
import { respondSync } from "./compile";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CategorySchema = z
  .enum(GALLERY_CATEGORIES as [string, ...string[]])
  .openapi("GalleryCategory");

export const GalleryTemplateSchema = z
  .object({
    id: z.string().openapi({ example: "gt_4fK9aQ2LmZ" }),
    slug: z.string().openapi({ example: "thesis-untels" }),
    name: z.string(),
    description: z.string(),
    category: CategorySchema,
    tags: z.array(z.string()),
    engine: EngineSchema,
    entrypoint: z.string(),
    author: z.object({ name: z.string(), imageUrl: z.string().optional() }),
    license: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    version: z.number().int(),
    fileCount: z.number().int(),
    totalBytes: z.number().int(),
    pages: z.number().int().optional(),
    stars: z.number().int(),
    downloads: z.number().int(),
    hidden: z.boolean(),
    starred: z
      .boolean()
      .openapi({ description: "Whether the caller starred it (false when anonymous)." }),
    score: z.number().optional().openapi({ description: "Search relevance, only with `q`." }),
    createdAt: z.string(),
    updatedAt: z.string(),
    links: z.object({
      self: z.string(),
      web: z.string(),
      archive: z.string(),
      pdf: z.string(),
      thumbnail: z.string(),
    }),
  })
  .openapi("GalleryTemplate");

const GalleryDetailSchema = GalleryTemplateSchema.extend({
  canEdit: z.boolean(),
  canModerate: z.boolean(),
  reports: z.number().int().optional().openapi({ description: "Only visible to moderators." }),
}).openapi("GalleryTemplateDetail");

const GalleryPageSchema = z
  .object({
    items: z.array(GalleryTemplateSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    sort: z.enum(["stars", "recent", "relevance"]),
    semantic: z.boolean().openapi({
      description: "True when `q` was ranked with embeddings; false means keyword matching only.",
    }),
  })
  .openapi("GalleryPage");

const GalleryPublishJsonSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    acceptLicense: z.boolean().openapi({
      description: `Must be true: the template is published under ${GALLERY_LICENSE.id}.`,
    }),
    files: z.array(ProjectFileSchema).min(1),
    entrypoint: z.string().optional(),
    engine: EngineSchema.optional(),
  })
  .openapi("GalleryPublishRequest");

const GalleryPatchSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    hidden: z.boolean().optional().openapi({ description: "Moderators only." }),
  })
  .openapi("GalleryPatchRequest");

const IdParam = z.object({
  id: z
    .string()
    .regex(/^gt_[0-9A-Za-z]{10}$/)
    .openapi({ param: { name: "id", in: "path" }, example: "gt_4fK9aQ2LmZ" }),
});

const problems = (codes: Record<number, string>) =>
  Object.fromEntries(
    Object.entries(codes).map(([code, description]) => [
      code,
      { description, content: { "application/problem+json": { schema: ProblemSchema } } },
    ]),
  );

const publishBody = {
  content: {
    "application/json": { schema: GalleryPublishJsonSchema },
    "multipart/form-data": {
      schema: {
        type: "object" as const,
        properties: {
          project: { type: "string" as const, format: "binary", description: "Zip of the project" },
          files: { type: "array" as const, items: { type: "string" as const, format: "binary" } },
          name: { type: "string" as const },
          description: { type: "string" as const },
          category: { type: "string" as const },
          tags: { type: "string" as const, description: "Comma-separated" },
          entrypoint: { type: "string" as const },
          engine: { type: "string" as const },
          acceptLicense: { type: "string" as const, enum: ["true"] },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/v1/gallery",
  tags: ["Gallery"],
  summary: "Browse and search the public template gallery",
  description:
    "Without `q`, sorted by stars (default) or by date. With `q`, ranked by meaning (multilingual embeddings) plus keyword matches; `sort` can still reorder the matches. Send a token to get `starred` flags and to use `mine` or `starred`.",
  request: {
    query: z.object({
      q: z.string().max(300).optional().openapi({ example: "tesis universidad apa" }),
      tags: z
        .string()
        .optional()
        .openapi({ description: "Comma-separated; all must match", example: "thesis,spanish" }),
      category: CategorySchema.optional(),
      sort: z.enum(["stars", "recent", "relevance"]).optional(),
      mine: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Only your templates (includes hidden ones)" }),
      starred: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Only templates you starred" }),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Page of templates",
      content: { "application/json": { schema: GalleryPageSchema } },
    },
    ...problems({ 403: "`mine` or `starred` without signing in" }),
  },
});

const tagsRoute = createRoute({
  method: "get",
  path: "/v1/gallery/tags",
  tags: ["Gallery"],
  summary: "Most used gallery tags",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
  responses: {
    200: {
      description: "Tags with counts",
      content: {
        "application/json": {
          schema: z.object({
            tags: z.array(z.object({ tag: z.string(), count: z.number().int() })),
          }),
        },
      },
    },
  },
});

const publishRoute = createRoute({
  method: "post",
  path: "/v1/gallery",
  tags: ["Gallery"],
  summary: "Publish a template",
  description: `Compiles the project in the sandbox and publishes it only if it produces a PDF. Requires a signed-in user (a personal token or a browser session) and \`acceptLicense: true\`: gallery templates are shared under ${GALLERY_LICENSE.name}. On LaTeX errors the response is the same \`422 compile_failed\` as \`/v1/compile\`.`,
  security: [{ bearerAuth: [] }],
  request: { body: publishBody },
  responses: {
    201: {
      description: "Published",
      content: { "application/json": { schema: z.object({ template: GalleryDetailSchema }) } },
    },
    ...problems({
      400: "Invalid metadata or project, or the license was not accepted",
      401: "Not signed in",
      403: "Not a user credential",
      409: "Too many templates",
      422: "LaTeX reported errors",
      429: "Rate limited",
    }),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/gallery/{id}",
  tags: ["Gallery"],
  summary: "Get a gallery template",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Template",
      content: { "application/json": { schema: z.object({ template: GalleryDetailSchema }) } },
    },
    ...problems({ 404: "Unknown or hidden template" }),
  },
});

const replaceRoute = createRoute({
  method: "put",
  path: "/v1/gallery/{id}",
  tags: ["Gallery"],
  summary: "Publish a new version of your template",
  description: "Same body as publishing; metadata fields you omit keep their current value.",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam, body: publishBody },
  responses: {
    200: {
      description: "New version published",
      content: { "application/json": { schema: z.object({ template: GalleryDetailSchema }) } },
    },
    ...problems({ 403: "Not the author", 404: "Unknown template", 422: "LaTeX reported errors" }),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/gallery/{id}",
  tags: ["Gallery"],
  summary: "Edit metadata, or hide / unhide (moderators)",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: GalleryPatchSchema } }, required: true },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: z.object({ template: GalleryDetailSchema }) } },
    },
    ...problems({ 400: "Invalid metadata", 403: "Not allowed", 404: "Unknown template" }),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/gallery/{id}",
  tags: ["Gallery"],
  summary: "Delete your template",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    ...problems({ 403: "Not the author", 404: "Unknown template" }),
  },
});

const StarResponse = z.object({ stars: z.number().int(), starred: z.boolean() });

const starRoute = createRoute({
  method: "put",
  path: "/v1/gallery/{id}/star",
  tags: ["Gallery"],
  summary: "Star a template",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "Starred", content: { "application/json": { schema: StarResponse } } },
    ...problems({ 403: "Not a user credential", 404: "Unknown template" }),
  },
});

const unstarRoute = createRoute({
  method: "delete",
  path: "/v1/gallery/{id}/star",
  tags: ["Gallery"],
  summary: "Remove your star",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "Unstarred", content: { "application/json": { schema: StarResponse } } },
    ...problems({ 403: "Not a user credential", 404: "Unknown template" }),
  },
});

const reportRoute = createRoute({
  method: "post",
  path: "/v1/gallery/{id}/report",
  tags: ["Gallery"],
  summary: "Report a template",
  description:
    "One report per user. A template is hidden after several reports until a moderator reviews it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({ reason: z.string().min(5).max(500) }) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Reported",
      content: { "application/json": { schema: z.object({ hidden: z.boolean() }) } },
    },
    ...problems({ 404: "Unknown template", 409: "Your own template" }),
  },
});

const assetRoute = (asset: "archive" | "pdf" | "thumbnail", summary: string, mime: string) =>
  createRoute({
    method: "get",
    path: `/v1/gallery/{id}/${asset}`,
    tags: ["Gallery"],
    summary,
    request: { params: IdParam },
    responses: {
      200: {
        description: summary,
        content: { [mime]: { schema: { type: "string", format: "binary" } } },
      },
      ...problems({ 404: "Unknown template or file" }),
    },
  });

const ASSETS = [
  { asset: "archive", summary: "Download the template files as a zip", mime: "application/zip" },
  { asset: "pdf", summary: "The compiled PDF of the published version", mime: "application/pdf" },
  { asset: "thumbnail", summary: "PNG of the first page (600 px wide)", mime: "image/png" },
] as const;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function toGalleryDto(
  t: GalleryTemplate & { starred?: boolean; score?: number },
  base: string,
) {
  const self = `${base}/v1/gallery/${t.id}`;
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    category: t.category,
    tags: t.tags,
    engine: t.engine,
    entrypoint: t.entrypoint,
    author: { name: t.author.name, imageUrl: t.author.imageUrl },
    license: { ...GALLERY_LICENSE },
    version: t.version,
    fileCount: t.fileCount,
    totalBytes: t.totalBytes,
    pages: t.pages,
    stars: t.stars,
    downloads: t.downloads,
    hidden: t.hidden,
    starred: t.starred ?? false,
    score: t.score,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    links: {
      self,
      web: `${base}/gallery/${t.id}`,
      archive: `${self}/archive`,
      pdf: `${self}/pdf`,
      thumbnail: `${self}/thumbnail?v=${t.version}`,
    },
  };
}

function detailDto(
  t: GalleryTemplate & { starred: boolean; canEdit: boolean; canModerate: boolean },
  base: string,
) {
  return {
    ...toGalleryDto(t, base),
    canEdit: t.canEdit,
    canModerate: t.canModerate,
    reports: t.canModerate ? t.reports : undefined,
  };
}

function splitTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to comma splitting
    }
  }
  return trimmed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

interface PublishInput {
  project: ParsedProjectInput;
  metadata: { name?: string; description?: string; category?: string; tags?: string[] };
  acceptLicense: boolean;
}

async function parsePublish(c: Context<Env>): Promise<PublishInput> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (/^application\/([a-z-.]+\+)?json/.test(contentType)) {
    const parsed = GalleryPublishJsonSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new InvalidProjectError("Invalid publish request", { issues: parsed.error.issues });
    }
    const body = parsed.data;
    return {
      project: {
        files: decodeJsonFiles(body.files),
        entrypoint: body.entrypoint,
        engine: body.engine,
        fields: {},
      },
      metadata: {
        name: body.name,
        description: body.description,
        category: body.category,
        tags: body.tags,
      },
      acceptLicense: body.acceptLicense === true,
    };
  }
  const project = await fromRequest(c, c.get("container").config.limits);
  const f = project.fields;
  return {
    project,
    metadata: {
      name: f.name,
      description: f.description,
      category: f.category,
      tags: splitTags(f.tags),
    },
    acceptLicense: f.acceptLicense === "true" || f.acceptLicense === "1",
  };
}

async function publish(c: Context<Env>, replaceId?: string): Promise<Response> {
  const container = c.get("container");
  const input = await parsePublish(c);
  const project = createProject(
    {
      files: input.project.files,
      entrypoint: input.project.entrypoint,
      engine: input.project.engine,
    },
    container.config.limits,
  );
  const principal = c.get("principal");
  const result = await container.useCases.publishGallery.execute({
    principal,
    project,
    metadata: input.metadata,
    acceptLicense: input.acceptLicense,
    replaceId,
  });
  if (!result.ok) {
    // Same problem documents as a failed sync compile (422 with diagnostics, 408, 503...).
    return respondSync(c, result.job);
  }
  const detail = await container.useCases.getGallery.execute(result.template.id, principal);
  const base = container.config.publicUrl;
  return c.json({ template: detailDto(detail, base) }, replaceId ? 200 : 201, {
    Location: `${base}/v1/gallery/${result.template.id}`,
  });
}

export function registerGalleryRoutes(app: OpenAPIHono<Env>) {
  app.openapi(listRoute, async (c) => {
    const container = c.get("container");
    const q = c.req.valid("query");
    const page = await container.useCases.searchGallery.execute(
      {
        q: q.q,
        tags: splitTags(q.tags),
        category: q.category,
        sort: q.sort,
        mine: q.mine === "true",
        starred: q.starred === "true",
        limit: q.limit,
        offset: q.offset,
      },
      c.get("principal"),
    );
    const base = container.config.publicUrl;
    return c.json({ ...page, items: page.items.map((t) => toGalleryDto(t, base)) }, 200);
  });

  app.openapi(tagsRoute, async (c) => {
    const tags = await c.get("container").useCases.galleryTags.execute(c.req.valid("query").limit);
    return c.json({ tags }, 200, { "cache-control": "public, max-age=60" });
  });

  app.openapi(publishRoute, (c) => publish(c) as never);
  app.openapi(replaceRoute, (c) => publish(c, c.req.valid("param").id) as never);

  app.openapi(getRoute, async (c) => {
    const container = c.get("container");
    const t = await container.useCases.getGallery.execute(
      c.req.valid("param").id,
      c.get("principal"),
    );
    return c.json({ template: detailDto(t, container.config.publicUrl) }, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const container = c.get("container");
    const id = c.req.valid("param").id;
    const principal = c.get("principal");
    await container.useCases.updateGallery.execute(id, c.req.valid("json"), principal);
    const t = await container.useCases.getGallery.execute(id, principal);
    return c.json({ template: detailDto(t, container.config.publicUrl) }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    await c
      .get("container")
      .useCases.deleteGallery.execute(c.req.valid("param").id, c.get("principal"));
    return c.body(null, 204) as never;
  });

  app.openapi(starRoute, async (c) => {
    const res = await c
      .get("container")
      .useCases.starGallery.execute(c.req.valid("param").id, c.get("principal"), true);
    return c.json(res, 200);
  });

  app.openapi(unstarRoute, async (c) => {
    const res = await c
      .get("container")
      .useCases.starGallery.execute(c.req.valid("param").id, c.get("principal"), false);
    return c.json(res, 200);
  });

  app.openapi(reportRoute, async (c) => {
    const res = await c
      .get("container")
      .useCases.reportGallery.execute(
        c.req.valid("param").id,
        c.get("principal"),
        c.req.valid("json").reason,
      );
    return c.json(res, 200);
  });

  for (const { asset, summary, mime } of ASSETS) {
    app.openapi(assetRoute(asset, summary, mime), async (c) => {
      const container = c.get("container");
      const id = c.req.valid("param").id;
      const { template, key } = await container.useCases.getGalleryAsset.execute(
        id,
        asset,
        c.get("principal"),
      );
      const stream = await container.deps.artifacts.stream(key);
      if (!stream) throw new InvalidProjectError("The file is missing");
      const filename =
        asset === "archive"
          ? `${template.slug}.zip`
          : asset === "pdf"
            ? `${template.slug}.pdf`
            : `${template.slug}.png`;
      return new Response(stream, {
        headers: {
          "content-type": mime,
          "content-disposition": `${asset === "archive" ? "attachment" : "inline"}; filename="${filename}"`,
          "cache-control": template.hidden ? "private, no-store" : "public, max-age=300",
        },
      }) as never;
    });
  }
}
