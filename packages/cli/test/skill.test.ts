import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installedVersion, parseFrontmatter, planInstall, readBundledSkill } from "../src/skill";
import { CLI_VERSION } from "../src/version";
import { runCli, tempHome } from "./helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
  version: string;
};
const repoSkill = path.join(here, "..", "..", "..", "skills", "latex-api", "SKILL.md");

describe("versions", () => {
  it("CLI_VERSION matches package.json", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("the repo skill's frontmatter version matches package.json", () => {
    const fm = parseFrontmatter(readFileSync(repoSkill, "utf8"));
    expect(fm.name).toBe("latex-api");
    expect(fm.version).toBe(pkg.version);
    expect(fm.description?.length).toBeGreaterThan(80);
  });

  it("the skill mentions every top-level command", async () => {
    const { root } = await import("../src/app");
    const text = readFileSync(repoSkill, "utf8");
    for (const name of Object.keys(root.commands)) expect(text, name).toContain(name);
  });
});

describe("skill install", () => {
  it("plans the documented locations", () => {
    const cwd = path.resolve("/work/project");
    expect(planInstall("claude", { project: true }, cwd).path).toBe(
      path.join(cwd, ".claude", "skills", "latex-api", "SKILL.md"),
    );
    expect(planInstall("claude", {}, cwd).scope).toBe("global");
    expect(planInstall("agents", {}, cwd).path).toBe(
      path.join(cwd, ".agents", "skills", "latex-api", "SKILL.md"),
    );
    expect(planInstall("cursor", {}, cwd).path).toBe(
      path.join(cwd, ".cursor", "rules", "latex-api.mdc"),
    );
    expect(() => planInstall("cursor", { global: true }, cwd)).toThrow(/per project/);
    expect(() => planInstall("claude", { global: true, project: true }, cwd)).toThrow();
    expect(planInstall("vendor/skills", {}, cwd).path).toBe(
      path.join(cwd, "vendor", "skills", "latex-api", "SKILL.md"),
    );
  });

  it("installs, is idempotent, refuses a different version without --force", async () => {
    const home = await tempHome();
    const project = await tempHome("latex-skill-proj-");
    const opts = { home, cwd: project };
    const first = await runCli(["skill", "install", "--target", "agents"], opts);
    expect(first.code, first.stdout).toBe(0);
    expect(first.envelope.data).toMatchObject({
      status: "installed",
      version: CLI_VERSION,
      previousVersion: null,
    });
    const file = path.join(project, ".agents", "skills", "latex-api", "SKILL.md");
    expect(readFileSync(file, "utf8")).toBe(readBundledSkill().content);

    const again = await runCli(["skill", "install", "--target", "agents"], opts);
    expect(again.envelope.data.status).toBe("unchanged");

    await fs.writeFile(
      file,
      readFileSync(file, "utf8").replace(`version: ${CLI_VERSION}`, "version: 0.1.0"),
    );
    const conflict = await runCli(["skill", "install", "--target", "agents"], opts);
    expect(conflict.code).toBe(5);
    expect(conflict.envelope.error).toMatchObject({ code: "skill_conflict" });
    expect(conflict.envelope.error.details).toMatchObject({
      installedVersion: "0.1.0",
      bundledVersion: CLI_VERSION,
    });

    const forced = await runCli(["skill", "install", "--target", "agents", "--force"], opts);
    expect(forced.envelope.data).toMatchObject({ status: "updated", previousVersion: "0.1.0" });
  });

  it("writes a Cursor rule that keeps the version, and the global Claude skill under HOME", async () => {
    const home = await tempHome();
    const project = await tempHome("latex-skill-proj-");
    const cursor = await runCli(["skill", "install", "--target", "cursor"], { home, cwd: project });
    const mdc = readFileSync(cursor.envelope.data.path, "utf8");
    expect(mdc.startsWith("---\ndescription: ")).toBe(true);
    expect(installedVersion(mdc)).toBe(CLI_VERSION);
    const claude = await runCli(["skill", "install"], { home, cwd: project });
    expect(claude.envelope.data.path).toBe(
      path.join(home, ".claude", "skills", "latex-api", "SKILL.md"),
    );
    expect(existsSync(claude.envelope.data.path)).toBe(true);
  });
});
