// `latex-api doctor`: structured per-check health of the local setup and the server.
// Pattern adopted from cligentic block `doctor` (registry/agent/doctor.ts): run named checks
// in order, isolate failures, one result per check. Hybrid: a check has four states
// (pass/fail/warn/skip) and a hint, and the result goes through this CLI's envelope.

import { existsSync } from "node:fs";
import type { Health, LatexApi } from "@jibaru/latex-api-sdk";
import { LatexApiError } from "@jibaru/latex-api-sdk";
import { rt } from "../blocks/runtime";
import { colors, padVisible, sanitize } from "../blocks/style";
import { leaf, t } from "../command";
import { ENV, type ResolvedSettings } from "../config";
import type { AppContext } from "../context";
import { CliError, EXIT, type ExitCode } from "../exit";
import { out } from "../output";
import { CLI_VERSION, PACKAGE_NAME } from "../version";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

/** Numeric comparison of x.y.z versions; prerelease tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]?.split(".").map(Number) ?? [];
  const pb = b.split("-")[0]?.split(".").map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const CHECK_EXIT: Record<string, ExitCode> = {
  config: EXIT.USAGE,
  profile: EXIT.NOT_FOUND,
};

async function runChecks(app: AppContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);

  // 1. config
  let configOk = true;
  try {
    const config = await app.config();
    const n = Object.keys(config.profiles).length;
    add({
      name: "config",
      status: "pass",
      detail: existsSync(app.paths.config)
        ? `${app.paths.config} (${n} profile${n === 1 ? "" : "s"})`
        : `${app.paths.config} (not created yet; defaults apply)`,
    });
  } catch (error) {
    configOk = false;
    const e = error as CliError;
    add({ name: "config", status: "fail", detail: e.message, hint: e.hint });
  }

  // 2. profile
  let settings: ResolvedSettings | undefined;
  if (configOk) {
    try {
      settings = await app.settings();
      app.assertProfileExists(settings);
      add({
        name: "profile",
        status: "pass",
        detail: `${settings.profileName} (from ${settings.profileSource}) → ${settings.baseUrl}${settings.baseUrlSource === "env" ? ` (${ENV.URL})` : ""}`,
      });
    } catch (error) {
      const e = error as CliError;
      add({ name: "profile", status: "fail", detail: e.message, hint: e.hint });
      settings = undefined;
    }
  } else {
    add({ name: "profile", status: "skip", detail: "config is not readable" });
  }

  // 3. credential present
  const keychain = await app.store.keychainAvailable();
  const storeNote = keychain
    ? "keychain available"
    : `keychain unavailable (${app.store.keychainUnavailableReason ?? "unknown"}); using ${app.paths.credentials}`;
  if (!settings) {
    add({ name: "credential", status: "skip", detail: "no profile resolved" });
  } else if (!settings.token) {
    add({
      name: "credential",
      status: "fail",
      detail: `no token for profile "${settings.profileName}" (${storeNote})`,
      hint: "Run `latex-api auth login`, or set LATEX_API_TOKEN",
    });
  } else {
    const where =
      settings.tokenSource === "env"
        ? ENV.TOKEN
        : settings.tokenSource === "env-deprecated"
          ? `${ENV.KEY} (deprecated)`
          : app.store.describe(settings.tokenSource as "keychain" | "file", settings.profileName);
    add({ name: "credential", status: "pass", detail: `from ${where}` });
  }

  // 4. credential valid, 5. API reachable, 6. compiler
  let api: LatexApi | undefined;
  if (settings) api = (await app.api({ allowMissingProfile: true })).api;
  if (!api || !settings?.token) {
    add({ name: "credential_valid", status: "skip", detail: "no credential to validate" });
  } else {
    try {
      const me = await api.me();
      add({
        name: "credential_valid",
        status: "pass",
        detail: `${me.user?.email ?? me.user?.id ?? me.principal.name} (${me.principal.kind})`,
      });
    } catch (error) {
      const e = error as LatexApiError;
      add({
        name: "credential_valid",
        status: "fail",
        detail:
          e instanceof LatexApiError && e.status === 401
            ? "the server rejected the token"
            : sanitize(String(e.message)),
        hint: "Run `latex-api auth login` again",
      });
    }
  }

  let health: Health | undefined;
  if (!api) {
    add({ name: "api_reachable", status: "skip", detail: "no profile resolved" });
  } else {
    const started = rt().now();
    try {
      health = await api.health();
      add({
        name: "api_reachable",
        status: "pass",
        detail: `${settings?.baseUrl} answered in ${rt().now() - started} ms (server ${health.version})`,
      });
    } catch (error) {
      add({
        name: "api_reachable",
        status: "fail",
        detail: sanitize((error as Error).message),
        hint: "Check your connection and `latex-api profile get`",
      });
    }
  }
  if (!health) {
    add({ name: "compiler", status: "skip", detail: "server not reachable" });
  } else {
    const compiler =
      health.checks.compiler ??
      Object.entries(health.checks).find(([k]) => /compil|docker/.test(k))?.[1];
    if (!compiler) {
      add({
        name: "compiler",
        status: health.status === "ok" ? "pass" : "fail",
        detail: `server status ${health.status}`,
      });
    } else {
      add({
        name: "compiler",
        status: compiler.ok ? "pass" : "fail",
        detail: sanitize(compiler.detail ?? (compiler.ok ? "ok" : "unhealthy")),
        ...(compiler.ok ? {} : { hint: "The server cannot compile right now; retry later" }),
      });
    }
  }

  // 7. CLI version (non-fatal)
  try {
    const fetchImpl = rt().fetch ?? fetch;
    const response = await fetchImpl(
      `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}/latest`,
      { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } },
    );
    if (response.status === 404) {
      add({
        name: "cli_version",
        status: "skip",
        detail: `${CLI_VERSION} (not published on npm yet)`,
      });
    } else if (!response.ok) {
      add({
        name: "cli_version",
        status: "skip",
        detail: `${CLI_VERSION} (npm answered ${response.status})`,
      });
    } else {
      const latest = String(((await response.json()) as { version?: string }).version ?? "");
      const cmp = latest ? compareVersions(CLI_VERSION, latest) : 0;
      add(
        cmp < 0
          ? {
              name: "cli_version",
              status: "warn",
              detail: `${CLI_VERSION}, latest is ${latest}`,
              hint: `npm install -g ${PACKAGE_NAME}@latest`,
            }
          : {
              name: "cli_version",
              status: "pass",
              detail: `${CLI_VERSION} (latest ${latest || "unknown"})`,
            },
      );
    }
  } catch {
    add({
      name: "cli_version",
      status: "skip",
      detail: `${CLI_VERSION} (npm not reachable; offline?)`,
    });
  }
  return checks;
}

function renderChecks(checks: DoctorCheck[]): void {
  const c = colors(rt().stdout);
  const glyph: Record<CheckStatus, string> = {
    pass: c.ok("✔ pass"),
    fail: c.danger("✖ fail"),
    warn: c.warn("▲ warn"),
    skip: c.muted("- skip"),
  };
  const width = Math.max(...checks.map((ch) => ch.name.length));
  for (const check of checks) {
    out(
      `${padVisible(glyph[check.status], 6)}  ${padVisible(c.bold(check.name), width)}  ${check.detail}`,
    );
    if (check.hint && check.status !== "pass")
      out(`${" ".repeat(width + 10)}${c.muted(`hint: ${check.hint}`)}`);
  }
}

export const doctorCommand = leaf({
  name: "doctor",
  description:
    "Check config, profile, credential (and that it works), the server and the CLI version",
  contract: {
    data: t.object({
      healthy: t.boolean(),
      checks: t.array(
        t.object({
          name: t.enum([
            "config",
            "profile",
            "credential",
            "credential_valid",
            "api_reachable",
            "compiler",
            "cli_version",
          ]),
          status: t.enum(["pass", "fail", "warn", "skip"]),
          detail: t.string(),
          "hint?": t.string(),
        }),
      ),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "optional",
    effect: "read",
    notes:
      "When any check fails the envelope is ok:false, error.code=doctor_failed and the same checks are in error.details.checks; exit 2 (config), 4 (profile) or 3 (credential/server). warn and skip never fail.",
  },
  examples: [
    "latex-api doctor",
    "latex-api doctor --json | jq '.data.checks // .error.details.checks'",
  ],
  async run({ app, machine }) {
    const checks = await runChecks(app);
    const failed = checks.filter((c) => c.status === "fail");
    if (failed.length > 0) {
      if (!machine) renderChecks(checks);
      const first = failed[0] as DoctorCheck;
      throw new CliError(
        "doctor_failed",
        `${failed.length} of ${checks.length} checks failed: ${failed.map((c) => c.name).join(", ")}`,
        {
          exitCode: CHECK_EXIT[first.name] ?? EXIT.AUTH,
          hint: first.hint,
          details: { healthy: false, checks },
        },
      );
    }
    return {
      data: { healthy: true, checks },
      human: (d) => renderChecks(d.checks),
    };
  },
});
