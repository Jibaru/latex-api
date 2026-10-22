import type { CompileJob, Template } from "@latex-api/core";

export function jobUrl(base: string, id: string): string {
  return `${base}/v1/jobs/${id}`;
}

export function toJobDto(job: CompileJob, base: string) {
  const self = jobUrl(base, job.id);
  const pdf = job.result?.pdfKey ? `${self}/pdf` : undefined;
  const log = job.result ? `${self}/log` : undefined;
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    engine: job.engine,
    entrypoint: job.entrypoint,
    templateId: job.templateId,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString(),
    finishedAt: job.finishedAt?.toISOString(),
    expiresAt: job.expiresAt.toISOString(),
    options: {
      timeoutMs: job.options.timeoutMs,
      bibliography: job.options.bibliography,
      webhookUrl: job.options.webhookUrl,
    },
    result: job.result
      ? {
          cached: job.result.cached,
          durationMs: job.result.durationMs,
          exitCode: job.result.exitCode,
          errors: job.result.errors,
          warnings: job.result.warnings,
          pages: job.result.pages,
          pdfBytes: job.result.pdfBytes,
          pdfUrl: pdf,
          logUrl: log ?? `${self}/log`,
          diagnostics: job.result.diagnostics,
        }
      : undefined,
    error: job.error,
    links: {
      self,
      events: job.mode === "async" ? `${self}/events` : undefined,
      pdf,
      log,
    },
  };
}

export function toTemplateDto(template: Template, base: string) {
  const self = `${base}/v1/templates/${template.id}`;
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    engine: template.engine,
    entrypoint: template.entrypoint,
    tags: template.tags,
    license: template.license,
    source: template.source,
    variables: template.variables,
    files: template.files,
    links: {
      self,
      archive: `${self}/archive`,
      preview: `${self}/preview`,
      compile: `${self}/compile`,
    },
  };
}
