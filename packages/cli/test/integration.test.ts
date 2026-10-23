import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Opt-in end-to-end test of the built CLI against a running server:
 *   pnpm build && LATEX_API_URL=http://localhost:3000 LATEX_API_TOKEN=... pnpm test
 */
const baseUrl = process.env.LATEX_API_URL;
const apiKey = process.env.LATEX_API_TOKEN;
const run = promisify(execFile);
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.mjs");

describe.skipIf(!baseUrl || !apiKey)("integration (LATEX_API_URL)", () => {
  let dir: string;
  beforeAll(async () => {
    await fs.access(bin);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "latex-cli-e2e-"));
    await fs.writeFile(
      path.join(dir, "main.tex"),
      "\\documentclass{article}\\begin{document}Hello from the CLI test.\\end{document}\n",
    );
    await fs.writeFile(
      path.join(dir, "broken.tex"),
      "\\documentclass{article}\\begin{document}\\foo\\end{document}\n",
    );
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const cli = (...args: string[]) =>
    run(process.execPath, [bin, ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", LATEX_API_HOME: path.join(dir, ".home") },
    });

  it("prints help and version", async () => {
    const { stdout } = await cli("--help");
    expect(stdout).toContain("compile");
    expect((await cli("--version")).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("compiles a directory and writes the PDF", async () => {
    await cli("compile", ".", "--entrypoint", "main.tex", "-o", "out.pdf", "--force");
    const pdf = await fs.readFile(path.join(dir, "out.pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("exits with 1 and diagnostics in the error envelope on LaTeX errors", async () => {
    const result = await cli("compile", "broken.tex").then(
      () => ({ code: 0, stdout: "" }),
      (e: { code: number; stdout: string }) => e,
    );
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe("compile_failed");
    expect(envelope.error.details.diagnostics.length).toBeGreaterThan(0);
  });

  it("lists templates and limits", async () => {
    const { stdout } = await cli("templates", "list", "--json");
    expect(JSON.parse(stdout).data).toHaveProperty("templates");
    const limits = JSON.parse((await cli("limits", "--json")).stdout) as {
      data: { limits: { engines: string[] } };
    };
    expect(limits.data.limits.engines).toContain("pdflatex");
  });
});
