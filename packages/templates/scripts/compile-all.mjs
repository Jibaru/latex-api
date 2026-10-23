#!/usr/bin/env node
// Compiles every template in ../templates with the latex-compiler Docker image
// and fails if any of them does not produce a PDF.
//
//   COMPILER_IMAGE=latex-compiler:dev node scripts/compile-all.mjs [id ...]
//
// Works on Windows (Git Bash / PowerShell) and Linux: bind-mount paths are
// normalised to forward slashes so Docker Desktop accepts them.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE = process.env.COMPILER_IMAGE ?? "latex-compiler:dev";
const TIMEOUT_S = Number(process.env.COMPILE_TIMEOUT_S ?? 180);
const KEEP = process.env.KEEP_ARTIFACTS === "1";
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ENGINES = new Set(["pdflatex", "xelatex", "lualatex"]);
const ARTIFACT_EXT = [
  ".aux",
  ".log",
  ".out",
  ".bbl",
  ".blg",
  ".fls",
  ".fdb_latexmk",
  ".toc",
  ".lof",
  ".lot",
  ".run.xml",
  ".bcf",
  ".synctex.gz",
  ".synctex",
  ".pdf",
  ".xdv",
  ".nav",
  ".snm",
  ".vrb",
  ".idx",
  ".ilg",
  ".ind",
  ".glo",
  ".gls",
  ".bbl-SAVE-ERROR",
  ".bcf-SAVE-ERROR",
  ".xmpi",
];

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(here, "..", "templates");

function toDockerPath(p) {
  // C:\foo\bar -> C:/foo/bar (Docker Desktop accepts drive-letter paths with forward slashes)
  return resolve(p).replace(/\\/g, "/");
}

function cleanArtifacts(dir) {
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (ARTIFACT_EXT.some((ext) => entry.name.endsWith(ext))) rmSync(full, { force: true });
    }
  };
  walk(dir);
}

function pageCount(logFile) {
  // latexmk/pdfTeX write "Output written on main.pdf (3 pages, 123 bytes)." at the end of the log.
  if (!existsSync(logFile)) return 0;
  const m = readFileSync(logFile, "latin1").match(/Output written on .*?\((\d+) pages?/g);
  if (!m) return 0;
  const last = m[m.length - 1].match(/\((\d+) pages?/);
  return last ? Number(last[1]) : 0;
}

function loadManifests(filter) {
  const ids = readdirSync(templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => filter.length === 0 || filter.includes(id))
    .sort();
  const manifests = [];
  for (const id of ids) {
    const file = join(templatesDir, id, "manifest.json");
    if (!existsSync(file)) throw new Error(`${id}: manifest.json missing`);
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.id !== id)
      throw new Error(`${id}: manifest.id (${manifest.id}) must equal directory name`);
    if (!TEMPLATE_ID.test(id)) throw new Error(`${id}: invalid template id`);
    if (!ENGINES.has(manifest.engine)) throw new Error(`${id}: unknown engine ${manifest.engine}`);
    if (!existsSync(join(templatesDir, id, manifest.entrypoint)))
      throw new Error(`${id}: entrypoint not found`);
    for (const f of manifest.editable ?? []) {
      if (!existsSync(join(templatesDir, id, f)))
        throw new Error(`${id}: editable file not found: ${f}`);
    }
    manifests.push(manifest);
  }
  return manifests;
}

function compile(manifest) {
  const dir = join(templatesDir, manifest.id);
  cleanArtifacts(dir);
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    // On Linux the bind mount keeps host ownership: run as the caller so TeX can write.
    ...(typeof process.getuid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : []),
    "-v",
    `${toDockerPath(dir)}:/work`,
    IMAGE,
    manifest.engine,
    manifest.entrypoint,
    "auto",
    String(TIMEOUT_S),
  ];
  const started = Date.now();
  const res = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ms = Date.now() - started;
  const pdf = join(dir, manifest.entrypoint.replace(/\.tex$/i, ".pdf"));
  const log = join(dir, manifest.entrypoint.replace(/\.tex$/i, ".log"));
  const ok = res.status === 0 && existsSync(pdf) && statSync(pdf).size > 0;
  const pages = ok ? pageCount(log) : 0;
  let errors = "";
  if (!ok) {
    if (existsSync(log)) {
      errors = readFileSync(log, "utf8")
        .split(/\r?\n/)
        .filter((l) => /^(!|.*:\d+: )/.test(l))
        .slice(0, 8)
        .join("\n");
    } else {
      errors = (res.stderr || res.stdout || `exit ${res.status}`)
        .trim()
        .split(/\r?\n/)
        .slice(-8)
        .join("\n");
    }
  }
  if (!KEEP) cleanArtifacts(dir);
  return { id: manifest.id, engine: manifest.engine, ok, pages, ms, errors };
}

function main() {
  const filter = process.argv.slice(2);
  const manifests = loadManifests(filter);
  if (manifests.length === 0) {
    console.error("no templates found");
    process.exit(1);
  }
  const probe = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  if (probe.status !== 0) {
    console.error(`docker image ${IMAGE} not found (set COMPILER_IMAGE or build it first)`);
    process.exit(1);
  }
  console.log(`Compiling ${manifests.length} template(s) with ${IMAGE}\n`);
  const results = [];
  for (const m of manifests) {
    process.stdout.write(`- ${m.id} (${m.engine}) ... `);
    const r = compile(m);
    results.push(r);
    console.log(r.ok ? `ok, ${r.pages} page(s), ${(r.ms / 1000).toFixed(1)}s` : "FAILED");
    if (!r.ok && r.errors) console.log(r.errors.replace(/^/gm, "    "));
  }
  console.log("");
  console.table(
    results.map((r) => ({
      template: r.id,
      engine: r.engine,
      status: r.ok ? "ok" : "failed",
      pages: r.pages,
      seconds: Number((r.ms / 1000).toFixed(1)),
    })),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} template(s) failed: ${failed.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
}

main();
