import { describe, expect, it } from "vitest";
import { CompileFailedError, LatexApi } from "../src/index";

/**
 * Opt-in end-to-end test against a running server:
 *   LATEX_API_URL=http://localhost:3000 LATEX_API_KEY=... pnpm test
 */
const baseUrl = process.env.LATEX_API_URL;
const apiKey = process.env.LATEX_API_KEY;

const HELLO = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello from the SDK integration test.",
  "\\end{document}",
].join("\n");

describe.skipIf(!baseUrl || !apiKey)("integration (LATEX_API_URL)", () => {
  const api = new LatexApi({ baseUrl, apiKey });

  it("compiles a hello document to PDF", async () => {
    const result = await api.compile({ source: HELLO, options: { force: true } });
    expect(new TextDecoder().decode(result.pdf.subarray(0, 5))).toBe("%PDF-");
    expect(result.jobId).toMatch(/[0-9a-f-]{36}/);
    const log = await api.jobs.log(result.jobId);
    expect(log).toContain("Output written");
  });

  it("reports LaTeX errors as CompileFailedError", async () => {
    const error = await api
      .compile({
        files: [
          {
            path: "main.tex",
            content: "\\documentclass{article}\\begin{document}\\foo\\end{document}",
          },
        ],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompileFailedError);
    expect((error as CompileFailedError).diagnostics.length).toBeGreaterThan(0);
  });

  it("runs an async job to completion", async () => {
    const job = await api.jobs.create({ source: HELLO });
    const types: string[] = [];
    const finished = await api.jobs.wait(job.id, {
      onEvent: (e) => types.push(e.type),
      timeoutMs: 120_000,
    });
    expect(finished.status).toBe("succeeded");
    expect(types.at(-1)).toBe("done");
    expect((await api.jobs.pdf(job.id)).byteLength).toBeGreaterThan(100);
  });

  it("lists templates and reads limits", async () => {
    const templates = await api.templates.list();
    expect(Array.isArray(templates)).toBe(true);
    const limits = await api.limits();
    expect(limits.engines).toContain("pdflatex");
  });
});
