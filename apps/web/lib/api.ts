import { serverApiBase } from "./shared";

export type Engine = "pdflatex" | "xelatex" | "lualatex";

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: "paper" | "cv" | "brochure" | "poster" | "report" | "letter" | "other";
  engine: Engine;
  entrypoint: string;
  tags: string[];
}

export interface Limits {
  maxUploadBytes: number;
  maxUnpackedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  syncTimeoutMs: number;
  jobTimeoutMs: number;
  jobTimeoutMaxMs: number;
  jobMemoryBytes: number;
  jobCpus: number;
  artifactTtlHours: number;
  rateLimitPerKeyPerHour: number;
  rateLimitConcurrentPerKey: number;
  engines: string[];
}

/** Mirrors the manifest.json of each template in packages/templates; used when the API is unreachable. */
export const FALLBACK_TEMPLATES: TemplateSummary[] = [
  {
    id: "ieee-conference",
    name: "IEEE conference paper",
    description:
      "Two-column IEEEtran conference paper with abstract, keywords, TikZ figure, pgfplots chart, booktabs table, equations and a BibTeX bibliography.",
    category: "paper",
    engine: "pdflatex",
    entrypoint: "main.tex",
    tags: ["ieee", "conference", "bibtex"],
  },
  {
    id: "ieee-journal",
    name: "IEEE journal article",
    description:
      "IEEEtran journal article with running heads, drop-cap introduction, algorithm, flow diagram, chart, appendix, bibliography and author biographies.",
    category: "paper",
    engine: "pdflatex",
    entrypoint: "main.tex",
    tags: ["ieee", "journal", "bibtex"],
  },
  {
    id: "cv-awesome",
    name: "Awesome-CV résumé",
    description:
      "One-page résumé based on the Awesome-CV class: centred header, social links, summary, experience, skills and education in separate files. Requires LuaLaTeX.",
    category: "cv",
    engine: "lualatex",
    entrypoint: "cv.tex",
    tags: ["cv", "lualatex", "fontspec"],
  },
  {
    id: "cv-altacv",
    name: "AltaCV résumé",
    description:
      "Two-column résumé based on the AltaCV class: contact icons, experience, projects, wheel chart, achievements, skill tags, star ratings, education and referees.",
    category: "cv",
    engine: "pdflatex",
    entrypoint: "cv.tex",
    tags: ["cv", "two-column", "fontawesome"],
  },
  {
    id: "trifold-brochure",
    name: "Tri-fold brochure",
    description:
      "Six-panel tri-fold brochure on landscape A4 built with the leaflet class: covers, schedule, map, process diagram and feature panels, all drawn with TikZ.",
    category: "brochure",
    engine: "pdflatex",
    entrypoint: "brochure.tex",
    tags: ["brochure", "leaflet", "tikz"],
  },
  {
    id: "infographic-poster",
    name: "Infographic poster (A0)",
    description:
      "Three-column A0 portrait poster built with tikzposter: custom colour theme, pgfplots charts, flow diagram, object tree and TikZ-drawn icons.",
    category: "poster",
    engine: "pdflatex",
    entrypoint: "poster.tex",
    tags: ["poster", "tikzposter", "pgfplots"],
  },
  {
    id: "report-es",
    name: "Informe técnico (español)",
    description:
      "Spanish technical report with a colour cover, abstract, indexes, three chapters in separate files, TikZ figure and chart, booktabs tables, code listing and bibliography.",
    category: "report",
    engine: "pdflatex",
    entrypoint: "main.tex",
    tags: ["report", "spanish", "babel"],
  },
];

export const FALLBACK_LIMITS: Limits = {
  maxUploadBytes: 50 * 1024 * 1024,
  maxUnpackedBytes: 200 * 1024 * 1024,
  maxFiles: 500,
  maxFileBytes: 50 * 1024 * 1024,
  syncTimeoutMs: 60_000,
  jobTimeoutMs: 300_000,
  jobTimeoutMaxMs: 600_000,
  jobMemoryBytes: 2 * 1024 * 1024 * 1024,
  jobCpus: 2,
  artifactTtlHours: 24,
  rateLimitPerKeyPerHour: 60,
  rateLimitConcurrentPerKey: 5,
  engines: ["pdflatex", "xelatex", "lualatex"],
};

async function getJson<T>(path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${serverApiBase()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export interface Fetched<T> {
  data: T;
  live: boolean;
}

export async function fetchTemplates(): Promise<Fetched<TemplateSummary[]>> {
  const body = await getJson<{ templates: TemplateSummary[] }>("/v1/templates");
  if (body?.templates?.length) return { data: body.templates, live: true };
  return { data: FALLBACK_TEMPLATES, live: false };
}

export async function fetchLimits(): Promise<Fetched<Limits>> {
  const body = await getJson<Limits>("/v1/limits");
  if (body && typeof body.maxUploadBytes === "number") return { data: body, live: true };
  return { data: FALLBACK_LIMITS, live: false };
}

const NBSP = " ";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)}${NBSP}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}${NBSP}MB`;
  return `${Math.round(bytes / 1024)}${NBSP}KB`;
}

export function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}${NBSP}min`;
  return `${Math.round(ms / 1000)}${NBSP}s`;
}
