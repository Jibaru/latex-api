import type { JobSummary } from "@/lib/account";
import { relativeTime } from "@/lib/time";

const tone: Record<string, string> = {
  succeeded: "text-ok",
  failed: "text-accent",
  timed_out: "text-warn",
  cancelled: "text-ink-3",
  running: "text-ink",
  queued: "text-ink-2",
};

export function JobsTable({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) {
    return (
      <p className="mt-6 text-[0.95rem] text-ink-2">
        No jobs yet. Compiles from the API, the CLI or the SDK show up here.
      </p>
    );
  }
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-left text-[0.9rem]">
        <thead>
          <tr className="text-ink-3">
            <th scope="col" className="py-3 pr-4 font-normal">
              Status
            </th>
            <th scope="col" className="py-3 pr-4 font-normal">
              Entrypoint
            </th>
            <th scope="col" className="py-3 pr-4 font-normal">
              Engine
            </th>
            <th scope="col" className="py-3 pr-4 text-right font-normal">
              Pages
            </th>
            <th scope="col" className="py-3 pr-4 text-right font-normal">
              Time
            </th>
            <th scope="col" className="py-3 text-right font-normal">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-t border-rule align-top">
              <td className={`py-3 pr-4 ${tone[job.status] ?? "text-ink-2"}`}>
                {job.status.replace("_", " ")}
                {job.result?.cached ? <span className="ml-2 text-ink-3">cached</span> : null}
              </td>
              <td className="py-3 pr-4">
                <span className="font-mono text-[0.85rem]">{job.entrypoint}</span>
                {job.templateId ? (
                  <span className="ml-2 text-ink-3">from {job.templateId}</span>
                ) : null}
                {job.error && job.status !== "succeeded" ? (
                  <p
                    className="mt-1 max-w-[36rem] truncate text-[0.82rem] text-ink-2"
                    title={job.error.message}
                  >
                    {job.error.message}
                  </p>
                ) : null}
              </td>
              <td className="py-3 pr-4 text-ink-2">{job.engine}</td>
              <td className="py-3 pr-4 text-right tabular-nums">{job.result?.pages ?? "—"}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-ink-2">
                {job.result && !job.result.cached
                  ? `${(job.result.durationMs / 1000).toFixed(1)} s`
                  : "—"}
              </td>
              <td className="py-3 text-right text-ink-2">
                <time dateTime={job.createdAt}>{relativeTime(job.createdAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
