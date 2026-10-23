import type { Diagnostic } from "./diagnostic";

const FILE_LINE_ERROR =
  /^(?:\.\/)?([^\s:]+\.(?:tex|ltx|sty|cls|bib|bbl|def|cfg|clo|fd|lua))?:(\d+): (.+)$/;
const BANG_ERROR = /^! (.+)$/;
const LATEX_WARNING = /^(?:LaTeX|Class|Package)\s*(?:(\S+)\s+)?Warning: (.+)$/;
const FONT_WARNING = /^LaTeX Font Warning: (.+)$/;
const PDFTEX_WARNING = /^(?:pdfTeX|XeTeX|LuaTeX) warning(?: \([^)]*\))?: (.+)$/;
const BOX_WARNING =
  /^(Overfull|Underfull) \\([hv])box \((.+?)\) (?:in paragraph |detected |has occurred while \\output is active )?(?:at lines (\d+)--(\d+)|at line (\d+))?/;
const ON_INPUT_LINE = /on input line (\d+)\.?$/;
const LINE_NUMBER = /^l\.(\d+)\s?(.*)$/;
const MISSING_FILE = /^! LaTeX Error: File `([^']+)' not found\.?$/;
const UNDEFINED_CS = /^! Undefined control sequence\.?$/;
const EMERGENCY_STOP = /^! Emergency stop\.?$/;
const FATAL = /^! ==> Fatal error occurred/;
const RUNAWAY = /^Runaway argument\?/;
const NO_PAGES = /^No pages of output\.?$/;
const BIBER_ERROR = /^(?:ERROR|WARN) - (.+)$/;
const LATEXMK_ERROR = /^Latexmk: (.+)$/;
/** Warnings caused by the sandbox itself (shell escape is always off): reported as info. */
const SANDBOX_NOTICES = [/shell escape feature is not enabled/i];

/**
 * Parses a LaTeX log (ideally produced with `-file-line-error`) into structured diagnostics.
 * It tracks the file stack from TeX's parenthesised file opens so warnings get a file.
 */
export function parseLatexLog(log: string, maxDiagnostics = 200): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = unwrapLines(log.split(/\r?\n/));
  const fileStack: string[] = [];
  const seen = new Set<string>();

  const push = (raw: Diagnostic) => {
    if (diagnostics.length >= maxDiagnostics) return;
    const d: Diagnostic =
      raw.severity === "warning" && SANDBOX_NOTICES.some((re) => re.test(raw.message))
        ? { ...raw, severity: "info" }
        : raw;
    const key = `${d.severity}|${d.file ?? ""}|${d.line ?? ""}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(d);
  };

  const currentFile = () => fileStack[fileStack.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    trackFileStack(line, fileStack);

    let m: RegExpExecArray | null;

    if ((m = FILE_LINE_ERROR.exec(line))) {
      const file = m[1] ?? currentFile();
      const lineNo = Number(m[2]);
      const message = m[3]!.trim();
      push({
        severity: "error",
        message,
        file: cleanFile(file),
        line: lineNo,
        context: collectContext(lines, i),
        source: inferSource(message),
      });
      continue;
    }

    if ((m = MISSING_FILE.exec(line))) {
      push({
        severity: "error",
        message: `File "${m[1]}" not found`,
        file: cleanFile(currentFile()),
        line: findLineNumber(lines, i),
        context: collectContext(lines, i),
        source: "LaTeX",
      });
      continue;
    }

    if (FATAL.test(line) || EMERGENCY_STOP.test(line)) {
      push({ severity: "error", message: line.replace(/^! /, ""), file: cleanFile(currentFile()) });
      continue;
    }

    if ((m = BANG_ERROR.exec(line))) {
      const message = m[1]!.trim();
      push({
        severity: "error",
        message,
        file: cleanFile(currentFile()),
        line: findLineNumber(lines, i),
        context: collectContext(lines, i),
        source: inferSource(message, UNDEFINED_CS.test(line) ? "TeX" : undefined),
      });
      continue;
    }

    if (RUNAWAY.test(line)) {
      push({
        severity: "error",
        message: "Runaway argument (unbalanced braces or missing closing delimiter)",
        file: cleanFile(currentFile()),
        line: findLineNumber(lines, i),
        context: collectContext(lines, i),
      });
      continue;
    }

    if ((m = BOX_WARNING.exec(line))) {
      const kind = m[1]!;
      const box = m[2] === "h" ? "hbox" : "vbox";
      const detail = m[3]!;
      const start = m[4] ?? m[6];
      push({
        severity: "info",
        message: `${kind} \\${box} (${detail})`,
        file: cleanFile(currentFile()),
        line: start ? Number(start) : undefined,
        source: "TeX",
      });
      continue;
    }

    if ((m = LATEX_WARNING.exec(line))) {
      const source = m[1];
      const message = m[2]!.trim();
      const lineMatch = ON_INPUT_LINE.exec(message);
      push({
        severity: "warning",
        message: message.replace(ON_INPUT_LINE, "").replace(/\s+$/, "").replace(/\.$/, ""),
        file: cleanFile(currentFile()),
        line: lineMatch ? Number(lineMatch[1]) : undefined,
        source: source ?? "LaTeX",
      });
      continue;
    }

    if ((m = FONT_WARNING.exec(line))) {
      const message = m[1]!.trim();
      const lineMatch = ON_INPUT_LINE.exec(message);
      push({
        severity: "warning",
        message: message.replace(ON_INPUT_LINE, "").replace(/\.$/, ""),
        file: cleanFile(currentFile()),
        line: lineMatch ? Number(lineMatch[1]) : undefined,
        source: "LaTeX Font",
      });
      continue;
    }

    if ((m = PDFTEX_WARNING.exec(line))) {
      push({ severity: "warning", message: m[1]!.trim(), source: "engine" });
      continue;
    }

    if ((m = BIBER_ERROR.exec(line))) {
      push({
        severity: line.startsWith("ERROR") ? "error" : "warning",
        message: m[1]!.trim(),
        source: "biber",
      });
      continue;
    }

    if ((m = LATEXMK_ERROR.exec(line)) && /error|fail|not found/i.test(m[1]!)) {
      push({ severity: "error", message: m[1]!.trim(), source: "latexmk" });
      continue;
    }

    if (NO_PAGES.test(line)) {
      push({ severity: "error", message: "No pages of output", source: "TeX" });
    }
  }

  return diagnostics;
}

/** TeX wraps log lines at 79 columns; join continuation lines back together. */
function unwrapLines(lines: string[], width = 79): string[] {
  const out: string[] = [];
  let buffer: string | null = null;
  for (const line of lines) {
    if (buffer !== null) {
      buffer += line;
      if (line.length < width) {
        out.push(buffer);
        buffer = null;
      }
      continue;
    }
    if (line.length === width && !/^[()]+$/.test(line)) {
      buffer = line;
      continue;
    }
    out.push(line);
  }
  if (buffer !== null) out.push(buffer);
  return out;
}

const FILE_OPEN =
  /\((\.{0,2}\/[^\s()]+|[^\s()]+\.(?:tex|sty|cls|def|cfg|clo|fd|ltx|bbl|aux|toc|lof|lot|out|bib))/g;

function trackFileStack(line: string, stack: string[]): void {
  let idx = 0;
  while (idx < line.length) {
    const ch = line[idx];
    if (ch === "(") {
      FILE_OPEN.lastIndex = idx;
      const m = FILE_OPEN.exec(line);
      if (m && m.index === idx) {
        stack.push(m[1]!);
        idx = m.index + m[0].length;
        continue;
      }
      stack.push("");
    } else if (ch === ")") {
      if (stack.length > 0) stack.pop();
    }
    idx++;
  }
  // Drop anonymous groups that happen to be on top so file attribution stays sane.
  while (stack.length > 0 && stack[stack.length - 1] === "") stack.pop();
}

function cleanFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const cleaned = file.replace(/^\.\//, "");
  if (cleaned.startsWith("/")) return undefined; // system file, not useful to the user
  return cleaned;
}

function findLineNumber(lines: string[], from: number, lookahead = 12): number | undefined {
  for (let j = from + 1; j < Math.min(lines.length, from + lookahead); j++) {
    const m = LINE_NUMBER.exec(lines[j]!);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function collectContext(lines: string[], from: number, lookahead = 6): string | undefined {
  const ctx: string[] = [];
  for (let j = from + 1; j < Math.min(lines.length, from + 1 + lookahead); j++) {
    const l = lines[j]!;
    if (l.trim() === "" && ctx.length > 0) break;
    if (/^! /.test(l)) break;
    if (l.trim() !== "") ctx.push(l);
  }
  return ctx.length > 0 ? ctx.join("\n") : undefined;
}

function inferSource(message: string, fallback?: string): string | undefined {
  const m =
    /^(?:LaTeX|Package|Class) (\S+) Error/.exec(message) ?? /^Package (\S+) Error/.exec(message);
  if (m) return m[1];
  if (/^LaTeX Error/.test(message)) return "LaTeX";
  return fallback;
}

export function summarizeDiagnostics(diagnostics: Diagnostic[]): {
  errors: number;
  warnings: number;
  infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}
