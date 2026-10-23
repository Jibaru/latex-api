import { fetchLimits, formatBytes, formatDuration } from "@/lib/api";

export async function LimitsStrip() {
  const { data: limits } = await fetchLimits();
  const figures = [
    { value: formatBytes(limits.maxUploadBytes), label: "per upload" },
    { value: formatDuration(limits.syncTimeoutMs), label: "sync timeout" },
    { value: formatDuration(limits.jobTimeoutMaxMs), label: "async, at most" },
    { value: formatBytes(limits.jobMemoryBytes), label: "RAM per compile" },
    { value: `${limits.artifactTtlHours} h`, label: "artifacts kept" },
  ];

  return (
    <section aria-label="Limits" className="border-t border-rule">
      <div className="wrap py-14 lg:py-16">
        <dl className="grid grid-cols-2 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {figures.map((f) => (
            <div key={f.label} className="flex flex-col-reverse">
              <dt className="mt-1.5 text-[0.85rem] text-ink-2">{f.label}</dt>
              <dd className="font-serif text-4xl tracking-tight tabular-nums lg:text-5xl">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-[0.85rem] text-ink-2">
          Limits are configured per instance and published at{" "}
          <code className="font-mono">/v1/limits</code>. Keys get 60 compiles an hour, 5 at once.
        </p>
      </div>
    </section>
  );
}
