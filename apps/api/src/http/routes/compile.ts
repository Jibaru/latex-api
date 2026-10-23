import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type CompileJob, createProject } from "@latex-api/core";
import type { Context } from "hono";
import type { Env } from "../auth";
import { fromJson, fromRequest } from "../body";
import { toJobDto } from "../dto";
import { problem } from "../errors";
import {
  CompileFailedProblemSchema,
  CompileRequestSchema,
  JobEnvelopeSchema,
  ProblemSchema,
} from "../schemas";

const bodyContent: NonNullable<
  NonNullable<Parameters<typeof createRoute>[0]["request"]>["body"]
>["content"] = {
  "application/json": { schema: CompileRequestSchema },
  "multipart/form-data": {
    schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "binary" },
          description: "One part per file; the filename may contain a relative path.",
        },
        project: {
          type: "string",
          format: "binary",
          description: "A zip archive with the whole project.",
        },
        entrypoint: { type: "string" },
        engine: { type: "string", enum: ["pdflatex", "xelatex", "lualatex"] as string[] },
        options: { type: "string", description: "JSON-encoded CompileOptions." },
      },
    },
  },
  "application/zip": { schema: { type: "string", format: "binary" } },
  "text/x-tex": {
    schema: { type: "string" },
    example: "\\documentclass{article}\\begin{document}Hello\\end{document}",
  },
} as const;

export const compileRoute = createRoute({
  method: "post",
  path: "/v1/compile",
  tags: ["Compile"],
  summary: "Compile a project synchronously",
  description:
    "Compiles and waits for the result (up to the synchronous timeout). Send JSON, multipart files, a zip or a raw .tex body. " +
    "Returns the PDF by default; send `Accept: application/json` to get the job envelope with diagnostics instead. " +
    "Query parameters `engine`, `entrypoint`, `timeoutMs`, `bibliography` and `force` apply to zip and raw bodies.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: bodyContent },
    query: z.object({
      engine: z.string().optional(),
      entrypoint: z.string().optional(),
      timeoutMs: z.string().optional(),
      bibliography: z.string().optional(),
      force: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "The compiled PDF, or the job envelope when JSON is requested.",
      content: {
        "application/pdf": { schema: { type: "string", format: "binary" } },
        "application/json": { schema: JobEnvelopeSchema },
      },
      headers: z.object({
        "X-Job-Id": z.string(),
        "X-Compile-Cached": z.string(),
        "X-Compile-Warnings": z.string(),
        "X-Compile-Duration-Ms": z
          .string()
          .openapi({
            description: "Time spent compiling for this request; 0 when served from cache",
          }),
      }),
    },
    400: {
      description: "Invalid project or request",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Missing or invalid API key",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    408: {
      description: "Compilation exceeded the timeout",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    413: {
      description: "Payload too large",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description:
        "LaTeX reported errors. The problem includes structured diagnostics and a link to the full log.",
      content: { "application/problem+json": { schema: CompileFailedProblemSchema } },
    },
    429: {
      description: "Rate limited",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const jobsCreateRoute = createRoute({
  method: "post",
  path: "/v1/jobs",
  tags: ["Jobs"],
  summary: "Create an asynchronous compile job",
  description:
    "Accepts the same bodies as `/v1/compile` and returns immediately with a job you can poll, stream (`/events`) or get notified about through `options.webhookUrl`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: bodyContent },
    query: z.object({
      engine: z.string().optional(),
      entrypoint: z.string().optional(),
      timeoutMs: z.string().optional(),
      bibliography: z.string().optional(),
      force: z.string().optional(),
    }),
  },
  responses: {
    202: {
      description: "Job accepted (or served from cache, in which case it is already finished).",
      content: { "application/json": { schema: JobEnvelopeSchema } },
      headers: z.object({ Location: z.string() }),
    },
    400: {
      description: "Invalid project or request",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Missing or invalid API key",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    413: {
      description: "Payload too large",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Rate limited",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerCompileRoutes(app: OpenAPIHono<Env>) {
  app.openapi(compileRoute, async (c) => {
    const container = c.get("container");
    const input = await parseInput(c);
    const project = createProject(
      { files: input.files, entrypoint: input.entrypoint, engine: input.engine },
      container.config.limits,
    );
    const job = await container.useCases.compileProject.execute({
      project,
      principal: c.get("principal"),
      options: input.options,
    });
    return respondSync(c, job);
  });

  app.openapi(jobsCreateRoute, async (c) => {
    const container = c.get("container");
    const input = await parseInput(c);
    const project = createProject(
      { files: input.files, entrypoint: input.entrypoint, engine: input.engine },
      container.config.limits,
    );
    const job = await container.useCases.enqueueCompileJob.execute({
      project,
      principal: c.get("principal"),
      options: input.options,
    });
    const dto = toJobDto(job, container.config.publicUrl);
    return c.json({ job: dto }, 202, { Location: dto.links.self });
  });
}

async function parseInput(c: Context<Env>) {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  const limits = c.get("container").config.limits;
  if (/^application\/([a-z-.]+\+)?json/.test(contentType)) {
    const body = CompileRequestSchema.parse(await c.req.json());
    return fromJson(body);
  }
  return fromRequest(c, limits);
}

/** Shared by /v1/compile, template compile and demo compile. */
export async function respondSync(c: Context<Env>, job: CompileJob): Promise<Response> {
  const container = c.get("container");
  const base = container.config.publicUrl;
  const dto = toJobDto(job, base);
  const wantsJson =
    /application\/json/.test(c.req.header("accept") ?? "") &&
    !/application\/pdf/.test(c.req.header("accept") ?? "");
  const headers = {
    "X-Job-Id": job.id,
    "X-Compile-Cached": String(job.result?.cached ?? false),
    "X-Compile-Warnings": String(job.result?.warnings ?? 0),
    "X-Compile-Duration-Ms": String(job.result?.cached ? 0 : (job.result?.durationMs ?? 0)),
  };

  if (job.status === "succeeded" && job.result?.pdfKey) {
    if (wantsJson) return c.json({ job: dto }, 200, headers);
    const stream = await container.deps.artifacts.stream(job.result.pdfKey);
    if (!stream) return problem(c, 500, "internal", "PDF artifact is missing");
    return new Response(stream, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/pdf",
        "content-length": String(job.result.pdfBytes ?? ""),
        "content-disposition": `inline; filename="${safeName(job.entrypoint)}.pdf"`,
        "cache-control": "no-store",
      },
    });
  }

  if (job.status === "timed_out") {
    return problem(
      c,
      408,
      "timeout",
      job.error?.message ?? "Compilation timed out",
      {
        jobId: job.id,
        logUrl: dto.result?.logUrl,
        diagnostics: job.result?.diagnostics ?? [],
      },
      headers,
    );
  }
  if (job.status === "cancelled") {
    return problem(c, 499, "cancelled", "Compilation was cancelled", { jobId: job.id }, headers);
  }
  if (job.error?.reason === "internal") {
    return problem(c, 500, "internal", job.error.message, { jobId: job.id }, headers);
  }
  return problem(
    c,
    422,
    "compile_failed",
    job.error?.message ?? "LaTeX reported errors",
    {
      jobId: job.id,
      diagnostics: job.result?.diagnostics ?? [],
      errors: job.result?.errors ?? 0,
      warnings: job.result?.warnings ?? 0,
      logUrl: dto.result?.logUrl ?? `${dto.links.self}/log`,
      pdfUrl: dto.result?.pdfUrl,
    },
    headers,
  );
}

function safeName(entrypoint: string): string {
  const base = entrypoint.split("/").pop() ?? "output";
  return base.replace(/\.(tex|ltx|latex)$/i, "").replace(/[^A-Za-z0-9._-]/g, "_") || "output";
}
