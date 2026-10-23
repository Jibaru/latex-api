import type { Diagnostic, Job } from "@jibaru/latex-api-sdk";
import { describe, expect, it } from "vitest";
import {
  formatDiagnostic,
  formatDiagnostics,
  formatJobFailure,
  sortDiagnostics,
  summarize,
} from "../src/diagnostics";

const diagnostics: Diagnostic[] = [
  { severity: "warning", message: "Overfull \\hbox (12pt too wide)", file: "./main.tex", line: 40 },
  { severity: "info", message: "Package hyperref Message" },
  {
    severity: "error",
    message: "Undefined control sequence.",
    file: "./sections/intro.tex",
    line: 3,
    context: "l.3 \\foo",
  },
  { severity: "error", message: "Missing $ inserted.", file: "main.tex" },
  { severity: "warning", message: "Citation `knuth' undefined", file: ".\\main.tex", line: 12 },
];

describe("formatDiagnostics", () => {
  it("prints errors first with file:line prefixes and no colors when disabled", () => {
    const out = formatDiagnostics(diagnostics, {
      color: false,
      logUrl: "https://api.test/v1/jobs/1/log",
    });
    expect(out.split("\n")).toEqual([
      "sections/intro.tex:3: error: Undefined control sequence.",
      "    l.3 \\foo",
      "main.tex: error: Missing $ inserted.",
      "main.tex:40: warning: Overfull \\hbox (12pt too wide)",
      "main.tex:12: warning: Citation `knuth' undefined",
      "info: Package hyperref Message",
      "2 errors, 2 warnings",
      "Full log: https://api.test/v1/jobs/1/log",
    ]);
  });

  it("truncates after max entries with a +N more line", () => {
    const many: Diagnostic[] = Array.from({ length: 25 }, (_, i) => ({
      severity: i % 2 ? "warning" : "error",
      message: `m${i}`,
      line: i,
    }));
    const lines = formatDiagnostics(many, { color: false, max: 20, jobId: "abc" }).split("\n");
    expect(lines).toHaveLength(23);
    expect(lines[20]).toBe("+5 more");
    expect(lines[21]).toBe("13 errors, 12 warnings");
    expect(lines[22]).toBe("Full log: latex-api jobs logs abc");
    expect(lines.slice(0, 13).every((l) => l.includes("error:"))).toBe(true);
  });

  it("colors by severity by default", () => {
    const error = formatDiagnostic({ severity: "error", message: "x" }, true);
    const warning = formatDiagnostic({ severity: "warning", message: "x" }, true);
    expect(error).toContain("error");
    expect(warning).toContain("warning");
    expect(formatDiagnostic({ severity: "error", message: "x" }, false)).toBe("error: x");
  });

  it("sorts stably and summarizes", () => {
    expect(sortDiagnostics(diagnostics).map((d) => d.severity)).toEqual([
      "error",
      "error",
      "warning",
      "warning",
      "info",
    ]);
    expect(summarize(diagnostics)).toEqual({ errors: 2, warnings: 2, info: 1 });
  });

  it("describes failed jobs", () => {
    const job: Job = {
      id: "j1",
      status: "timed_out",
      mode: "async",
      engine: "pdflatex",
      entrypoint: "main.tex",
      createdAt: "2026-10-22T00:00:00.000Z",
      expiresAt: "2026-10-23T00:00:00.000Z",
      options: { timeoutMs: 1000, bibliography: "auto" },
      result: {
        cached: false,
        durationMs: 1000,
        exitCode: null,
        errors: 0,
        warnings: 0,
        logUrl: "https://api.test/v1/jobs/j1/log",
        diagnostics: [],
      },
      links: { self: "https://api.test/v1/jobs/j1" },
    };
    expect(formatJobFailure(job, false)).toBe(
      "Compilation timed out\nFull log: https://api.test/v1/jobs/j1/log",
    );
    expect(
      formatJobFailure(
        {
          ...job,
          status: "failed",
          error: { reason: "compile_failed", message: "LaTeX reported errors" },
        },
        false,
      ),
    ).toContain("LaTeX reported errors");
  });
});
