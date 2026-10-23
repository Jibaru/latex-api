import type {
  ApiKeyResolver,
  ApiToken,
  ApiTokenRepository,
  ArtifactStore,
  Clock,
  CompileJob,
  CompileRequest,
  Compiler,
  CoreDeps,
  DeviceAuthorization,
  DeviceAuthRepository,
  IdGenerator,
  JobEvent,
  JobEvents,
  JobQueue,
  JobRepository,
  JobStats,
  JobStatus,
  Logger,
  Project,
  RateLimiter,
  RawCompileOutput,
  SessionVerifier,
  StoredArtifact,
  Template,
  TemplateRepository,
  WebhookNotifier,
  Workspace,
  Workspaces,
} from "../src/index";
import { DEFAULT_LIMITS, isTerminal } from "../src/index";

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
    pdf: new TextEncoder().encode("%PDF-1.7\n/Type /Page\n%%EOF"),
    durationMs: 42,
  });
  async version() {
    return "fake-1";
  }
  async ping() {
    return { ok: true };
  }
  async compile(req: CompileRequest, signal: AbortSignal) {
    this.calls.push(req);
    return this.behaviour(req, signal);
  }
}

export class MemoryWorkspaces implements Workspaces {
  store = new Map<string, Workspace & { project: Project }>();
  async create(jobId: string, project: Project) {
    const ws = { jobId, entrypoint: project.entrypoint, engine: project.engine, project };
    this.store.set(jobId, ws);
    return ws;
  }
  async open(jobId: string) {
    return this.store.get(jobId) ?? null;
  }
  async remove(jobId: string) {
    this.store.delete(jobId);
  }
}

export class MemoryArtifacts implements ArtifactStore {
  data = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredArtifact> {
    this.data.set(key, { bytes, contentType });
    return { key, contentType, size: bytes.byteLength };
  }
  async get(key: string) {
    return this.data.get(key)?.bytes ?? null;
  }
  async stat(key: string) {
    const d = this.data.get(key);
    return d ? { key, contentType: d.contentType, size: d.bytes.byteLength } : null;
  }
  async stream(key: string) {
    const d = this.data.get(key);
    if (!d) return null;
    return new Blob([Buffer.from(d.bytes)]).stream();
  }
  async deletePrefix(prefix: string) {
    for (const k of Array.from(this.data.keys())) if (k.startsWith(prefix)) this.data.delete(k);
  }
  async usage() {
    let used = 0;
    for (const d of this.data.values()) used += d.bytes.byteLength;
    return { usedBytes: used, freeBytes: 10 ** 12 };
  }
}

export class MemoryJobs implements JobRepository {
  rows = new Map<string, CompileJob>();
  async insert(job: CompileJob) {
    this.rows.set(job.id, structuredClone(job));
  }
  async update(job: CompileJob) {
    this.rows.set(job.id, structuredClone(job));
  }
  async get(id: string) {
    const j = this.rows.get(id);
    return j ? structuredClone(j) : null;
  }
  async findCacheable(hash: string, now: Date) {
    const hits = Array.from(this.rows.values())
      .filter(
        (j) => j.projectHash === hash && isTerminal(j.status) && j.expiresAt > now && j.result,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return hits[0] ? structuredClone(hits[0]) : null;
  }
  async listExpired(now: Date, limit: number) {
    return Array.from(this.rows.values())
      .filter((j) => j.expiresAt <= now)
      .slice(0, limit);
  }
  async delete(ids: string[]) {
    for (const id of ids) this.rows.delete(id);
  }
  async countByHash(hash: string) {
    return Array.from(this.rows.values()).filter((j) => j.projectHash === hash).length;
  }
  async stats(): Promise<JobStats> {
    const byStatus = Object.fromEntries(
      ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"].map((s) => [s, 0]),
    ) as Record<JobStatus, number>;
    for (const j of this.rows.values()) byStatus[j.status]++;
    return {
      byStatus,
      last24h: { total: this.rows.size, succeeded: 0, failed: 0, cached: 0 },
      durationMs: { p50: 0, p95: 0 },
    };
  }
  async listByOwner(owner: string, limit: number) {
    return Array.from(this.rows.values())
      .filter((j) => j.principal.name === owner)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
  async listStale(before: Date) {
    return Array.from(this.rows.values()).filter(
      (j) => j.status === "running" && j.startedAt !== undefined && j.startedAt < before,
    );
  }
}

export class MemoryQueue implements JobQueue {
  queued: string[] = [];
  async enqueue(jobId: string) {
    this.queued.push(jobId);
  }
  async cancel(jobId: string) {
    this.queued = this.queued.filter((id) => id !== jobId);
  }
  async depth() {
    return this.queued.length;
  }
}

export class MemoryEvents implements JobEvents {
  published: JobEvent[] = [];
  private listeners = new Map<string, Set<(e: JobEvent) => void>>();
  private cancels = new Map<string, Set<() => void>>();
  publish(event: JobEvent) {
    this.published.push(event);
    for (const l of this.listeners.get(event.jobId) ?? []) l(event);
  }
  subscribe(jobId: string, listener: (e: JobEvent) => void) {
    const set = this.listeners.get(jobId) ?? new Set();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => set.delete(listener);
  }
  requestCancel(jobId: string) {
    const set = this.cancels.get(jobId);
    if (!set || set.size === 0) return false;
    for (const h of set) h();
    return true;
  }
  onCancel(jobId: string, handler: () => void) {
    const set = this.cancels.get(jobId) ?? new Set();
    set.add(handler);
    this.cancels.set(jobId, set);
    return () => set.delete(handler);
  }
}

export class MemoryRateLimiter implements RateLimiter {
  counts = new Map<string, number>();
  slots = new Map<string, number>();
  async consume(bucket: string, limit: number) {
    const n = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, n);
    return {
      allowed: n <= limit,
      remaining: Math.max(0, limit - n),
      retryAfterMs: n <= limit ? 0 : 1000,
      limit,
    };
  }
  async acquire(bucket: string, max: number) {
    const n = this.slots.get(bucket) ?? 0;
    if (n >= max) return null;
    this.slots.set(bucket, n + 1);
    return () => this.slots.set(bucket, (this.slots.get(bucket) ?? 1) - 1);
  }
}

export class MemoryTemplates implements TemplateRepository {
  constructor(public templates: Array<Template & { contents: Record<string, string> }> = []) {}
  async list() {
    return this.templates.map(({ contents: _c, ...t }) => t);
  }
  async get(id: string) {
    const t = this.templates.find((x) => x.id === id);
    if (!t) return null;
    const { contents: _c, ...rest } = t;
    return rest;
  }
  async files(id: string) {
    const t = this.templates.find((x) => x.id === id);
    if (!t) return null;
    return Object.entries(t.contents).map(([path, s]) => ({
      path,
      content: new TextEncoder().encode(s),
    }));
  }
  async readFile(id: string, path: string) {
    const t = this.templates.find((x) => x.id === id);
    const s = t?.contents[path];
    return s === undefined ? null : new TextEncoder().encode(s);
  }
}

export class MemoryTokens implements ApiTokenRepository {
  rows = new Map<string, ApiToken>();
  async insert(t: ApiToken) {
    this.rows.set(t.id, { ...t });
  }
  async findByHash(hash: string) {
    return Array.from(this.rows.values()).find((t) => t.hash === hash) ?? null;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async listByUser(userId: string) {
    return Array.from(this.rows.values()).filter((t) => t.userId === userId);
  }
  async countActive(userId: string, now: Date) {
    return (await this.listByUser(userId)).filter(
      (t) => !t.revokedAt && (!t.expiresAt || t.expiresAt > now),
    ).length;
  }
  async revoke(id: string, at: Date) {
    const t = this.rows.get(id);
    if (t) t.revokedAt = at;
  }
  async touch(id: string, at: Date) {
    const t = this.rows.get(id);
    if (t) t.lastUsedAt = at;
  }
}

export class MemoryDevices implements DeviceAuthRepository {
  rows = new Map<string, DeviceAuthorization>();
  async insert(r: DeviceAuthorization) {
    this.rows.set(r.id, structuredClone(r));
  }
  async update(r: DeviceAuthorization) {
    this.rows.set(r.id, structuredClone(r));
  }
  async findByDeviceCodeHash(hash: string) {
    const r = Array.from(this.rows.values()).find((x) => x.deviceCodeHash === hash);
    return r ? structuredClone(r) : null;
  }
  async findByUserCode(code: string) {
    const r = Array.from(this.rows.values()).find((x) => x.userCode === code);
    return r ? structuredClone(r) : null;
  }
  async deleteExpired() {
    return 0;
  }
}

export class FakeSessions implements SessionVerifier {
  enabled = true;
  async verify(token: string) {
    return token === "aaa.bbb.ccc" ? { id: "user_1", email: "ada@example.com" } : null;
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export function makeDeps(overrides: Partial<CoreDeps> = {}): CoreDeps & {
  compiler: FakeCompiler;
  jobs: MemoryJobs;
  artifacts: MemoryArtifacts;
  events: MemoryEvents;
  queue: MemoryQueue;
  workspaces: MemoryWorkspaces;
  rateLimiter: MemoryRateLimiter;
  tokens: MemoryTokens;
  devices: MemoryDevices;
} {
  let counter = 0;
  let t = 1_700_000_000_000;
  const clock: Clock = { now: () => new Date((t += 1000)) };
  const ids: IdGenerator = { jobId: () => `job_${++counter}` };
  const apiKeys: ApiKeyResolver = {
    resolve: async (token) => (token === "secret" ? { name: "test", kind: "key" } : null),
  };
  const webhooks: WebhookNotifier = { notify: async () => {} };
  const base = {
    limits: { ...DEFAULT_LIMITS },
    compiler: new FakeCompiler(),
    workspaces: new MemoryWorkspaces(),
    artifacts: new MemoryArtifacts(),
    jobs: new MemoryJobs(),
    queue: new MemoryQueue(),
    events: new MemoryEvents(),
    rateLimiter: new MemoryRateLimiter(),
    apiKeys,
    templates: new MemoryTemplates(),
    clock,
    ids,
    logger: silentLogger,
    webhooks,
    tokens: new MemoryTokens(),
    devices: new MemoryDevices(),
    sessions: new FakeSessions(),
  };
  return { ...base, ...overrides } as never;
}
