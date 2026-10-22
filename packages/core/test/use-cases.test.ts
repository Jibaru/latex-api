import { describe, expect, it } from "vitest";
import {
  BuildTemplateProject,
  CancelJob,
  CompileProject,
  createProject,
  DEFAULT_LIMITS,
  EnqueueCompileJob,
  GetJob,
  JobNotFoundError,
  ProcessCompileJob,
  PurgeExpired,
  RateLimitedError,
} from "../src/index.js";
import { MemoryTemplates, makeDeps } from "./fakes.js";

const enc = (s: string) => new TextEncoder().encode(s);
const principal = { name: "test", kind: "key" as const };
const project = () =>
  createProject(
    {
      files: [
        {
          path: "main.tex",
          content: enc("\\documentclass{article}\\begin{document}x\\end{document}"),
        },
      ],
    },
    DEFAULT_LIMITS,
  );

describe("CompileProject (sync)", () => {
  it("compiles, stores artifacts and returns a succeeded job", async () => {
    const deps = makeDeps();
    const job = await new CompileProject(deps).execute({ project: project(), principal });
    expect(job.status).toBe("succeeded");
    expect(job.result?.pdfKey).toBe(`artifacts/${job.projectHash}/output.pdf`);
    expect(job.result?.pages).toBe(1);
    expect(await deps.artifacts.get(job.result!.pdfKey!)).toBeTruthy();
    expect(await deps.artifacts.get(job.result!.logKey)).toBeTruthy();
    expect(deps.workspaces.store.size).toBe(0);
    expect(deps.events.published.map((e) => e.type)).toEqual(["queued", "running", "done"]);
    expect(job.options.timeoutMs).toBe(DEFAULT_LIMITS.syncTimeoutMs);
  });

  it("serves identical projects from cache", async () => {
    const deps = makeDeps();
    const first = await new CompileProject(deps).execute({ project: project(), principal });
    const second = await new CompileProject(deps).execute({ project: project(), principal });
    expect(second.id).not.toBe(first.id);
    expect(second.result?.cached).toBe(true);
    expect(second.result?.pdfKey).toBe(first.result?.pdfKey);
    expect(deps.compiler.calls).toHaveLength(1);
    const forced = await new CompileProject(deps).execute({
      project: project(),
      principal,
      options: { force: true },
    });
    expect(forced.result?.cached).toBe(false);
    expect(deps.compiler.calls).toHaveLength(2);
  });

  it("marks compile failures with diagnostics and caches them", async () => {
    const deps = makeDeps();
    deps.compiler.behaviour = () => ({
      exitCode: 12,
      timedOut: false,
      log: "(./main.tex\n./main.tex:1: Undefined control sequence.\nl.1 \\foo\n)",
      stdout: "",
      durationMs: 10,
    });
    const job = await new CompileProject(deps).execute({ project: project(), principal });
    expect(job.status).toBe("failed");
    expect(job.error?.reason).toBe("compile_failed");
    expect(job.error?.message).toContain("main.tex:1");
    expect(job.result?.errors).toBe(1);
    const again = await new CompileProject(deps).execute({ project: project(), principal });
    expect(again.result?.cached).toBe(true);
    expect(again.status).toBe("failed");
  });

  it("does not cache timeouts", async () => {
    const deps = makeDeps();
    deps.compiler.behaviour = () => ({
      exitCode: null,
      timedOut: true,
      log: "",
      stdout: "killed",
      durationMs: 60000,
    });
    const job = await new CompileProject(deps).execute({ project: project(), principal });
    expect(job.status).toBe("timed_out");
    await new CompileProject(deps).execute({ project: project(), principal });
    expect(deps.compiler.calls).toHaveLength(2);
  });

  it("caps the timeout and rejects bad webhooks", async () => {
    const deps = makeDeps();
    const job = await new CompileProject(deps).execute({
      project: project(),
      principal,
      options: { timeoutMs: 10 ** 9 },
    });
    expect(job.options.timeoutMs).toBe(DEFAULT_LIMITS.syncTimeoutMs);
    await expect(
      new CompileProject(deps).execute({
        project: project(),
        principal,
        options: { webhookUrl: "ftp://x" },
      }),
    ).rejects.toThrow(/webhookUrl/);
  });

  it("applies the hourly rate limit per key", async () => {
    const deps = makeDeps();
    deps.limits.rateLimitPerKeyPerHour = 1;
    await new CompileProject(deps).execute({ project: project(), principal });
    await expect(
      new CompileProject(deps).execute({ project: project(), principal }),
    ).rejects.toThrow(RateLimitedError);
  });

  it("supports cancellation through events", async () => {
    const deps = makeDeps();
    deps.compiler.behaviour = (_req, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () =>
          resolve({ exitCode: null, timedOut: false, log: "", stdout: "", durationMs: 1 }),
        );
      });
    const running = new CompileProject(deps).execute({ project: project(), principal });
    await new Promise((r) => setTimeout(r, 5));
    const id = Array.from(deps.jobs.rows.keys())[0]!;
    await new CancelJob(deps).execute(id, principal);
    const job = await running;
    expect(job.status).toBe("cancelled");
  });
});

describe("async jobs", () => {
  it("enqueues then processes", async () => {
    const deps = makeDeps();
    const queued = await new EnqueueCompileJob(deps).execute({
      project: project(),
      principal,
      options: { timeoutMs: 1000 },
    });
    expect(queued.status).toBe("queued");
    expect(queued.options.timeoutMs).toBe(1000);
    expect(deps.queue.queued).toEqual([queued.id]);
    expect(deps.workspaces.store.has(queued.id)).toBe(true);

    const done = await new ProcessCompileJob(deps).execute(queued.id);
    expect(done.status).toBe("succeeded");
    expect(deps.workspaces.store.has(queued.id)).toBe(false);
    expect((await new GetJob(deps).execute(queued.id, principal)).status).toBe("succeeded");
  });

  it("hides jobs from other principals and cancels queued jobs", async () => {
    const deps = makeDeps();
    const queued = await new EnqueueCompileJob(deps).execute({ project: project(), principal });
    await expect(new GetJob(deps).execute(queued.id, { name: "other" })).rejects.toThrow(
      JobNotFoundError,
    );
    const cancelled = await new CancelJob(deps).execute(queued.id, principal);
    expect(cancelled.status).toBe("cancelled");
    expect(deps.queue.queued).toEqual([]);
    const processed = await new ProcessCompileJob(deps).execute(queued.id);
    expect(processed.status).toBe("cancelled");
    expect(deps.compiler.calls).toHaveLength(0);
  });

  it("uses the async default timeout and reuses the cache", async () => {
    const deps = makeDeps();
    await new CompileProject(deps).execute({ project: project(), principal });
    const queued = await new EnqueueCompileJob(deps).execute({ project: project(), principal });
    expect(queued.status).toBe("succeeded");
    expect(queued.result?.cached).toBe(true);
    expect(deps.queue.queued).toEqual([]);
  });
});

describe("templates and purge", () => {
  it("merges overrides into template files", async () => {
    const deps = makeDeps({
      templates: new MemoryTemplates([
        {
          id: "report-es",
          name: "Report",
          description: "",
          category: "report",
          engine: "pdflatex",
          entrypoint: "main.tex",
          tags: [],
          license: "MIT",
          variables: [],
          files: [],
          contents: { "main.tex": "\\input{body}", "body.tex": "hola" },
        },
      ]),
    });
    const { project: p } = await new BuildTemplateProject(deps).execute({
      templateId: "report-es",
      overrides: [
        { path: "body.tex", content: enc("adios") },
        { path: "extra.bib", content: enc("") },
      ],
    });
    expect(p.engine).toBe("pdflatex");
    expect(p.files.map((f) => f.path)).toEqual(["body.tex", "extra.bib", "main.tex"]);
    expect(new TextDecoder().decode(p.files[0]!.content)).toBe("adios");
    await expect(new BuildTemplateProject(deps).execute({ templateId: "nope" })).rejects.toThrow(
      /not found/,
    );
  });

  it("purges expired jobs and orphaned artifacts", async () => {
    const deps = makeDeps();
    deps.limits.artifactTtlHours = 0;
    const job = await new CompileProject(deps).execute({ project: project(), principal });
    const result = await new PurgeExpired(deps).execute();
    expect(result).toEqual({ jobs: 1, artifactSets: 1 });
    expect(await deps.artifacts.get(job.result!.pdfKey!)).toBeNull();
    expect(await deps.jobs.get(job.id)).toBeNull();
  });
});
