import { promises as fs } from "node:fs";
import path from "node:path";
import {
  normalizeProjectPath,
  type ProjectFile,
  TEMPLATE_ID,
  type Template,
  type TemplateManifest,
  type TemplateRepository,
} from "@latex-api/core";

const IGNORED = new Set(["manifest.json", "preview.png", "preview.pdf", ".DS_Store", "README.md"]);

/**
 * Templates are directories under `templatesDir`, each with a `manifest.json` and the
 * project files. Contents are cached in memory after first access (templates are static).
 */
export class FsTemplateRepository implements TemplateRepository {
  private cache: Map<string, { template: Template; files: ProjectFile[] }> | undefined;

  constructor(private readonly templatesDir: string) {}

  private async load(): Promise<Map<string, { template: Template; files: ProjectFile[] }>> {
    if (this.cache) return this.cache;
    const map = new Map<string, { template: Template; files: ProjectFile[] }>();
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(this.templatesDir, { withFileTypes: true });
    } catch {
      this.cache = map;
      return map;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.templatesDir, entry.name);
      let manifest: TemplateManifest;
      try {
        manifest = JSON.parse(
          await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
        ) as TemplateManifest;
      } catch {
        continue;
      }
      if (!TEMPLATE_ID.test(manifest.id) || manifest.id !== entry.name) continue;
      const files = await collect(dir, dir);
      const editable = new Set(manifest.editable ?? [manifest.entrypoint]);
      const template: Template = {
        ...manifest,
        variables: manifest.variables ?? [],
        tags: manifest.tags ?? [],
        files: files
          .map((f) => ({
            path: f.path,
            size: f.content.byteLength,
            editable: editable.has(f.path),
          }))
          .sort((a, b) => Number(b.editable) - Number(a.editable) || a.path.localeCompare(b.path)),
      };
      map.set(manifest.id, { template, files });
    }
    this.cache = map;
    return map;
  }

  async list(): Promise<Template[]> {
    return Array.from((await this.load()).values())
      .map((e) => e.template)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Template | null> {
    return (await this.load()).get(id)?.template ?? null;
  }

  async files(id: string): Promise<ProjectFile[] | null> {
    const entry = (await this.load()).get(id);
    return entry ? entry.files.map((f) => ({ path: f.path, content: f.content })) : null;
  }

  async readFile(id: string, filePath: string): Promise<Uint8Array | null> {
    const entry = (await this.load()).get(id);
    if (!entry) return null;
    const normalized = normalizeProjectPath(filePath);
    return entry.files.find((f) => f.path === normalized)?.content ?? null;
  }

  /** Absolute path of the preview image, if the template ships one. */
  async previewPath(id: string): Promise<string | null> {
    const entry = (await this.load()).get(id);
    if (!entry?.template.preview) return null;
    const full = path.join(this.templatesDir, id, entry.template.preview);
    try {
      await fs.access(full);
      return full;
    } catch {
      return null;
    }
  }
}

async function collect(root: string, dir: string): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collect(root, full)));
    } else if (entry.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (IGNORED.has(entry.name) && !rel.includes("/")) continue;
      out.push({ path: rel, content: new Uint8Array(await fs.readFile(full)) });
    }
  }
  return out;
}
