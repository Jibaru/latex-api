import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  type CompileRequest,
  type Compiler,
  CompilerUnavailableError,
  type Limits,
  type Logger,
  type RawCompileOutput,
} from "@latex-api/core";
import Docker from "dockerode";
import type { FsWorkspaces } from "./fs-workspaces";

export interface DockerCompilerOptions {
  image: string;
  limits: Limits;
  workspaces: FsWorkspaces;
  logger: Logger;
  user: string;
  runtime?: string;
  seccompProfile?: string;
  socketPath?: string;
  /** Pull the image at startup if it is missing. */
  pullIfMissing?: boolean;
}

const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_LOG = 8 * 1024 * 1024;

/**
 * Runs each compile in a disposable sibling container created through the Docker socket.
 * The container has no network, a read-only root filesystem, dropped capabilities and
 * cgroup limits; the only writable paths are the job workspace and a small tmpfs.
 */
export class DockerSiblingCompiler implements Compiler {
  private readonly docker: Docker;
  private versionCache: string | undefined;
  private seccompJson: string | undefined;

  constructor(private readonly opts: DockerCompilerOptions) {
    this.docker = opts.socketPath ? new Docker({ socketPath: opts.socketPath }) : new Docker();
  }

  async version(): Promise<string> {
    if (this.versionCache) return this.versionCache;
    try {
      const info = await this.docker.getImage(this.opts.image).inspect();
      const label = info.Config?.Labels?.["org.opencontainers.image.version"];
      const digest = (info.RepoDigests?.[0] ?? info.Id).split("@").pop() ?? info.Id;
      this.versionCache = `${this.opts.image}#${label ?? digest.slice(7, 19)}`;
      return this.versionCache;
    } catch (error) {
      if (this.opts.pullIfMissing && isNotFound(error)) {
        await this.pull();
        return this.version();
      }
      throw new CompilerUnavailableError(
        `Compiler image ${this.opts.image} is not available: ${message(error)}`,
      );
    }
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.docker.ping();
      await this.version();
      return { ok: true, detail: this.versionCache };
    } catch (error) {
      return { ok: false, detail: message(error) };
    }
  }

  async pull(): Promise<void> {
    this.opts.logger.info({ image: this.opts.image }, "pulling compiler image");
    const stream = await this.docker.pull(this.opts.image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
    this.versionCache = undefined;
  }

  async compile(request: CompileRequest, signal: AbortSignal): Promise<RawCompileOutput> {
    const { workspace, options } = request;
    const { limits } = this.opts;
    const timeoutS = Math.ceil(options.timeoutMs / 1000);
    const hostDir = this.opts.workspaces.hostDir(workspace.jobId);
    const localDir = this.opts.workspaces.dir(workspace.jobId);
    const started = Date.now();
    const log = this.opts.logger.child({ jobId: workspace.jobId });

    const securityOpt = ["no-new-privileges"];
    const seccomp = await this.loadSeccomp();
    if (seccomp) securityOpt.push(`seccomp=${seccomp}`);

    const container = await this.docker.createContainer({
      Image: this.opts.image,
      Cmd: [workspace.engine, workspace.entrypoint, options.bibliography, String(timeoutS)],
      User: this.opts.user,
      WorkingDir: "/work",
      Env: ["HOME=/tmp/home", "TEXMFVAR=/tmp/home/texmf-var", "TEXMFCONFIG=/tmp/home/texmf-config"],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Labels: { "latex-api.job": workspace.jobId, "latex-api.role": "compile" },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Binds: [`${hostDir}:/work:rw`],
        // biber is a PAR binary that unpacks itself before running, so it gets its own
        // exec-capable tmpfs; everything else stays noexec.
        Tmpfs: {
          "/tmp": "rw,nosuid,nodev,noexec,size=256m",
          "/var/cache/biber": "rw,nosuid,nodev,exec,size=128m,mode=1777",
        },
        Memory: limits.jobMemoryBytes,
        MemorySwap: limits.jobMemoryBytes,
        NanoCpus: Math.round(limits.jobCpus * 1e9),
        PidsLimit: limits.jobPids,
        CapDrop: ["ALL"],
        SecurityOpt: securityOpt,
        Ulimits: [
          { Name: "nofile", Soft: 1024, Hard: 1024 },
          { Name: "fsize", Soft: 256 * 1024 * 1024, Hard: 256 * 1024 * 1024 },
          { Name: "cpu", Soft: timeoutS + 5, Hard: timeoutS + 10 },
        ],
        ...(this.opts.runtime ? { Runtime: this.opts.runtime } : {}),
      },
    });

    let stdout = "";
    let truncated = false;
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdout.length < MAX_STDOUT) {
        stdout += text;
        request.onLog?.(text);
      } else if (!truncated) {
        truncated = true;
        stdout += "\n[latex-api] output truncated\n";
      }
    });

    let timedOut = false;
    let killed = false;
    const kill = async (reason: string) => {
      if (killed) return;
      killed = true;
      log.warn({ reason }, "killing compile container");
      await container.kill({ signal: "SIGKILL" }).catch(() => undefined);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void kill("timeout");
    }, options.timeoutMs);
    const onAbort = () => {
      if (signal.reason === "timeout") timedOut = true;
      void kill(String(signal.reason ?? "abort"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    let exitCode: number | null = null;
    try {
      const attached = await container.attach({ stream: true, stdout: true, stderr: true });
      this.docker.modem.demuxStream(attached, sink, sink);
      await container.start();
      const wait = (await container.wait()) as { StatusCode: number };
      exitCode = wait.StatusCode;
      if (exitCode === 137 && !killed) timedOut = true; // OOM or kernel kill
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await container.remove({ force: true, v: true }).catch(() => undefined);
    }

    const durationMs = Date.now() - started;
    const base = path.basename(workspace.entrypoint).replace(/\.(tex|ltx|latex)$/i, "");
    const outDir = path.join(localDir, ...workspace.entrypoint.split("/").slice(0, -1));
    const [pdf, texLog] = await Promise.all([
      readOptional(path.join(outDir, `${base}.pdf`)),
      readOptionalText(path.join(outDir, `${base}.log`), MAX_LOG),
    ]);

    return {
      exitCode: killed ? null : exitCode,
      timedOut,
      log: texLog ?? "",
      stdout,
      pdf: pdf ?? undefined,
      durationMs,
    };
  }

  /** Kills any leftover compile containers from a previous process (crash recovery). */
  async reapOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["latex-api.role=compile"] },
    });
    for (const c of containers) {
      await this.docker
        .getContainer(c.Id)
        .remove({ force: true, v: true })
        .catch(() => undefined);
    }
    return containers.length;
  }

  private async loadSeccomp(): Promise<string | undefined> {
    if (!this.opts.seccompProfile) return undefined;
    if (this.seccompJson) return this.seccompJson;
    const raw = await fs.readFile(this.opts.seccompProfile, "utf8");
    this.seccompJson = JSON.stringify(JSON.parse(raw));
    return this.seccompJson;
  }
}

async function readOptional(file: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(file));
  } catch {
    return null;
  }
}

async function readOptionalText(file: string, max: number): Promise<string | null> {
  const bytes = await readOptional(file);
  if (!bytes) return null;
  const slice = bytes.byteLength > max ? bytes.subarray(0, max) : bytes;
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 404;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
