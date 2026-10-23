import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";
import { createSession } from "../client";
import { EXIT } from "../exit";
import { formatBytes, formatDuration, printJson, renderTable } from "../ui";

export const limitsCommand = defineCommand({
  meta: { name: "limits", description: "Show the server's effective limits" },
  args: { json: { type: "boolean", description: "Print as JSON" } },
  async run({ args }) {
    const session = await createSession();
    const limits = await session.api.limits();
    if (args.json) {
      printJson(limits);
      return;
    }
    console.log(pc.dim(session.settings.baseUrl));
    console.log(
      renderTable(
        ["limit", "value"],
        [
          ["max upload", formatBytes(limits.maxUploadBytes)],
          ["max unpacked", formatBytes(limits.maxUnpackedBytes)],
          ["max files", String(limits.maxFiles)],
          ["max file size", formatBytes(limits.maxFileBytes)],
          ["sync timeout", formatDuration(limits.syncTimeoutMs)],
          [
            "job timeout (default / max)",
            `${formatDuration(limits.jobTimeoutMs)} / ${formatDuration(limits.jobTimeoutMaxMs)}`,
          ],
          ["job memory / cpus", `${formatBytes(limits.jobMemoryBytes)} / ${limits.jobCpus}`],
          ["artifact ttl", `${limits.artifactTtlHours} h`],
          [
            "rate limit",
            `${limits.rateLimitPerKeyPerHour}/h, ${limits.rateLimitConcurrentPerKey} concurrent`,
          ],
          ["engines", limits.engines.join(", ")],
        ],
      ),
    );
  },
});

export const healthCommand = defineCommand({
  meta: { name: "health", description: "Check that the server is up" },
  args: { json: { type: "boolean", description: "Print as JSON" } },
  async run({ args }) {
    const session = await createSession();
    const health = await session.api.health();
    if (args.json) printJson(health);
    else {
      const ok = health.status === "ok";
      const line = `${session.settings.baseUrl}  ${ok ? pc.green(health.status) : pc.red(health.status)}  ${pc.dim(`v${health.version}`)}`;
      if (ok) consola.success(line);
      else consola.warn(line);
      for (const [name, check] of Object.entries(health.checks)) {
        console.log(
          `  ${check.ok ? pc.green("ok ") : pc.red("bad")} ${name}${check.detail ? pc.dim(`  ${check.detail}`) : ""}`,
        );
      }
    }
    if (health.status !== "ok") process.exitCode = EXIT.NETWORK;
  },
});

export const statsCommand = defineCommand({
  meta: { name: "stats", description: "Show usage statistics (requires a key)" },
  args: { json: { type: "boolean", description: "Print as JSON" } },
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    const stats = await session.api.stats();
    if (args.json) {
      printJson(stats);
      return;
    }
    console.log(
      renderTable(
        ["metric", "value"],
        [
          [
            "last 24h",
            `${stats.last24h.total} total, ${stats.last24h.succeeded} ok, ${stats.last24h.failed} failed, ${stats.last24h.cached} cached`,
          ],
          [
            "duration p50 / p95",
            `${formatDuration(stats.durationMs.p50)} / ${formatDuration(stats.durationMs.p95)}`,
          ],
          ["queue depth", String(stats.queueDepth)],
          ["storage used", formatBytes(stats.storage.usedBytes)],
          ["compiler", stats.compilerVersion],
          ...Object.entries(stats.byStatus).map(([status, n]) => [`jobs ${status}`, String(n)]),
        ],
      ),
    );
  },
});
