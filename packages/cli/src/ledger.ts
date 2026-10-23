// Local job ledger: append-only JSONL at <home>/jobs.jsonl. Every submission is written
// right after the server accepts it and again when it finishes, so a killed `--wait` leaves
// a `submitted` line that `jobs list --local` shows and `jobs wait <id>` can resume, even
// offline. Pattern: cligentic compounding-surface "async: --wait and a job ledger".

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface LedgerRecord {
  ts: string;
  event: "submitted" | "finished";
  id: string;
  mode: "sync" | "async";
  profile: string;
  baseUrl: string;
  status: string;
  engine?: string;
  entrypoint?: string;
  source?: string;
  output?: string;
}

export interface LedgerJob {
  id: string;
  mode: "sync" | "async";
  status: string;
  profile: string;
  baseUrl: string;
  engine?: string;
  entrypoint?: string;
  source?: string;
  output?: string;
  submittedAt: string;
  updatedAt: string;
}

export function appendLedger(file: string, record: Omit<LedgerRecord, "ts">): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const isNew = !existsSync(file);
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
      mode: 0o600,
    });
    if (isNew && process.platform !== "win32") chmodSync(file, 0o600);
  } catch {
    // The ledger is a convenience; never fail a compile because it could not be written.
  }
}

/** Folds the ledger by job id (last record wins), newest first. Skips corrupt lines. */
export function readLedger(file: string, limit = 20): LedgerJob[] {
  if (!existsSync(file)) return [];
  const jobs = new Map<string, LedgerJob>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: LedgerRecord;
    try {
      record = JSON.parse(line) as LedgerRecord;
    } catch {
      continue;
    }
    if (!record.id || !record.ts) continue;
    const previous = jobs.get(record.id);
    jobs.delete(record.id);
    jobs.set(record.id, {
      id: record.id,
      mode: record.mode ?? previous?.mode ?? "async",
      status: record.status ?? previous?.status ?? "unknown",
      profile: record.profile ?? previous?.profile ?? "default",
      baseUrl: record.baseUrl ?? previous?.baseUrl ?? "",
      engine: record.engine ?? previous?.engine,
      entrypoint: record.entrypoint ?? previous?.entrypoint,
      source: record.source ?? previous?.source,
      output: record.output ?? previous?.output,
      submittedAt: previous?.submittedAt ?? record.ts,
      updatedAt: record.ts,
    });
  }
  return [...jobs.values()]
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .slice(0, Math.max(1, limit));
}
