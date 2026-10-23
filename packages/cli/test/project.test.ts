import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/exit";
import {
  createWatchFilter,
  packProject,
  parseCompileOptions,
  parseEngine,
  pdfBaseName,
  prepareProject,
  projectIgnorePatterns,
  referencesOtherFiles,
  resolveProject,
} from "../src/project";

describe("resolveProject", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "latex-cli-project-"));
    await fs.mkdir(path.join(dir, "paper", "sections"), { recursive: true });
    await fs.writeFile(path.join(dir, "paper", "main.tex"), "\\input{sections/intro}");
    await fs.writeFile(path.join(dir, "paper", "sections", "intro.tex"), "Hi");
    await fs.writeFile(path.join(dir, "paper", "main.aux"), "junk");
    await fs.writeFile(path.join(dir, "paper", "main.pdf"), "old pdf");
    await fs.writeFile(path.join(dir, "paper", "huge.bin"), Buffer.alloc(64 * 1024));
    await fs.mkdir(path.join(dir, "single"));
    await fs.writeFile(path.join(dir, "single", "thesis.tex"), "x");
    await fs.mkdir(path.join(dir, "many"));
    await fs.writeFile(path.join(dir, "many", "a.tex"), "a");
    await fs.writeFile(path.join(dir, "many", "b.tex"), "b");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("sends a .tex file on its own by default", async () => {
    const project = await resolveProject("paper/sections/intro.tex", { cwd: dir });
    expect(project).toEqual({
      dir: path.join(dir, "paper", "sections"),
      entrypoint: "intro.tex",
      outputPath: path.join(dir, "paper", "sections", "intro.pdf"),
      kind: "file",
      transport: "single",
      filePath: path.join(dir, "paper", "sections", "intro.tex"),
    });
    const prepared = await prepareProject(project, { engine: "xelatex" });
    expect(prepared.input).toEqual({
      source: "Hi",
      entrypoint: "intro.tex",
      engine: "xelatex",
      options: undefined,
    });
    expect(prepared.bytes).toBe(2);
    expect(prepared.hint).toBeUndefined();
  });

  it("hints when a single file references other files", async () => {
    const project = await resolveProject("paper/main.tex", { cwd: dir });
    expect(project.transport).toBe("single");
    const prepared = await prepareProject(project);
    expect("source" in prepared.input).toBe(true);
    expect(prepared.hint).toMatch(
      /compile the folder instead: latex-api compile .* --entrypoint main\.tex/,
    );
  });

  it("packs the parent folder with --with-siblings or --entrypoint", async () => {
    const withSiblings = await resolveProject("paper/main.tex", { cwd: dir, withSiblings: true });
    expect(withSiblings.transport).toBe("zip");
    expect(withSiblings.dir).toBe(path.join(dir, "paper"));
    expect(withSiblings.entrypoint).toBe("main.tex");
    const prepared = await prepareProject(withSiblings);
    expect("zip" in prepared.input).toBe(true);
    expect(prepared.hint).toBeUndefined();
    expect(prepared.bytes).toBeGreaterThan(100);
    const entries = Object.keys(unzipSync((prepared.input as { zip: Uint8Array }).zip)).sort();
    expect(entries).toEqual(["huge.bin", "main.tex", "sections/intro.tex"]);

    const viaEntrypoint = await resolveProject("paper/sections/intro.tex", {
      cwd: dir,
      entrypoint: "intro.tex",
    });
    expect(viaEntrypoint.transport).toBe("zip");
  });

  it("guesses main.tex or the single .tex in a directory", async () => {
    const paper = await resolveProject("paper", { cwd: dir });
    expect(paper.entrypoint).toBe("main.tex");
    expect(paper.transport).toBe("zip");
    expect(paper.filePath).toBeUndefined();
    expect((await resolveProject("single", { cwd: dir })).entrypoint).toBe("thesis.tex");
    const many = await resolveProject("many", { cwd: dir });
    expect(many.entrypoint).toBeUndefined();
    expect(many.outputPath).toBe(path.join(dir, "many", "many.pdf"));
  });

  it("honours --entrypoint and --output", async () => {
    const project = await resolveProject("many", {
      cwd: dir,
      entrypoint: "b.tex",
      output: "out/final.pdf",
    });
    expect(project.entrypoint).toBe("b.tex");
    expect(project.outputPath).toBe(path.join(dir, "out", "final.pdf"));
    await expect(
      resolveProject("many", { cwd: dir, entrypoint: "nope.tex" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("rejects missing paths and non-tex files", async () => {
    await expect(resolveProject("missing", { cwd: dir })).rejects.toMatchObject({ exitCode: 2 });
    await expect(resolveProject("paper/main.aux", { cwd: dir })).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("packs without build artifacts or the output pdf", async () => {
    const project = await resolveProject("paper", { cwd: dir });
    expect(projectIgnorePatterns(project)).toEqual(["/main.pdf"]);
    const entries = Object.keys(unzipSync(await packProject(project))).sort();
    expect(entries).toEqual(["huge.bin", "main.tex", "sections/intro.tex"]);

    const ignored = createWatchFilter(project);
    expect(ignored(path.join(project.dir, "main.pdf"), false)).toBe(true);
    expect(ignored(path.join(project.dir, "main.aux"), false)).toBe(true);
    expect(ignored(path.join(project.dir, "main.tex"), false)).toBe(false);
    expect(ignored(path.join(project.dir, ".git"), true)).toBe(true);
    expect(ignored(path.join(project.dir, "sections"), true)).toBe(false);
  });
});

describe("referencesOtherFiles", () => {
  it("detects file-reading macros outside comments", () => {
    expect(referencesOtherFiles("\\documentclass{article}\\begin{document}Hi\\end{document}")).toBe(
      false,
    );
    expect(referencesOtherFiles("\\input{sections/intro}")).toBe(true);
    expect(referencesOtherFiles("\\include{chapter1}")).toBe(true);
    expect(referencesOtherFiles("\\includegraphics[width=1cm]{fig}")).toBe(true);
    expect(referencesOtherFiles("\\bibliography{refs}")).toBe(true);
    expect(referencesOtherFiles("\\addbibresource{refs.bib}")).toBe(true);
    expect(referencesOtherFiles("% \\input{old}\nHello")).toBe(false);
    expect(referencesOtherFiles("50\\% done % \\include{x}")).toBe(false);
    expect(referencesOtherFiles("\\inputenc{utf8}")).toBe(false);
  });
});

describe("flag parsing", () => {
  it("validates engines", () => {
    expect(parseEngine(undefined)).toBeUndefined();
    expect(parseEngine("xelatex")).toBe("xelatex");
    expect(() => parseEngine("tex")).toThrow(CliError);
  });

  it("builds compile options", () => {
    expect(parseCompileOptions({})).toBeUndefined();
    expect(
      parseCompileOptions({
        timeout: "5000",
        bibliography: "biber",
        force: true,
        webhook: "https://h.test/x",
      }),
    ).toEqual({
      timeoutMs: 5000,
      bibliography: "biber",
      force: true,
      webhookUrl: "https://h.test/x",
    });
    expect(() => parseCompileOptions({ timeout: "soon" })).toThrow(/--timeout/);
    expect(() => parseCompileOptions({ bibliography: "latex" })).toThrow(/--bibliography/);
    expect(() => parseCompileOptions({ webhook: "not a url" })).toThrow(/--webhook/);
  });

  it("derives pdf names", () => {
    expect(pdfBaseName("main.tex")).toBe("main");
    expect(pdfBaseName("paper/thesis.LTX")).toBe("thesis");
    expect(pdfBaseName("")).toBe("output");
  });
});
