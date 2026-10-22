import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { TemplateNotFoundError } from "@latex-api/core";
import { zipSync } from "fflate";
import type { Env } from "../auth";
import { decodeJsonFiles, fromRequest } from "../body";
import { toJobDto, toTemplateDto } from "../dto";
import { problem } from "../errors";
import {
  JobEnvelopeSchema,
  ProblemSchema,
  TemplateCompileRequestSchema,
  TemplateIdParam,
  TemplateSchema,
} from "../schemas";
import { respondSync } from "./compile";

const listRoute = createRoute({
  method: "get",
  path: "/v1/templates",
  tags: ["Templates"],
  summary: "List templates",
  responses: {
    200: {
      description: "Template catalog",
      content: { "application/json": { schema: z.object({ templates: z.array(TemplateSchema) }) } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/templates/{id}",
  tags: ["Templates"],
  summary: "Get a template and its file list",
  request: { params: TemplateIdParam },
  responses: {
    200: {
      description: "Template",
      content: { "application/json": { schema: z.object({ template: TemplateSchema }) } },
    },
    404: {
      description: "Unknown template",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const fileRoute = createRoute({
  method: "get",
  path: "/v1/templates/{id}/files/{path}",
  tags: ["Templates"],
  summary: "Read one template file",
  request: {
    params: TemplateIdParam.extend({
      path: z.string().openapi({
        param: { name: "path", in: "path" },
        example: "main.tex",
        description: "URL-encoded relative path.",
      }),
    }),
  },
  responses: {
    200: {
      description: "File content",
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    },
    404: {
      description: "Unknown template or file",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const archiveRoute = createRoute({
  method: "get",
  path: "/v1/templates/{id}/archive",
  tags: ["Templates"],
  summary: "Download the template as a zip",
  request: { params: TemplateIdParam },
  responses: {
    200: {
      description: "Zip archive",
      content: { "application/zip": { schema: { type: "string", format: "binary" } } },
    },
    404: {
      description: "Unknown template",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const previewRoute = createRoute({
  method: "get",
  path: "/v1/templates/{id}/preview",
  tags: ["Templates"],
  summary: "Rendered PDF of the untouched template",
  description: "Compiles the template on first request and serves the cached PDF afterwards.",
  request: { params: TemplateIdParam },
  responses: {
    200: {
      description: "PDF",
      content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
    },
    404: {
      description: "Unknown template",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "The template failed to compile",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const compileRoute = createRoute({
  method: "post",
  path: "/v1/templates/{id}/compile",
  tags: ["Templates"],
  summary: "Compile a template with your changes (synchronous)",
  description:
    "Files you send replace the template files with the same path or are added to the project. Multipart and zip bodies work like `/v1/compile`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: TemplateIdParam,
    body: {
      content: {
        "application/json": { schema: TemplateCompileRequestSchema },
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: { files: { type: "array", items: { type: "string", format: "binary" } } },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "PDF or job envelope",
      content: {
        "application/pdf": { schema: { type: "string", format: "binary" } },
        "application/json": { schema: JobEnvelopeSchema },
      },
    },
    404: {
      description: "Unknown template",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "LaTeX reported errors",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const jobsRoute = createRoute({
  method: "post",
  path: "/v1/templates/{id}/jobs",
  tags: ["Templates"],
  summary: "Compile a template with your changes (asynchronous)",
  security: [{ bearerAuth: [] }],
  request: {
    params: TemplateIdParam,
    body: {
      content: {
        "application/json": { schema: TemplateCompileRequestSchema },
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: { files: { type: "array", items: { type: "string", format: "binary" } } },
          },
        },
      },
    },
  },
  responses: {
    202: {
      description: "Job accepted",
      content: { "application/json": { schema: JobEnvelopeSchema } },
    },
    404: {
      description: "Unknown template",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerTemplateRoutes(app: OpenAPIHono<Env>) {
  app.openapi(listRoute, async (c) => {
    const container = c.get("container");
    const templates = await container.useCases.listTemplates.execute();
    return c.json(
      { templates: templates.map((t) => toTemplateDto(t, container.config.publicUrl)) },
      200,
    );
  });

  app.openapi(getRoute, async (c) => {
    const container = c.get("container");
    const template = await container.useCases.getTemplate.execute(c.req.valid("param").id);
    return c.json({ template: toTemplateDto(template, container.config.publicUrl) }, 200);
  });

  app.openapi(fileRoute, async (c) => {
    const container = c.get("container");
    const { id, path } = c.req.valid("param");
    const content = await container.templates.readFile(id, decodeURIComponent(path));
    if (!content) {
      const exists = await container.templates.get(id);
      if (!exists) throw new TemplateNotFoundError(id);
      return problem(c, 404, "not_found", `File "${path}" is not part of template "${id}"`);
    }
    return new Response(content as BodyInit, {
      headers: { "content-type": contentTypeFor(path), "cache-control": "public, max-age=3600" },
    });
  });

  app.openapi(archiveRoute, async (c) => {
    const container = c.get("container");
    const id = c.req.valid("param").id;
    const files = await container.templates.files(id);
    if (!files) throw new TemplateNotFoundError(id);
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[`${id}/${f.path}`] = f.content;
    const zip = zipSync(entries, { level: 6 });
    return new Response(zip as BodyInit, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${id}.zip"`,
        "cache-control": "public, max-age=3600",
      },
    });
  });

  app.openapi(previewRoute, async (c) => {
    const container = c.get("container");
    const id = c.req.valid("param").id;
    const { project } = await container.useCases.buildTemplateProject.execute({ templateId: id });
    const job = await container.useCases.compileProject.execute({
      project,
      principal: { name: "system:preview", kind: "key" },
      templateId: id,
      options: { timeoutMs: container.config.limits.syncTimeoutMs },
    });
    if (job.status === "succeeded" && job.result?.pdfKey) {
      const stream = await container.deps.artifacts.stream(job.result.pdfKey);
      if (stream) {
        return new Response(stream, {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="${id}.pdf"`,
            "cache-control": "public, max-age=86400",
            "X-Job-Id": job.id,
          },
        });
      }
    }
    return respondSync(c, job);
  });

  app.openapi(compileRoute, async (c) => {
    const container = c.get("container");
    const id = c.req.valid("param").id;
    const input = await parseTemplateInput(c);
    const { project } = await container.useCases.buildTemplateProject.execute({
      templateId: id,
      overrides: input.files,
      engine: input.engine,
      entrypoint: input.entrypoint,
    });
    const job = await container.useCases.compileProject.execute({
      project,
      principal: c.get("principal"),
      templateId: id,
      options: input.options,
    });
    return respondSync(c, job);
  });

  app.openapi(jobsRoute, async (c) => {
    const container = c.get("container");
    const id = c.req.valid("param").id;
    const input = await parseTemplateInput(c);
    const { project } = await container.useCases.buildTemplateProject.execute({
      templateId: id,
      overrides: input.files,
      engine: input.engine,
      entrypoint: input.entrypoint,
    });
    const job = await container.useCases.enqueueCompileJob.execute({
      project,
      principal: c.get("principal"),
      templateId: id,
      options: input.options,
    });
    const dto = toJobDto(job, container.config.publicUrl);
    return c.json({ job: dto }, 202, { Location: dto.links.self });
  });
}

async function parseTemplateInput(c: Parameters<typeof respondSync>[0]) {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  const limits = c.get("container").config.limits;
  if (contentType === "" || c.req.header("content-length") === "0") {
    return { files: [], entrypoint: undefined, engine: undefined, options: undefined };
  }
  if (/^application\/([a-z-.]+\+)?json/.test(contentType)) {
    const body = TemplateCompileRequestSchema.parse(await c.req.json());
    return {
      files: body.files ? decodeJsonFiles(body.files) : [],
      entrypoint: body.entrypoint,
      engine: body.engine,
      options: body.options,
    };
  }
  return fromRequest(c, limits);
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "tex":
    case "cls":
    case "sty":
    case "bib":
    case "bst":
    case "txt":
    case "md":
      return "text/plain; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "pdf":
      return "application/pdf";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}
