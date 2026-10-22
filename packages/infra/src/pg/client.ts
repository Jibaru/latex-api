import pg from "pg";

export type PgPool = pg.Pool;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "0001_jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id               TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        mode             TEXT NOT NULL,
        engine           TEXT NOT NULL,
        entrypoint       TEXT NOT NULL,
        project_hash     TEXT NOT NULL,
        file_count       INTEGER NOT NULL,
        total_bytes      BIGINT NOT NULL,
        options          JSONB NOT NULL,
        principal_name   TEXT NOT NULL,
        principal_kind   TEXT NOT NULL,
        template_id      TEXT,
        compiler_version TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL,
        started_at       TIMESTAMPTZ,
        finished_at      TIMESTAMPTZ,
        expires_at       TIMESTAMPTZ NOT NULL,
        result           JSONB,
        error            JSONB
      );
      CREATE INDEX IF NOT EXISTS jobs_project_hash_idx ON jobs (project_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_expires_at_idx ON jobs (expires_at);
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
      CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);
    `,
  },
];

/** Tiny forward-only migrator; keeps the API free of a migration toolchain at runtime. */
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727272)");
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727272)").catch(() => undefined);
    client.release();
  }
}
