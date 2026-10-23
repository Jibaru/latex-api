import {
  type CompileJob,
  JOB_STATUSES,
  type JobRepository,
  type JobStats,
  type JobStatus,
} from "@latex-api/core";
import type pg from "pg";

interface Row {
  id: string;
  status: string;
  mode: string;
  engine: string;
  entrypoint: string;
  project_hash: string;
  file_count: number;
  total_bytes: string | number;
  options: CompileJob["options"];
  principal_name: string;
  principal_kind: string;
  template_id: string | null;
  compiler_version: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date;
  result: CompileJob["result"] | null;
  error: CompileJob["error"] | null;
}

function toJob(row: Row): CompileJob {
  return {
    id: row.id,
    status: row.status as JobStatus,
    mode: row.mode as CompileJob["mode"],
    engine: row.engine as CompileJob["engine"],
    entrypoint: row.entrypoint,
    projectHash: row.project_hash,
    fileCount: row.file_count,
    totalBytes: Number(row.total_bytes),
    options: row.options,
    principal: {
      name: row.principal_name,
      kind: row.principal_kind as CompileJob["principal"]["kind"],
    },
    templateId: row.template_id ?? undefined,
    compilerVersion: row.compiler_version,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    expiresAt: row.expires_at,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
  };
}

const COLUMNS =
  "id, status, mode, engine, entrypoint, project_hash, file_count, total_bytes, options, principal_name, principal_kind, template_id, compiler_version, created_at, started_at, finished_at, expires_at, result, error";

export class PgJobRepository implements JobRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(job: CompileJob): Promise<void> {
    await this.pool.query(
      `INSERT INTO jobs (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        job.id,
        job.status,
        job.mode,
        job.engine,
        job.entrypoint,
        job.projectHash,
        job.fileCount,
        job.totalBytes,
        JSON.stringify(job.options),
        job.principal.name,
        job.principal.kind,
        job.templateId ?? null,
        job.compilerVersion,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null,
        job.expiresAt,
        job.result ? JSON.stringify(job.result) : null,
        job.error ? JSON.stringify(job.error) : null,
      ],
    );
  }

  async update(job: CompileJob): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status=$2, started_at=$3, finished_at=$4, expires_at=$5, result=$6, error=$7, options=$8 WHERE id=$1`,
      [
        job.id,
        job.status,
        job.startedAt ?? null,
        job.finishedAt ?? null,
        job.expiresAt,
        job.result ? JSON.stringify(job.result) : null,
        job.error ? JSON.stringify(job.error) : null,
        JSON.stringify(job.options),
      ],
    );
  }

  async get(id: string): Promise<CompileJob | null> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM jobs WHERE id=$1`, [id]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async findCacheable(projectHash: string, now: Date): Promise<CompileJob | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM jobs
       WHERE project_hash=$1 AND expires_at > $2 AND result IS NOT NULL
         AND (status='succeeded' OR (status='failed' AND error->>'reason'='compile_failed'))
       ORDER BY created_at DESC LIMIT 1`,
      [projectHash, now],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listExpired(now: Date, limit: number): Promise<CompileJob[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM jobs WHERE expires_at <= $1 ORDER BY expires_at ASC LIMIT $2`,
      [now, limit],
    );
    return rows.map(toJob);
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query("DELETE FROM jobs WHERE id = ANY($1::text[])", [ids]);
  }

  async countByHash(projectHash: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM jobs WHERE project_hash=$1",
      [projectHash],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listByOwner(owner: string, limit: number): Promise<CompileJob[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM jobs WHERE principal_name=$1 ORDER BY created_at DESC LIMIT $2`,
      [owner, limit],
    );
    return rows.map(toJob);
  }

  async listStale(startedBefore: Date): Promise<CompileJob[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM jobs WHERE status='running' AND started_at < $1`,
      [startedBefore],
    );
    return rows.map(toJob);
  }

  async stats(now: Date): Promise<JobStats> {
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const [byStatusRes, lastRes, durRes] = await Promise.all([
      this.pool.query<{ status: string; n: string }>(
        "SELECT status, count(*)::text AS n FROM jobs GROUP BY status",
      ),
      this.pool.query<{ total: string; succeeded: string; failed: string; cached: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status='succeeded')::text AS succeeded,
                count(*) FILTER (WHERE status IN ('failed','timed_out'))::text AS failed,
                count(*) FILTER (WHERE (result->>'cached')::boolean)::text AS cached
         FROM jobs WHERE created_at >= $1`,
        [since],
      ),
      this.pool.query<{ p50: number | null; p95: number | null }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (result->>'durationMs')::numeric) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (result->>'durationMs')::numeric) AS p95
         FROM jobs WHERE created_at >= $1 AND result IS NOT NULL AND NOT (result->>'cached')::boolean`,
        [since],
      ),
    ]);
    const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
      JobStatus,
      number
    >;
    for (const row of byStatusRes.rows) byStatus[row.status as JobStatus] = Number(row.n);
    const last = lastRes.rows[0];
    const dur = durRes.rows[0];
    return {
      byStatus,
      last24h: {
        total: Number(last?.total ?? 0),
        succeeded: Number(last?.succeeded ?? 0),
        failed: Number(last?.failed ?? 0),
        cached: Number(last?.cached ?? 0),
      },
      durationMs: {
        p50: Math.round(Number(dur?.p50 ?? 0)),
        p95: Math.round(Number(dur?.p95 ?? 0)),
      },
    };
  }
}
