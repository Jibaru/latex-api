import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompileRequest, Compiler, RawCompileOutput } from "@latex-api/core";
import { loadConfig } from "@latex-api/infra";
import { build, type Container } from "../src/container";
import { createHttpApp } from "../src/http/app";

export class FakeCompiler implements Compiler {
  calls: CompileRequest[] = [];
  behaviour: (
    req: CompileRequest,
    signal: AbortSignal,
  ) => Promise<RawCompileOutput> | RawCompileOutput = () => ({
    exitCode: 0,
    timedOut: false,
    log: "(./main.tex)\nOutput written on main.pdf (1 page).",
    stdout: "",
    pdf: new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF"),
    durationMs: 5,
  });
  async version() {
    return "fake-compiler";
  }
  async ping() {
    return { ok: true };
  }
  async compile(req: CompileRequest, signal: AbortSignal) {
    this.calls.push(req);
    return this.behaviour(req, signal);
  }
}

export async function testContainer(env: Record<string, string> = {}): Promise<{
  container: Container;
  app: ReturnType<typeof createHttpApp>;
  compiler: FakeCompiler;
  cleanup: () => Promise<void>;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "latex-api-test-"));
  const templatesDir = path.join(dataDir, "templates");
  await fs.mkdir(path.join(templatesDir, "hello"), { recursive: true });
  await fs.writeFile(
    path.join(templatesDir, "hello", "manifest.json"),
    JSON.stringify({
      id: "hello",
      name: "Hello",
      description: "Smallest template",
      category: "other",
      engine: "pdflatex",
      entrypoint: "main.tex",
      tags: ["test"],
      license: "MIT",
      variables: [],
    }),
  );
  await fs.writeFile(
    path.join(templatesDir, "hello", "main.tex"),
    "\\documentclass{article}\\begin{document}\\input{body}\\end{document}",
  );
  await fs.writeFile(path.join(templatesDir, "hello", "body.tex"), "Hello");

  const config = loadConfig({
    DATA_DIR: dataDir,
    TEMPLATES_DIR: templatesDir,
    API_KEYS: "test:secret,other:other-secret",
    PUBLIC_URL: "http://api.test",
    LOG_LEVEL: "silent",
    COMPILER_IMAGE: "fake",
    ...env,
  });
  const container = build(config);
  const compiler = new FakeCompiler();
  container.deps.compiler = compiler;
  const { InlineJobQueue } = await import("@latex-api/infra");
  if (container.queue instanceof InlineJobQueue) {
    container.queue.setHandler((jobId, signal) =>
      container.useCases.processCompileJob.execute(jobId, signal).then(() => undefined),
    );
  }
  const app = createHttpApp(() => container);
  return {
    container,
    app,
    compiler,
    cleanup: async () => {
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export const auth = { authorization: "Bearer secret" };
export const TEX = "\\documentclass{article}\\begin{document}Hello\\end{document}";
