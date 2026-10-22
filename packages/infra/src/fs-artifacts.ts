import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ArtifactStore, StoredArtifact } from "@latex-api/core";

/** Artifacts live under `<dataDir>/<key>`; keys are validated relative paths. */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly dataDir: string) {}

  private resolve(key: string): string {
    if (!/^[A-Za-z0-9_\-./]+$/.test(key) || key.includes("..") || key.startsWith("/")) {
      throw new Error(`Invalid artifact key: ${key}`);
    }
    return path.join(this.dataDir, ...key.split("/"));
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<StoredArtifact> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
    await fs.writeFile(`${target}.meta`, JSON.stringify({ contentType }), "utf8");
    return { key, contentType, size: data.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async stat(key: string): Promise<StoredArtifact | null> {
    const target = this.resolve(key);
    try {
      const stat = await fs.stat(target);
      let contentType = "application/octet-stream";
      try {
        contentType = (
          JSON.parse(await fs.readFile(`${target}.meta`, "utf8")) as { contentType: string }
        ).contentType;
      } catch {
        // default
      }
      return { key, contentType, size: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const target = this.resolve(key);
    try {
      await fs.access(target);
    } catch {
      return null;
    }
    return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  }

  async deletePrefix(prefix: string): Promise<void> {
    const target = this.resolve(prefix);
    await fs.rm(target, { recursive: true, force: true });
  }

  async usage(): Promise<{ usedBytes: number; freeBytes?: number }> {
    const root = path.join(this.dataDir, "artifacts");
    let used = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          try {
            used += (await fs.stat(full)).size;
          } catch {
            // ignore
          }
        }
      }
    };
    await walk(root);
    let freeBytes: number | undefined;
    try {
      const sf = await fs.statfs(this.dataDir);
      freeBytes = Number(sf.bavail) * Number(sf.bsize);
    } catch {
      freeBytes = undefined;
    }
    return { usedBytes: used, freeBytes };
  }
}
