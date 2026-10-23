import { describe, expect, it } from "vitest";
import { parseLatexLog, summarizeDiagnostics } from "../src/index";

describe("parseLatexLog", () => {
  it("parses file-line-error messages with context", () => {
    const log = [
      "This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2026)",
      "(./main.tex",
      "LaTeX2e <2025-11-01>",
      "./main.tex:12: Undefined control sequence.",
      "l.12 \\foo",
      "          bar",
      "",
      "./main.tex:20: LaTeX Error: Environment itemizee undefined.",
      "",
      "See the LaTeX manual or LaTeX Companion for explanation.",
      ")",
    ].join("\n");
    const d = parseLatexLog(log);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({
      severity: "error",
      file: "main.tex",
      line: 12,
      message: "Undefined control sequence.",
    });
    expect(d[0]!.context).toContain("l.12");
    expect(d[1]).toMatchObject({ severity: "error", file: "main.tex", line: 20, source: "LaTeX" });
  });

  it("parses warnings, missing files and box messages with the file stack", () => {
    const log = [
      "(./main.tex (./sections/intro.tex",
      "LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 7.",
      "Overfull \\hbox (12.3pt too wide) in paragraph at lines 9--11",
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `\\\\' on input line 15.",
      ")",
      "! LaTeX Error: File `missing.sty' not found.",
      "",
      "Type X to quit or <RETURN> to proceed,",
      "l.3 \\usepackage{missing}",
      "LaTeX Warning: There were undefined references.",
      "No pages of output.",
      ")",
    ].join("\n");
    const d = parseLatexLog(log);
    const refWarning = d.find((x) => x.message.startsWith("Reference"));
    expect(refWarning).toMatchObject({ severity: "warning", file: "sections/intro.tex", line: 7 });
    const overfull = d.find((x) => x.message.startsWith("Overfull"));
    expect(overfull).toMatchObject({ severity: "info", file: "sections/intro.tex", line: 9 });
    const hyperref = d.find((x) => x.source === "hyperref");
    expect(hyperref).toMatchObject({ severity: "warning", line: 15 });
    const missing = d.find((x) => x.message.includes("missing.sty"));
    expect(missing).toMatchObject({ severity: "error", file: "main.tex", line: 3 });
    expect(d.some((x) => x.message === "No pages of output")).toBe(true);
    const summary = summarizeDiagnostics(d);
    expect(summary.errors).toBeGreaterThanOrEqual(2);
    expect(summary.warnings).toBeGreaterThanOrEqual(2);
  });

  it("joins wrapped 79-column lines and dedupes", () => {
    const key = "k".repeat(79 - "LaTeX Warning: Citation `' on p".length);
    const first = `LaTeX Warning: Citation \`${key}' on p`;
    expect(first.length).toBe(79);
    const log = `(./main.tex\n${first}\nage 1 undefined on input line 3.\n${first}\nage 1 undefined on input line 3.\n)`;
    const d = parseLatexLog(log);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", line: 3 });
    expect(d[0]!.message).toContain("undefined");
  });

  it("parses biber and latexmk failures", () => {
    const log = [
      "ERROR - Cannot find 'refs.bib'!",
      "Latexmk: Errors, so I did not complete making targets",
    ].join("\n");
    const d = parseLatexLog(log);
    expect(d[0]).toMatchObject({ severity: "error", source: "biber" });
    expect(d[1]).toMatchObject({ severity: "error", source: "latexmk" });
  });

  it("reports sandbox-induced shell escape warnings as info", () => {
    const log = "(./main.tex\nPackage epstopdf Warning: Shell escape feature is not enabled.\n)";
    const d = parseLatexLog(log);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "info", source: "epstopdf" });
    expect(summarizeDiagnostics(d)).toMatchObject({ warnings: 0, infos: 1 });
  });
});
