import type { Health } from "@jibaru/latex-api-sdk";
import { rt } from "../blocks/runtime";
import { colors, sanitize } from "../blocks/style";
import { leaf, t } from "../command";
import { CliError, EXIT } from "../exit";
import { out } from "../output";
import { formatBytes, formatDuration, renderFields } from "../ui";

export const limitsCommand = leaf({
  name: "limits",
  description: "Show the server's effective limits (upload size, timeouts, rate limits, engines)",
  contract: {
    data: t.object({ limits: t.ref("Limits") }),
    exitCodes: [EXIT.OK, EXIT.AUTH],
    auth: "none",
    effect: "read",
  },
  examples: ["latex-api limits --json | jq .data.limits.maxUploadBytes"],
  async run({ app }) {
    const { api } = await app.api();
    const limits = await api.limits();
    return {
      data: { limits },
      human: ({ limits: l }) =>
        out(
          renderFields([
            ["max upload", formatBytes(l.maxUploadBytes)],
            ["max unpacked", formatBytes(l.maxUnpackedBytes)],
            ["max files", String(l.maxFiles)],
            ["max file size", formatBytes(l.maxFileBytes)],
            ["sync timeout", formatDuration(l.syncTimeoutMs)],
            [
              "job timeout",
              `${formatDuration(l.jobTimeoutMs)} (max ${formatDuration(l.jobTimeoutMaxMs)})`,
            ],
            ["job memory/cpu", `${formatBytes(l.jobMemoryBytes)} / ${l.jobCpus}`],
            ["artifacts kept", `${l.artifactTtlHours} h`],
            [
              "rate limit",
              `${l.rateLimitPerKeyPerHour}/h, ${l.rateLimitConcurrentPerKey} concurrent`,
            ],
            ["engines", l.engines.join(", ")],
          ]),
        ),
    };
  },
});

export const healthCommand = leaf({
  name: "health",
  description: "Check that the server and its compiler are up",
  contract: {
    data: t.object({ health: t.ref("Health") }),
    exitCodes: [EXIT.OK, EXIT.AUTH],
    auth: "none",
    effect: "read",
    notes:
      "A degraded server is an error envelope (code server_degraded, exit 3) with the health report in error.details.",
  },
  examples: ["latex-api health"],
  async run({ app }) {
    const { api, settings } = await app.api();
    const health = await api.health();
    if (health.status !== "ok") {
      throw new CliError("server_degraded", `${settings.baseUrl} reports ${health.status}`, {
        exitCode: EXIT.AUTH,
        hint: "Retry later; failing checks are in error.details.health.checks",
        details: { health },
      });
    }
    return {
      data: { health },
      human: ({ health: h }: { health: Health }) => {
        const c = colors(rt().stdout);
        out(`${c.ok("✔")} ${settings.baseUrl}  ${c.ok(h.status)}  ${c.muted(h.version)}`);
        for (const [name, check] of Object.entries(h.checks)) {
          out(
            `  ${check.ok ? c.ok("ok ") : c.danger("bad")} ${name}${check.detail ? c.muted(`  ${sanitize(check.detail)}`) : ""}`,
          );
        }
      },
    };
  },
});

export const statsCommand = leaf({
  name: "stats",
  description: "Show usage statistics for your account",
  contract: {
    data: t.object({ stats: t.ref("Stats") }),
    exitCodes: [EXIT.OK, EXIT.AUTH],
    auth: "required",
    effect: "read",
  },
  examples: ["latex-api stats"],
  async run({ app }) {
    const { api } = await app.api({ requireAuth: true });
    const stats = await api.stats();
    return {
      data: { stats },
      human: ({ stats: s }) =>
        out(
          renderFields([
            [
              "last 24h",
              `${s.last24h.total} total, ${s.last24h.succeeded} ok, ${s.last24h.failed} failed, ${s.last24h.cached} cached`,
            ],
            [
              "duration p50/p95",
              `${formatDuration(s.durationMs.p50)} / ${formatDuration(s.durationMs.p95)}`,
            ],
            ["queue depth", String(s.queueDepth)],
            ["storage used", formatBytes(s.storage.usedBytes)],
            ["compiler", s.compilerVersion],
            ...Object.entries(s.byStatus).map(
              ([status, n]) => [`jobs ${status}`, String(n)] as [string, string],
            ),
          ]),
        ),
    };
  },
});
