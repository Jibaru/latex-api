/**
 * Patterns excluded by `packDirectory` before `.latexapiignore` and explicit `ignore`
 * options are applied: VCS metadata and LaTeX build artifacts.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  ".latexapiignore",
  ".DS_Store",
  "Thumbs.db",
  "*.aux",
  "*.log",
  "*.out",
  "*.toc",
  "*.lof",
  "*.lot",
  "*.bbl",
  "*.blg",
  "*.fls",
  "*.fdb_latexmk",
  "*.synctex.gz",
  "*.synctex(busy)",
  "*.xdv",
  "*.dvi",
  "*.nav",
  "*.snm",
  "*.vrb",
  "*.run.xml",
  "*.bcf",
  "*.idx",
  "*.ilg",
  "*.ind",
];

interface Rule {
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

export type IgnoreMatcher = (relativePath: string, isDirectory?: boolean) => boolean;

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; `**` elsewhere matches anything.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        out += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if ("\\^$.|+(){}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export function compileIgnorePattern(raw: string): Rule | undefined {
  let pattern = raw.replace(/\r$/, "");
  if (!pattern.trim() || pattern.trimStart().startsWith("#")) return undefined;
  pattern = pattern.replace(/(?<!\\)\s+$/, "");
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("\\")) pattern = pattern.slice(1);
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes("/")) {
    anchored = true;
  }
  if (!pattern) return undefined;
  const body = globToRegexSource(pattern);
  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;
  return { regex: new RegExp(source), negated, dirOnly };
}

/**
 * Builds a gitignore-like matcher. Later patterns win over earlier ones; `!` re-includes.
 * Paths must be relative, POSIX-style (`sections/intro.tex`), without a leading `./`.
 */
export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const rules: Rule[] = [];
  for (const raw of patterns) {
    const rule = compileIgnorePattern(raw);
    if (rule) rules.push(rule);
  }
  return (relativePath, isDirectory = false) => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized) return false;
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(normalized)) ignored = !rule.negated;
    }
    return ignored;
  };
}

/** Parses the content of a `.latexapiignore` (or `.gitignore`) file into patterns. */
export function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line && !line.startsWith("#"));
}
