// The agent skill (skills/latex-api/SKILL.md at the repo root) ships inside the package as
// dist/skill/SKILL.md, so `latex-api skill get` always prints the manual for this exact CLI
// version and `skill install` can drop it where an agent looks for it.

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Embedded at build time so a compiled binary (no dist/ on disk) still has the manual.
import embeddedSkill from "../../../skills/latex-api/SKILL.md?raw";
import { atomicWrite } from "./blocks/atomic-write";
import { rt } from "./blocks/runtime";
import { CliError, EXIT } from "./exit";

export interface SkillFile {
  content: string;
  path: string;
  name: string;
  version: string;
  description: string;
}

/** Where the bundled skill can be: next to the built CLI, or the repo copy in development. */
export function skillCandidates(): string[] {
  const here = import.meta.url;
  return [
    fileURLToPath(new URL("./skill/SKILL.md", here)),
    fileURLToPath(new URL("../dist/skill/SKILL.md", here)),
    fileURLToPath(new URL("../../../skills/latex-api/SKILL.md", here)),
  ];
}

export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = (kv[2] as string).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[kv[1] as string] = value;
  }
  return fields;
}

function toSkillFile(content: string, file: string): SkillFile {
  const fm = parseFrontmatter(content);
  return {
    content,
    path: file,
    name: fm.name ?? "latex-api",
    version: fm.version ?? "unknown",
    description: fm.description ?? "",
  };
}

/** dist/skill/SKILL.md next to the CLI, else the copy embedded in the bundle. */
export function readBundledSkill(candidates = skillCandidates()): SkillFile {
  for (const file of candidates) {
    if (existsSync(file)) return toSkillFile(readFileSync(file, "utf8"), file);
  }
  if (embeddedSkill) return toSkillFile(embeddedSkill, "(embedded)");
  throw new CliError("skill_not_bundled", "This build does not include the agent skill", {
    exitCode: EXIT.COMPILE_FAILED,
    hint: "Install it from the repository: npx skills add jibaru/latex-api",
  });
}

export const SKILL_TARGETS = ["claude", "agents", "cursor"] as const;
export type SkillScope = "global" | "project";

function userHome(): string {
  const env = rt().env;
  return (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
}

export interface InstallPlan {
  target: string;
  scope: SkillScope | "directory";
  path: string;
  format: "skill" | "cursor-rule";
}

export function planInstall(
  target: string,
  scope: { global?: boolean; project?: boolean },
  cwd = process.cwd(),
): InstallPlan {
  if (scope.global && scope.project) {
    throw new CliError("usage", "Use either --global or --project", { exitCode: EXIT.USAGE });
  }
  if (target === "claude" || target === "agents") {
    const resolved: SkillScope = scope.project
      ? "project"
      : scope.global
        ? "global"
        : target === "claude"
          ? "global"
          : "project";
    const root = resolved === "global" ? userHome() : cwd;
    const dir = target === "claude" ? ".claude" : ".agents";
    return {
      target,
      scope: resolved,
      path: path.join(root, dir, "skills", "latex-api", "SKILL.md"),
      format: "skill",
    };
  }
  if (target === "cursor") {
    if (scope.global) {
      throw new CliError("usage", "Cursor rules are per project; drop --global", {
        exitCode: EXIT.USAGE,
        hint: "latex-api skill install --target cursor",
      });
    }
    return {
      target,
      scope: "project",
      path: path.join(cwd, ".cursor", "rules", "latex-api.mdc"),
      format: "cursor-rule",
    };
  }
  if (!target.trim()) throw new CliError("usage", "--target is empty", { exitCode: EXIT.USAGE });
  return {
    target,
    scope: "directory",
    path: path.join(path.resolve(cwd, target), "latex-api", "SKILL.md"),
    format: "skill",
  };
}

/** Converts SKILL.md into a Cursor project rule (.mdc) that keeps the version visible. */
export function toCursorRule(skill: SkillFile): string {
  const body = skill.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return [
    "---",
    `description: ${skill.description.replace(/\r?\n/g, " ")}`,
    "globs:",
    "alwaysApply: false",
    "---",
    `<!-- latex-api skill v${skill.version} (installed by \`latex-api skill install\`) -->`,
    body.trimStart(),
  ].join("\n");
}

export function installedVersion(content: string): string | undefined {
  const fm = parseFrontmatter(content);
  if (fm.version) return fm.version;
  return /latex-api skill v([\w.+-]+)/.exec(content)?.[1];
}

export interface InstallResult {
  target: string;
  scope: InstallPlan["scope"];
  path: string;
  version: string;
  previousVersion: string | null;
  status: "installed" | "updated" | "unchanged";
}

export function installSkill(skill: SkillFile, plan: InstallPlan, force: boolean): InstallResult {
  const content = plan.format === "cursor-rule" ? toCursorRule(skill) : skill.content;
  const base = { target: plan.target, scope: plan.scope, path: plan.path, version: skill.version };
  const existed = existsSync(plan.path);
  let previousVersion: string | null = null;
  if (existed) {
    const existing = readFileSync(plan.path, "utf8");
    previousVersion = installedVersion(existing) ?? null;
    if (existing === content) return { ...base, previousVersion, status: "unchanged" };
    if (!force) {
      const why =
        previousVersion && previousVersion !== skill.version
          ? `version ${previousVersion} is installed`
          : "a modified copy is installed";
      throw new CliError("skill_conflict", `${plan.path} exists (${why}); not overwriting`, {
        exitCode: EXIT.CONFLICT,
        hint: `Re-run with --force to replace it with v${skill.version}`,
        details: {
          path: plan.path,
          installedVersion: previousVersion,
          bundledVersion: skill.version,
        },
      });
    }
  }
  atomicWrite(plan.path, content, { mode: 0o644 });
  return { ...base, previousVersion, status: existed ? "updated" : "installed" };
}
