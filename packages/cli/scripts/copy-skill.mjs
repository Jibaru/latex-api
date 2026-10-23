// Copies the repo-root agent skill into the package so `latex-api skill get|install`
// serves the manual for this exact version. Fails the build if the versions disagree.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const source = path.resolve(pkgDir, "../../skills/latex-api/SKILL.md");
const target = path.join(pkgDir, "dist", "skill", "SKILL.md");

const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const skill = readFileSync(source, "utf8");
const version = /^---[\s\S]*?^version:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(skill)?.[1];
if (version !== pkg.version) {
  console.error(
    `skills/latex-api/SKILL.md version (${version}) != package.json version (${pkg.version})`,
  );
  process.exit(1);
}
mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`copied SKILL.md v${version} -> ${path.relative(pkgDir, target)}`);
