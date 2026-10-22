import { z } from "@hono/zod-openapi";
import { BIBLIOGRAPHY_MODES, ENGINES, JOB_STATUSES } from "@latex-api/core";

export const EngineSchema = z.enum(ENGINES).openapi("Engine", {
  description:
    "TeX engine. Detected from a `% !TEX program = ...` magic comment when omitted; defaults to pdflatex.",
});

export const BibliographySchema = z.enum(BIBLIOGRAPHY_MODES).openapi("BibliographyMode", {
  description: "`auto` runs bibtex/biber only when the document needs it.",
});

export const ProjectFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .openapi({ example: "main.tex", description: "Relative POSIX path inside the project." }),
    content: z
      .string()
      .openapi({ description: "File content, UTF-8 text or base64 when `encoding` is `base64`." }),
    encoding: z.enum(["utf8", "base64"]).optional().openapi({ example: "utf8" }),
  })
  .openapi("ProjectFile");

export const CompileOptionsSchema = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ example: 60000, description: "Capped by the server limits." }),
    bibliography: BibliographySchema.optional(),
    webhookUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Async jobs only: POSTed with the job when it finishes." }),
    force: z.boolean().optional().openapi({ description: "Skip the content-addressed cache." }),
  })
  .openapi("CompileOptions");

export const CompileRequestSchema = z
  .object({
    files: z.array(ProjectFileSchema).min(1).max(1000),
    entrypoint: z
      .string()
      .optional()
      .openapi({
        example: "main.tex",
        description: "Main .tex file. Guessed when there is a single .tex or a main.tex.",
      }),
    engine: EngineSchema.optional(),
    options: CompileOptionsSchema.optional(),
  })
  .openapi("CompileRequest", {
    example: {
      files: [
        {
          path: "main.tex",
          content: "\\documentclass{article}\\begin{document}Hello\\end{document}",
        },
      ],
      engine: "pdflatex",
    },
  });

export const TemplateCompileRequestSchema = z
  .object({
    files: z
      .array(ProjectFileSchema)
      .optional()
      .openapi({ description: "Files that replace or extend the template files." }),
    entrypoint: z.string().optional(),
    engine: EngineSchema.optional(),
    options: CompileOptionsSchema.optional(),
  })
  .openapi("TemplateCompileRequest");

export const DemoCompileRequestSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(200_000)
      .optional()
      .openapi({ description: "Single-file document source." }),
    files: z.array(ProjectFileSchema).max(20).optional(),
    entrypoint: z.string().optional(),
    engine: EngineSchema.optional(),
  })
  .openapi("DemoCompileRequest");

export const DiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning", "info"]),
    message: z.string(),
    file: z.string().optional(),
    line: z.number().int().optional(),
    context: z.string().optional(),
    source: z.string().optional(),
  })
  .openapi("Diagnostic");

export const JobResultSchema = z
  .object({
    cached: z.boolean(),
    durationMs: z.number(),
    exitCode: z.number().nullable(),
    errors: z.number(),
    warnings: z.number(),
    pages: z.number().optional(),
    pdfBytes: z.number().optional(),
    pdfUrl: z.string().optional(),
    logUrl: z.string(),
    diagnostics: z.array(DiagnosticSchema),
  })
  .openapi("JobResult");

export const JobSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(JOB_STATUSES),
    mode: z.enum(["sync", "async", "demo"]),
    engine: EngineSchema,
    entrypoint: z.string(),
    templateId: z.string().optional(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    options: z.object({
      timeoutMs: z.number(),
      bibliography: BibliographySchema,
      webhookUrl: z.string().optional(),
    }),
    result: JobResultSchema.optional(),
    error: z
      .object({
        reason: z.enum(["compile_failed", "timeout", "cancelled", "internal"]),
        message: z.string(),
      })
      .optional(),
    links: z.object({
      self: z.string(),
      events: z.string().optional(),
      pdf: z.string().optional(),
      log: z.string().optional(),
    }),
  })
  .openapi("Job");

export const JobEnvelopeSchema = z.object({ job: JobSchema }).openapi("JobEnvelope");

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: z.string(),
  })
  .passthrough()
  .openapi("Problem", { description: "RFC 9457 problem details." });

export const CompileFailedProblemSchema = ProblemSchema.extend({
  code: z.literal("compile_failed"),
  jobId: z.string(),
  diagnostics: z.array(DiagnosticSchema),
  logUrl: z.string(),
  pdfUrl: z.string().optional(),
}).openapi("CompileFailedProblem");

export const TemplateFileInfoSchema = z
  .object({ path: z.string(), size: z.number(), editable: z.boolean().optional() })
  .openapi("TemplateFile");

export const TemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.enum(["paper", "cv", "brochure", "poster", "report", "letter", "other"]),
    engine: EngineSchema,
    entrypoint: z.string(),
    tags: z.array(z.string()),
    license: z.string(),
    source: z.string().optional(),
    variables: z.array(
      z.object({ name: z.string(), description: z.string(), default: z.string().optional() }),
    ),
    files: z.array(TemplateFileInfoSchema),
    links: z.object({
      self: z.string(),
      archive: z.string(),
      preview: z.string(),
      compile: z.string(),
    }),
  })
  .openapi("Template");

export const LimitsSchema = z
  .object({
    maxUploadBytes: z.number(),
    maxUnpackedBytes: z.number(),
    maxFiles: z.number(),
    maxFileBytes: z.number(),
    syncTimeoutMs: z.number(),
    jobTimeoutMs: z.number(),
    jobTimeoutMaxMs: z.number(),
    jobMemoryBytes: z.number(),
    jobCpus: z.number(),
    artifactTtlHours: z.number(),
    rateLimitPerKeyPerHour: z.number(),
    rateLimitConcurrentPerKey: z.number(),
    engines: z.array(z.string()),
  })
  .openapi("Limits");

export const StatsSchema = z
  .object({
    byStatus: z.record(z.string(), z.number()),
    last24h: z.object({
      total: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      cached: z.number(),
    }),
    durationMs: z.object({ p50: z.number(), p95: z.number() }),
    queueDepth: z.number(),
    storage: z.object({ usedBytes: z.number(), freeBytes: z.number().optional() }),
    compilerVersion: z.string(),
  })
  .openapi("Stats");

export const HealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
    checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().optional() })),
  })
  .openapi("Health");

export const JobIdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({
      param: { name: "id", in: "path" },
      example: "7f1c7f9e-3b1e-4d2a-9a1a-2f0c1b7e5d11",
    }),
});

export const TemplateIdParam = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/)
    .openapi({ param: { name: "id", in: "path" }, example: "ieee-conference" }),
});
