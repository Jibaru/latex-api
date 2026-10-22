import { promises as fs } from "node:fs";
import path from "node:path";
import type { Engine, Project, Workspace, Workspaces } from "@latex-api/core";

interface WorkspaceMeta {
  entrypoint: string;
  engine: Engine;
  createdAt: string;
}

/**
 * Workspaces live in `<dataDir>/work/<jobId>/` with a sidecar `<jobId>.json`.
 * The compile container bind-mounts `<hostDataDir>/work/<jobId>` at `/work`.
 */
export class FsWorkspaces implements Workspaces {
  constructor(
    private readonly dataDir: string,
    private readonly hostDataDir: string = dataDir,
  ) {}

  dir(jobId: string): string {
    return path.join(this.dataDir, "work", safeId(jobId));
  }

  hostDir(jobId: string): string {
    return joinHost(this.hostDataDir, "work", safeId(jobId));
  }

  private metaPath(jobId: string): string {
    return path.join(this.dataDir, "work", `${safeId(jobId)}.json`);
  }

  async create(jobId: string, project: Project): Promise<Workspace> {
    const root = this.dir(jobId);
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true, mode: 0o755 });
    for (const file of project.files) {
      const target = path.join(root, ...file.path.split("/"));
      const rel = path.relative(root, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Refusing to write outside workspace: ${file.path}`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.writeFile(target, file.content, { mode: 0o644 });
    }
    const meta: WorkspaceMeta = {
      entrypoint: project.entrypoint,
      engine: project.engine,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(this.metaPath(jobId), JSON.stringify(meta), "utf8");
    return { jobId, entrypoint: project.entrypoint, engine: project.engine };
  }

  async open(jobId: string): Promise<Workspace | null> {
    try {
      const raw = await fs.readFile(this.metaPath(jobId), "utf8");
      const meta = JSON.parse(raw) as WorkspaceMeta;
      await fs.access(this.dir(jobId));
      return { jobId, entrypoint: meta.entrypoint, engine: meta.engine };
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    await fs.rm(this.dir(jobId), { recursive: true, force: true });
    await fs.rm(this.metaPath(jobId), { force: true });
  }

  /** Removes workspaces older than `maxAgeMs` (crash leftovers). */
  async sweep(maxAgeMs: number): Promise<number> {
    const workRoot = path.join(this.dataDir, "work");
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(workRoot);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      const full = path.join(workRoot, entry);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  }
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid job id: ${id}`);
  return id;
}

function joinHost(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}
