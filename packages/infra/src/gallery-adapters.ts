import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClerkClient } from "@clerk/backend";
import type { Archiver, Embedder, Logger, ProjectFile, UserDirectory } from "@latex-api/core";
import { zipSync } from "fflate";

type Extractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export interface LocalEmbedderOptions {
  /** Hugging Face model id with ONNX weights. */
  model?: string;
  /** Where downloaded weights are cached (survives restarts when it is on the data volume). */
  cacheDir: string;
  logger: Logger;
}

/**
 * Multilingual sentence embeddings computed in-process with transformers.js (ONNX runtime).
 * The model (~120 MB quantized) is downloaded on first use into `cacheDir`. E5 models expect
 * "query: " and "passage: " prefixes.
 */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  private loading: Promise<Extractor> | undefined;

  constructor(private readonly opts: LocalEmbedderOptions) {
    this.model = opts.model ?? "Xenova/multilingual-e5-small";
  }

  embedPassage(text: string): Promise<number[]> {
    return this.embed(`passage: ${text}`);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.embed(`query: ${text.slice(0, 500)}`);
  }

  /** Starts loading the model in the background (boot), so the first search is fast. */
  warmUp(): void {
    void this.extractor().catch(() => undefined);
  }

  private async embed(text: string): Promise<number[]> {
    const extractor = await this.extractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data, (v) => Math.round(v * 1e6) / 1e6);
  }

  private extractor(): Promise<Extractor> {
    this.loading ??= this.load().catch((error) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async load(): Promise<Extractor> {
    const started = Date.now();
    // The Next standalone build cannot trace onnxruntime-node's native binaries, so the Docker
    // image installs transformers.js on its own and points TRANSFORMERS_MODULE at its entry file.
    const override = process.env.TRANSFORMERS_MODULE;
    const transformers = (
      override
        ? await import(
            /* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(override).href
          )
        : await import("@huggingface/transformers")
    ) as typeof import("@huggingface/transformers");
    transformers.env.cacheDir = path.resolve(this.opts.cacheDir);
    transformers.env.allowLocalModels = false;
    const extractor = (await transformers.pipeline("feature-extraction", this.model, {
      dtype: "q8",
    })) as unknown as Extractor;
    this.opts.logger.info(
      { model: this.model, ms: Date.now() - started },
      "gallery embedding model loaded",
    );
    return extractor;
  }
}

/** Embedder for tests and environments without the model: deterministic bag of words. */
export class HashingEmbedder implements Embedder {
  readonly model = "hashing-256";
  async embedPassage(text: string) {
    return hashVector(text);
  }
  async embedQuery(text: string) {
    return hashVector(text);
  }
}

function hashVector(text: string): number[] {
  const v = new Array<number>(256).fill(0);
  const words = text
    .toLowerCase()
    .replace(/^(query|passage):\s*/, "")
    .split(/[^a-z0-9áéíóúñ]+/)
    .filter(Boolean);
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % 256]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const fflateArchiver: Archiver = {
  zip(files: ProjectFile[]): Uint8Array {
    const tree: Record<string, Uint8Array> = {};
    for (const f of files) tree[f.path] = f.content;
    return zipSync(tree, { level: 6 });
  },
};

const PROFILE_TTL_MS = 10 * 60_000;

/** Public author names from Clerk: username, else first + last name. */
export class ClerkUserDirectory implements UserDirectory {
  private readonly client: ReturnType<typeof createClerkClient>;
  private readonly cache = new Map<
    string,
    { value: { name: string; imageUrl?: string } | null; at: number }
  >();

  constructor(secretKey: string) {
    this.client = createClerkClient({ secretKey });
  }

  async profile(userId: string) {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.value;
    try {
      const user = await this.client.users.getUser(userId);
      const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
      const name = user.username || full || "Anonymous";
      const value = { name, imageUrl: user.hasImage ? user.imageUrl : undefined };
      this.cache.set(userId, { value, at: Date.now() });
      return value;
    } catch {
      return null;
    }
  }
}

export const anonymousDirectory: UserDirectory = {
  async profile() {
    return null;
  },
};
