import { randomUUID } from "node:crypto";
import type {
  ApiKeyResolver,
  Clock,
  IdGenerator,
  JobEvent,
  JobEvents,
  Logger,
  Principal,
  RateLimitDecision,
  RateLimiter,
  WebhookNotifier,
} from "@latex-api/core";
import pino from "pino";

/** In-process job events. Sufficient while API and workers share a process. */
export class MemoryJobEvents implements JobEvents {
  private readonly listeners = new Map<string, Set<(event: JobEvent) => void>>();
  private readonly cancelHandlers = new Map<string, Set<() => void>>();
  /** Keeps the last events per job so late SSE subscribers can catch up. */
  private readonly recent = new Map<string, JobEvent[]>();

  publish(event: JobEvent): void {
    const buffer = this.recent.get(event.jobId) ?? [];
    buffer.push(event);
    if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
    this.recent.set(event.jobId, buffer);
    if (event.type === "done" || event.type === "error") {
      setTimeout(() => this.recent.delete(event.jobId), 60_000).unref?.();
    }
    for (const listener of this.listeners.get(event.jobId) ?? []) {
      try {
        listener(event);
      } catch {
        // listener errors must not break publishers
      }
    }
  }

  replay(jobId: string): JobEvent[] {
    return [...(this.recent.get(jobId) ?? [])];
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const set = this.listeners.get(jobId) ?? new Set();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }

  requestCancel(jobId: string): boolean {
    const handlers = this.cancelHandlers.get(jobId);
    if (!handlers || handlers.size === 0) return false;
    for (const handler of handlers) handler();
    return true;
  }

  onCancel(jobId: string, handler: () => void): () => void {
    const set = this.cancelHandlers.get(jobId) ?? new Set();
    set.add(handler);
    this.cancelHandlers.set(jobId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.cancelHandlers.delete(jobId);
    };
  }
}

/** Sliding-window counters and concurrency slots held in memory. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly slots = new Map<string, number>();

  async consume(bucket: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = (this.windows.get(bucket) ?? []).filter((t) => t > cutoff);
    if (hits.length >= limit) {
      const oldest = hits[0] ?? now;
      this.windows.set(bucket, hits);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1000, oldest + windowMs - now),
        limit,
      };
    }
    hits.push(now);
    this.windows.set(bucket, hits);
    this.gc();
    return { allowed: true, remaining: limit - hits.length, retryAfterMs: 0, limit };
  }

  async acquire(bucket: string, max: number): Promise<(() => void) | null> {
    const current = this.slots.get(bucket) ?? 0;
    if (current >= max) return null;
    this.slots.set(bucket, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.slots.get(bucket) ?? 1) - 1;
      if (n <= 0) this.slots.delete(bucket);
      else this.slots.set(bucket, n);
    };
  }

  inUse(bucket: string): number {
    return this.slots.get(bucket) ?? 0;
  }

  private gcCounter = 0;
  private gc(): void {
    if (++this.gcCounter % 500 !== 0) return;
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const [bucket, hits] of this.windows) {
      const live = hits.filter((t) => t > cutoff);
      if (live.length === 0) this.windows.delete(bucket);
      else this.windows.set(bucket, live);
    }
  }
}

/**
 * API keys from the `API_KEYS` environment variable: `name:secret,name2:secret2`.
 * A bare secret without a name is given the name `default`.
 */
export class EnvApiKeyResolver implements ApiKeyResolver {
  private readonly keys = new Map<string, Principal>();

  constructor(spec: string, demoKey?: string) {
    for (const entry of spec.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) this.keys.set(trimmed, { name: "default", kind: "key" });
      else {
        const name = trimmed.slice(0, idx).trim() || "default";
        const secret = trimmed.slice(idx + 1).trim();
        if (secret) this.keys.set(secret, { name, kind: "key" });
      }
    }
    if (demoKey) this.keys.set(demoKey, { name: "demo", kind: "demo" });
  }

  get size(): number {
    return this.keys.size;
  }

  async resolve(token: string): Promise<Principal | null> {
    return this.keys.get(token) ?? null;
  }
}

export const systemClock: Clock = { now: () => new Date() };

export const uuidIds: IdGenerator = { jobId: () => randomUUID() };

export function createLogger(level = "info", bindings: Record<string, unknown> = {}): Logger {
  return wrapPino(pino({ level, base: bindings }));
}

function wrapPino(instance: pino.Logger): Logger {
  return {
    debug: (obj, msg) => (typeof obj === "string" ? instance.debug(obj) : instance.debug(obj, msg)),
    info: (obj, msg) => (typeof obj === "string" ? instance.info(obj) : instance.info(obj, msg)),
    warn: (obj, msg) => (typeof obj === "string" ? instance.warn(obj) : instance.warn(obj, msg)),
    error: (obj, msg) => (typeof obj === "string" ? instance.error(obj) : instance.error(obj, msg)),
    child: (b) => wrapPino(instance.child(b)),
  };
}

export class FetchWebhookNotifier implements WebhookNotifier {
  constructor(private readonly logger: Logger) {}

  async notify(url: string, payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "latex-api-webhook/1" },
          body,
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });
        if (res.ok) return;
        this.logger.warn({ url, status: res.status, attempt }, "webhook responded with error");
      } catch (error) {
        this.logger.warn({ url, attempt, err: error }, "webhook delivery failed");
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}
