export const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export type Engine = (typeof ENGINES)[number];

export const DEFAULT_ENGINE: Engine = "pdflatex";

export function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

export const BIBLIOGRAPHY_MODES = ["auto", "bibtex", "biber", "none"] as const;
export type BibliographyMode = (typeof BIBLIOGRAPHY_MODES)[number];

const MAGIC_PROGRAM = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([a-z]+)\s*$/im;

/**
 * Reads the `% !TEX program = xelatex` magic comment from the first lines of a source file.
 */
export function detectEngineFromSource(source: string): Engine | undefined {
  const head = source.slice(0, 2000);
  const match = MAGIC_PROGRAM.exec(head);
  if (!match) return undefined;
  const program = match[1]?.toLowerCase();
  if (program === "latex" || program === "pdflatex") return "pdflatex";
  if (program === "xelatex" || program === "xetex") return "xelatex";
  if (program === "lualatex" || program === "luatex" || program === "luahbtex") return "lualatex";
  return undefined;
}
