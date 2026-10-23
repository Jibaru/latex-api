import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject, DEFAULT_LIMITS } from "@latex-api/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSiblingCompiler } from "../src/docker-compiler";
import { FsWorkspaces } from "../src/fs-workspaces";
import { createLogger } from "../src/memory";

const image = process.env.COMPILER_IMAGE ?? "latex-compiler:dev";
const run = process.env.RUN_DOCKER_TESTS === "1" ? describe : describe.skip;
const enc = (s: string) => new TextEncoder().encode(s);

run("DockerSiblingCompiler (integration)", () => {
  let dataDir: string;
  let workspaces: FsWorkspaces;
  let compiler: DockerSiblingCompiler;

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "latex-api-"));
    workspaces = new FsWorkspaces(dataDir);
    compiler = new DockerSiblingCompiler({
      image,
      limits: { ...DEFAULT_LIMITS, jobCpus: 2 },
      workspaces,
      logger: createLogger("silent"),
      seccompProfile: path.resolve(__dirname, "../../../docker/seccomp/clsi-profile.json"),
      user:
        process.platform === "win32"
          ? "1000:1000"
          : `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    });
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const options = { timeoutMs: 120_000, bibliography: "auto" as const, maxPasses: 8 };

  it("reports a version", async () => {
    const v = await compiler.version();
    expect(v).toContain(image);
  });

  it("compiles a pdflatex document", async () => {
    const project = createProject(
      {
        files: [
          {
            path: "main.tex",
            content: enc(
              "\\documentclass{article}\\begin{document}Hello \\LaTeX{} API\\end{document}",
            ),
          },
        ],
      },
      DEFAULT_LIMITS,
    );
    const ws = await workspaces.create("11111111-1111-4111-8111-111111111111", project);
    const out = await compiler.compile({ workspace: ws, options }, new AbortController().signal);
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);
    expect(out.pdf?.byteLength).toBeGreaterThan(1000);
    expect(out.log).toContain("Output written");
    await workspaces.remove(ws.jobId);
  });

  it("compiles xelatex with fontspec and reports errors with lines", async () => {
    const project = createProject(
      {
        files: [
          {
            path: "cv.tex",
            content: enc(
              "% !TEX program = xelatex\n\\documentclass{article}\\usepackage{fontspec}\\setmainfont{TeX Gyre Pagella}\n\\begin{document}Fonts\n\\undefinedmacro\n\\end{document}",
            ),
          },
        ],
      },
      DEFAULT_LIMITS,
    );
    expect(project.engine).toBe("xelatex");
    const ws = await workspaces.create("22222222-2222-4222-8222-222222222222", project);
    const out = await compiler.compile({ workspace: ws, options }, new AbortController().signal);
    expect(out.exitCode).not.toBe(0);
    expect(out.log).toMatch(/cv\.tex:4: Undefined control sequence/);
    await workspaces.remove(ws.jobId);
  });

  it("blocks shell escape and kills runaway documents", async () => {
    const project = createProject(
      {
        files: [
          {
            path: "main.tex",
            content: enc(
              "\\documentclass{article}\\begin{document}\\immediate\\write18{touch /work/pwned}x\\loop\\iftrue\\repeat\\end{document}",
            ),
          },
        ],
      },
      DEFAULT_LIMITS,
    );
    const ws = await workspaces.create("33333333-3333-4333-8333-333333333333", project);
    const out = await compiler.compile(
      { workspace: ws, options: { ...options, timeoutMs: 8_000 } },
      new AbortController().signal,
    );
    expect(out.timedOut).toBe(true);
    await expect(fs.access(path.join(workspaces.dir(ws.jobId), "pwned"))).rejects.toThrow();
    await workspaces.remove(ws.jobId);
  }, 60_000);
});
