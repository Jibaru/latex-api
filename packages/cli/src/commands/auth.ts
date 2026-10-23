import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { type ApiToken, LatexApiError } from "@jibaru/latex-api-sdk";
import { atomicWriteJson } from "../blocks/atomic-write";
import { printBanner } from "../blocks/banner";
import { type OpenUrlResult, openUrl } from "../blocks/open-url";
import { promptSecret } from "../blocks/prompt";
import { rt } from "../blocks/runtime";
import { colors } from "../blocks/style";
import { group, leaf, t } from "../command";
import { ENV, type ResolvedSettings } from "../config";
import type { AppContext } from "../context";
import type { StoreKind } from "../credentials";
import { type DeviceApproval, pollDeviceToken } from "../device";
import { CliError, EXIT } from "../exit";
import { log, out, progress, successEnvelope, warnOnce, writeEnvelope } from "../output";
import { renderFields } from "../ui";
import { CLI_VERSION } from "../version";

const DEFAULT_LOGIN_TIMEOUT_S = 600;

interface PendingLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresAt: number;
  profile: string;
  baseUrl: string;
  startedAt: string;
}

/** Shows enough of a token to recognise it, never enough to use it. */
export function tokenPrefixOf(token: string): string | undefined {
  return token.startsWith("lta_") ? token.slice(0, 12) : undefined;
}

function readPending(file: string): PendingLogin | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as PendingLogin;
    return typeof value.deviceCode === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The token for `--with-token`: piped stdin, or a hidden prompt on a terminal. */
async function readTokenInput(): Promise<string> {
  const { stdin } = rt();
  let value: string | null;
  if (stdin.isTTY === true) {
    value = await promptSecret("Paste your API token (input hidden): ").catch(() => null);
  } else {
    value = (await readAll(stdin)).split(/\r?\n/).find((line) => line.trim()) ?? "";
  }
  const token = value?.trim() ?? "";
  if (!token) {
    throw new CliError("token_missing", "No token on stdin", {
      exitCode: EXIT.USAGE,
      hint: 'Pipe it in: `printf %s "$TOKEN" | latex-api auth login --with-token`',
    });
  }
  if (/\s/.test(token)) {
    throw new CliError("token_invalid", "The token contains whitespace", { exitCode: EXIT.USAGE });
  }
  return token;
}

function parseTimeoutSeconds(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_LOGIN_TIMEOUT_S;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError("usage", "--timeout must be a positive number of seconds", {
      exitCode: EXIT.USAGE,
    });
  }
  return seconds;
}

export interface LoginResult {
  status: "approved";
  profile: string;
  baseUrl: string;
  user: { id: string; email?: string } | null;
  tokenId: string | undefined;
  tokenPrefix: string | undefined;
  tokenOrigin: ApiToken["origin"] | undefined;
  expiresAt: string | undefined;
  storedIn: StoreKind;
  storage: string;
}

/** Validates the token with /v1/me, stores the secret and the identifiers. */
async function completeLogin(
  app: AppContext,
  target: { profile: string; baseUrl: string },
  token: string,
  approval?: DeviceApproval,
): Promise<LoginResult> {
  const { api } = await app.api({ token, baseUrl: target.baseUrl, allowMissingProfile: true });
  let me: Awaited<ReturnType<typeof api.me>>;
  try {
    me = await api.me();
  } catch (error) {
    if (error instanceof LatexApiError && error.status === 401) {
      throw new CliError("invalid_token", `${target.baseUrl} rejected this token`, {
        exitCode: EXIT.AUTH,
        hint: "Check you copied the whole token and that it is not revoked or expired",
        cause: error,
      });
    }
    throw error;
  }
  if (me.principal.kind === "anonymous" || me.principal.kind === "demo") {
    throw new CliError("invalid_token", "That credential does not identify a user", {
      exitCode: EXIT.AUTH,
    });
  }
  const tokenId = approval?.tokenId ?? me.principal.tokenId;
  let found: ApiToken | undefined;
  if (tokenId && me.principal.kind === "user") {
    found = await api.tokens
      .list()
      .then((tokens) => tokens.find((token) => token.id === tokenId))
      .catch(() => undefined);
  }
  const storedIn = await app.store.set(target.profile, token);
  const config = await app.config();
  const existing = config.profiles[target.profile];
  const now = new Date().toISOString();
  const user = approval?.user ?? me.user ?? undefined;
  config.profiles[target.profile] = {
    baseUrl: existing?.baseUrl ?? target.baseUrl,
    ...(user ? { user } : {}),
    ...(tokenId ? { tokenId } : {}),
    ...((found?.prefix ?? tokenPrefixOf(token))
      ? { tokenPrefix: found?.prefix ?? tokenPrefixOf(token) }
      : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!(config.currentProfile in config.profiles)) config.currentProfile = target.profile;
  app.saveConfig(config);
  if (existing && existing.baseUrl !== target.baseUrl) {
    log.warn(
      `Signed in against ${target.baseUrl} (LATEX_API_URL) but profile "${target.profile}" points at ${existing.baseUrl}.`,
    );
  }
  if (app.env[ENV.TOKEN]) {
    log.warn("LATEX_API_TOKEN is set and still takes precedence over the stored token.");
  }
  return {
    status: "approved",
    profile: target.profile,
    baseUrl: target.baseUrl,
    user: user ?? null,
    tokenId,
    tokenPrefix: found?.prefix ?? tokenPrefixOf(token),
    tokenOrigin: found?.origin,
    expiresAt: approval?.expiresAt ?? found?.expiresAt,
    storedIn,
    storage: app.store.describe(storedIn, target.profile),
  };
}

function renderLogin(data: LoginResult): void {
  const c = colors(rt().stdout);
  const who = data.user?.email ?? data.user?.id ?? "unknown user";
  out(`${c.ok("✔")} Logged in as ${c.bold(who)} ${c.muted(`(profile ${data.profile})`)}`);
  out(
    renderFields([
      ["server", data.baseUrl],
      ["token", data.tokenPrefix ? `${data.tokenPrefix}…` : data.tokenId],
      ["expires", data.expiresAt ?? "never"],
      ["stored in", data.storage],
    ]),
  );
}

const loginData = t.object({
  status: t.enum(["pending", "approved"], "pending: first envelope of a device sign-in"),
  "profile?": t.string(),
  "baseUrl?": t.string(),
  "userCode?": t.string("pending: the code the user confirms in the browser"),
  "verificationUri?": t.string(),
  "verificationUriComplete?": t.string("pending: open this URL to approve"),
  "expiresIn?": t.number("pending: seconds until the code expires"),
  "interval?": t.number("pending: polling interval in seconds"),
  "browserOpened?": t.boolean(),
  "message?": t.string(),
  "user?": t.nullable(t.ref("User")),
  "tokenId?": t.string(),
  "tokenPrefix?": t.string(),
  "tokenOrigin?": t.enum(["dashboard", "cli", "api"]),
  "expiresAt?": t.string(),
  "storedIn?": t.enum(["keychain", "file"]),
  "storage?": t.string("Where the secret was stored (keychain entry or file path)"),
});

async function startDevice(app: AppContext, settings: ResolvedSettings) {
  const { api } = await app.api({ token: "", allowMissingProfile: true });
  try {
    return await api.auth.startDevice({
      clientName: `latex-api-cli ${CLI_VERSION}`,
      hostname: os.hostname().slice(0, 120),
      platform: `${process.platform}-${process.arch}`,
    });
  } catch (error) {
    if (error instanceof LatexApiError && (error.status === 404 || error.status === 401)) {
      // The endpoint is public; 401/404 means this server does not have device sign-in.
      throw new CliError(
        "device_flow_unavailable",
        `${settings.baseUrl} does not support browser sign-in (HTTP ${error.status})`,
        {
          exitCode: EXIT.AUTH,
          hint: "Create a token in the dashboard and run `latex-api auth login --with-token`",
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function waitForApproval(
  app: AppContext,
  pending: PendingLogin,
  timeoutS: number,
): Promise<LoginResult> {
  const { api } = await app.api({ token: "", baseUrl: pending.baseUrl, allowMissingProfile: true });
  const label = (interval: number) =>
    `Waiting for approval of ${pending.userCode} (checking every ${interval}s)`;
  const spinner = progress(label(pending.interval), { force: true });
  let approval: DeviceApproval;
  try {
    approval = await pollDeviceToken({
      api,
      deviceCode: pending.deviceCode,
      interval: pending.interval,
      expiresAt: pending.expiresAt,
      timeoutMs: timeoutS * 1000,
      sleep: rt().sleep,
      now: rt().now,
      onStatus: (status, info) =>
        spinner.update(
          status === "retrying"
            ? `${label(info.interval)}, retrying after a network error`
            : label(info.interval),
        ),
    });
  } catch (error) {
    spinner.fail("Sign-in not completed");
    if (error instanceof CliError && error.code !== "login_timeout") {
      rmSync(app.paths.pendingLogin, { force: true });
    }
    throw error;
  }
  spinner.succeed("Approved in the browser");
  rmSync(app.paths.pendingLogin, { force: true });
  return completeLogin(
    app,
    { profile: pending.profile, baseUrl: pending.baseUrl },
    approval.token,
    approval,
  );
}

function printCode(pending: PendingLogin, browser: OpenUrlResult | undefined): void {
  const { stderr } = rt();
  const c = colors(stderr);
  stderr.write(`${c.muted("One-time code")}  ${c.bold(c.info(pending.userCode))}\n`);
  stderr.write(`${c.muted("Approve at   ")}  ${pending.verificationUriComplete}\n`);
  stderr.write(
    `${c.muted(browser?.opened ? "Opened your browser; confirm the code matches." : "Open the URL in a browser where you are signed in.")}\n\n`,
  );
}

export const loginCommand = leaf({
  name: "login",
  description:
    "Sign in with the browser (device code), or pipe a dashboard token with --with-token",
  args: {
    "with-token": {
      type: "boolean",
      description: "Read a token from stdin (never pass it as an argument)",
    },
    browser: {
      type: "boolean",
      default: true,
      description: "Open the approval page in the default browser",
      negativeDescription: "Only print the URL and code",
    },
    wait: {
      type: "boolean",
      default: true,
      description: "Poll until the sign-in is approved",
      negativeDescription: "Print the code and exit; finish later with --resume",
    },
    resume: { type: "boolean", description: "Finish a sign-in started with --no-wait" },
    timeout: {
      type: "string",
      description: `Seconds to wait for the approval (default ${DEFAULT_LOGIN_TIMEOUT_S})`,
      valueHint: "seconds",
    },
  },
  contract: {
    data: loginData,
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.CONFLICT],
    auth: "none",
    effect: "write",
    output: "stream",
    notes:
      "Device flow in machine mode writes two envelopes (NDJSON): first data.status=pending with userCode and verificationUriComplete, then the final data.status=approved (or an error envelope). With --no-wait only the pending envelope is written; run `auth login --resume` to finish. --with-token reads stdin and writes one envelope.",
  },
  examples: [
    "latex-api auth login",
    "latex-api auth login --no-browser",
    "latex-api auth login --no-wait && latex-api auth login --resume",
    'printf %s "$TOKEN" | latex-api auth login --with-token --profile ci',
  ],
  async run({ args, app, machine }) {
    const timeoutS = parseTimeoutSeconds(args.timeout);
    const settings = await app.settings();

    if (args["with-token"]) {
      if (args._.length > 0) {
        throw new CliError("secret_in_argv", "Pass the token on stdin, not as an argument", {
          exitCode: EXIT.USAGE,
          hint: 'printf %s "$TOKEN" | latex-api auth login --with-token',
        });
      }
      const token = await readTokenInput();
      const data = await completeLogin(
        app,
        { profile: settings.profileName, baseUrl: settings.baseUrl },
        token,
      );
      return {
        data,
        human: renderLogin,
        meta: { profile: data.profile, baseUrl: data.baseUrl },
        nextSteps: ["latex-api auth status"],
      };
    }

    if (args.resume) {
      const pending = readPending(app.paths.pendingLogin);
      if (!pending) {
        throw new CliError("no_pending_login", "There is no sign-in waiting to be resumed", {
          exitCode: EXIT.USAGE,
          hint: "Start one with `latex-api auth login`",
        });
      }
      if (rt().now() >= pending.expiresAt) {
        rmSync(app.paths.pendingLogin, { force: true });
        throw new CliError("expired_token", "The pending sign-in code has expired", {
          exitCode: EXIT.AUTH,
          hint: "Run `latex-api auth login` again",
        });
      }
      const data = await waitForApproval(app, pending, timeoutS);
      return {
        data,
        human: renderLogin,
        meta: { profile: data.profile, baseUrl: data.baseUrl },
        nextSteps: ["latex-api auth status"],
      };
    }

    if (!machine) printBanner({ version: CLI_VERSION, tagline: "Sign in from the terminal" });
    const start = await startDevice(app, settings);
    const pending: PendingLogin = {
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
      interval: start.interval,
      expiresAt: rt().now() + start.expiresIn * 1000,
      profile: settings.profileName,
      baseUrl: settings.baseUrl,
      startedAt: new Date().toISOString(),
    };
    atomicWriteJson(app.paths.pendingLogin, pending, { mode: 0o600 });
    const browser = args.browser ? await openUrl(start.verificationUriComplete) : undefined;
    const pendingData = {
      status: "pending" as const,
      profile: pending.profile,
      baseUrl: pending.baseUrl,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
      expiresIn: start.expiresIn,
      interval: start.interval,
      browserOpened: browser?.opened ?? false,
      message: `Open verificationUriComplete in a browser signed in to the LaTeX API and approve code ${start.userCode}.`,
    };
    const meta = { profile: pending.profile, baseUrl: pending.baseUrl };
    printCode(pending, browser);

    if (!args.wait) {
      return {
        data: pendingData,
        meta,
        nextSteps: ["latex-api auth login --resume"],
        human: () => {
          out(`Approve the code in the browser, then run: latex-api auth login --resume`);
        },
      };
    }
    if (machine) {
      writeEnvelope(
        successEnvelope(pendingData, { ...meta, nextSteps: ["latex-api auth status"] }),
      );
    }
    const data = await waitForApproval(app, pending, timeoutS);
    return { data, human: renderLogin, meta, nextSteps: ["latex-api auth status"] };
  },
});

const statusData = t.object({
  authenticated: t.boolean(),
  profile: t.string(),
  baseUrl: t.string(),
  baseUrlSource: t.enum(["env", "profile", "default"]),
  user: t.nullable(t.ref("User")),
  principal: t.object({
    name: t.string(),
    kind: t.enum(["user", "key", "demo", "anonymous"]),
    "via?": t.enum(["token", "session", "env"]),
    "tokenId?": t.string(),
  }),
  token: t.object({
    source: t.enum(["env", "env-deprecated", "keychain", "file"]),
    "id?": t.string(),
    "prefix?": t.string(),
    storage: t.string("Where the secret lives: env var name, keychain entry or file path"),
  }),
  configPath: t.string(),
});

export const statusCommand = leaf({
  name: "status",
  description:
    "Show who you are signed in as (calls /v1/me), the profile and where the token is stored",
  contract: {
    data: statusData,
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
  },
  examples: ["latex-api auth status", "latex-api auth status --profile staging --json"],
  async run({ app }) {
    const settings = await app.settings();
    app.assertProfileExists(settings);
    if (!settings.token) {
      throw new CliError("not_authenticated", `Not signed in (profile "${settings.profileName}")`, {
        exitCode: EXIT.AUTH,
        hint: "Run `latex-api auth login`, or set LATEX_API_TOKEN",
        details: {
          profile: settings.profileName,
          baseUrl: settings.baseUrl,
          configPath: app.paths.config,
        },
      });
    }
    const { api } = await app.api();
    let me: Awaited<ReturnType<typeof api.me>>;
    try {
      me = await api.me();
    } catch (error) {
      if (error instanceof LatexApiError && error.status === 401) {
        throw new CliError(
          "unauthorized",
          "The token was rejected (revoked, expired or wrong server)",
          {
            exitCode: EXIT.AUTH,
            hint: "Run `latex-api auth login` again",
            details: { profile: settings.profileName, tokenSource: settings.tokenSource },
            cause: error,
          },
        );
      }
      throw error;
    }
    const fromEnv = settings.tokenSource === "env" || settings.tokenSource === "env-deprecated";
    const storage = fromEnv
      ? settings.tokenSource === "env"
        ? ENV.TOKEN
        : ENV.KEY
      : app.store.describe(settings.tokenSource as StoreKind, settings.profileName);
    const data = {
      authenticated: true,
      profile: settings.profileName,
      baseUrl: settings.baseUrl,
      baseUrlSource: settings.baseUrlSource,
      user: me.user,
      principal: me.principal,
      token: {
        source: settings.tokenSource,
        id: me.principal.tokenId ?? (fromEnv ? undefined : settings.profile?.tokenId),
        prefix:
          (fromEnv ? undefined : settings.profile?.tokenPrefix) ??
          tokenPrefixOf(settings.token as string),
        storage,
      },
      configPath: app.paths.config,
    };
    return {
      data,
      human: (d) => {
        const c = colors(rt().stdout);
        const who = d.user?.email ?? d.user?.id ?? d.principal.name;
        out(`${c.ok("✔")} Signed in as ${c.bold(who)} ${c.muted(`(${d.principal.kind})`)}`);
        out(
          renderFields([
            [
              "profile",
              `${d.profile}${settings.profileSource === "flag" || settings.profileSource === "env" ? c.muted(` (from ${settings.profileSource === "flag" ? "--profile" : ENV.PROFILE})`) : ""}`,
            ],
            ["server", `${d.baseUrl}${d.baseUrlSource === "env" ? c.info(` (${ENV.URL})`) : ""}`],
            ["token", d.token.prefix ? `${d.token.prefix}…` : (d.token.id ?? "-")],
            ["stored in", d.token.storage],
            ["config", d.configPath],
          ]),
        );
      },
      nextSteps: ["latex-api token list", "latex-api compile <path>"],
    };
  },
});

export const logoutCommand = leaf({
  name: "logout",
  description: "Revoke the CLI token on the server (unless --keep-token) and delete it locally",
  args: {
    "keep-token": {
      type: "boolean",
      description: "Only delete the local copy; leave the token valid on the server",
    },
  },
  contract: {
    data: t.object({
      profile: t.string(),
      loggedOut: t.boolean("false when there was no stored credential"),
      revoked: t.boolean("true when the token was revoked server-side"),
      "tokenId?": t.string(),
      "revokeSkipped?": t.string("Why the server-side token was left alone"),
      removedFrom: t.array(t.enum(["keychain", "file"])),
    }),
    exitCodes: [EXIT.OK, EXIT.NOT_FOUND],
    auth: "optional",
    effect: "destructive",
    notes:
      "Only tokens created by `auth login` (origin cli) are revoked; dashboard tokens are kept. No confirmation: running logout is the intent.",
  },
  examples: ["latex-api auth logout", "latex-api auth logout --keep-token --profile ci"],
  async run({ args, app }) {
    const settings = await app.settings();
    app.assertProfileExists(settings);
    const name = settings.profileName;
    if (app.env[ENV.TOKEN] || app.env[ENV.KEY]) {
      warnOnce(
        "logout-env",
        "LATEX_API_TOKEN is set in the environment; unset it to stop using it.",
      );
    }
    const stored = await app.store.get(name);
    if (!stored) {
      return {
        data: {
          profile: name,
          loggedOut: false,
          revoked: false,
          removedFrom: [] as StoreKind[],
          revokeSkipped: "no stored credential",
        },
        human: () => out(`Nothing to do: profile "${name}" has no stored credential.`),
      };
    }
    let revoked = false;
    let revokeSkipped: string | undefined;
    let tokenId = settings.profile?.tokenId;
    if (args["keep-token"]) {
      revokeSkipped = "--keep-token";
    } else {
      try {
        const { api } = await app.api({ token: stored.secret });
        tokenId ??= (await api.me()).principal.tokenId;
        const found = tokenId
          ? (await api.tokens.list()).find((token) => token.id === tokenId)
          : undefined;
        if (!found) revokeSkipped = "token not found on the server";
        else if (found.origin !== "cli") {
          revokeSkipped = `token was created in the ${found.origin}; revoke it with \`latex-api token revoke ${found.id}\``;
        } else if (found.status !== "active") revokeSkipped = `token is already ${found.status}`;
        else {
          await api.tokens.revoke(found.id);
          revoked = true;
        }
      } catch (error) {
        revokeSkipped = `could not revoke: ${error instanceof Error ? error.message : String(error)}`;
        log.warn(`${revokeSkipped}. Deleting the local copy anyway.`);
      }
    }
    const removedFrom = await app.store.delete(name);
    const config = await app.config();
    const profile = config.profiles[name];
    if (profile) {
      delete profile.user;
      delete profile.tokenId;
      delete profile.tokenPrefix;
      profile.updatedAt = new Date().toISOString();
      app.saveConfig(config);
    }
    const data = { profile: name, loggedOut: true, revoked, tokenId, revokeSkipped, removedFrom };
    return {
      data,
      human: (d) => {
        const c = colors(rt().stdout);
        out(`${c.ok("✔")} Logged out of profile ${c.bold(d.profile)}`);
        out(
          c.muted(
            d.revoked
              ? `  token ${d.tokenId} revoked on the server`
              : `  server token kept: ${d.revokeSkipped ?? "-"}`,
          ),
        );
      },
      nextSteps: ["latex-api auth login"],
    };
  },
});

export const tokenCommand = leaf({
  name: "token",
  description: "Print the active token to stdout (for piping into other tools)",
  contract: {
    data: t.object({
      token: t.string("The secret"),
      source: t.enum(["env", "env-deprecated", "keychain", "file"]),
    }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
    output: "raw",
    notes:
      "Prints only the secret and a newline, even when piped. --json wraps it in the envelope.",
  },
  examples: [
    'curl -H "Authorization: Bearer $(latex-api auth token)" https://latex-api.crafter.run/v1/me',
  ],
  async run({ app }) {
    const settings = await app.settings();
    app.assertProfileExists(settings);
    if (!settings.token) {
      throw new CliError(
        "not_authenticated",
        `No credential for profile "${settings.profileName}"`,
        {
          exitCode: EXIT.AUTH,
          hint: "Run `latex-api auth login`",
        },
      );
    }
    return { data: { token: settings.token, source: settings.tokenSource }, raw: settings.token };
  },
});

export const authCommand = group({
  name: "auth",
  description: "Sign in, check who you are, sign out",
  commands: [loginCommand, statusCommand, logoutCommand, tokenCommand],
});
