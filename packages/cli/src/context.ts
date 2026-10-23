// Per-invocation state: paths, config (read once, migrated once), resolved settings and
// SDK clients. Commands receive this instead of reaching for process.env.

import { LatexApi } from "@jibaru/latex-api-sdk";
import { rt } from "./blocks/runtime";
import {
  type AppPaths,
  appPaths,
  type CliConfig,
  ENV,
  loadConfig,
  type ResolvedSettings,
  resolveSettings,
  saveConfig,
} from "./config";
import { CredentialStore, type KeyringLoader, parseStoreMode } from "./credentials";
import { CliError, EXIT } from "./exit";
import { type Globals, log, warnOnce } from "./output";
import { CLI_VERSION } from "./version";

export interface ContextOptions {
  loadKeyring?: KeyringLoader;
}

export interface ApiOptions {
  /** Fail with `not_authenticated` (exit 3) when no token resolves. */
  requireAuth?: boolean;
  /** Allow a profile named by --profile / LATEX_API_PROFILE that is not in config yet. */
  allowMissingProfile?: boolean;
  /** Override the resolved token ("" sends no credential, for the device flow). */
  token?: string;
  baseUrl?: string;
}

export class AppContext {
  readonly paths: AppPaths;
  readonly store: CredentialStore;
  private configCache: CliConfig | undefined;
  private settingsCache: ResolvedSettings | undefined;

  constructor(
    readonly globals: Globals,
    options: ContextOptions = {},
  ) {
    this.paths = appPaths(this.env);
    this.store = new CredentialStore(this.paths.home, {
      mode: parseStoreMode(this.env[ENV.STORE]),
      loadKeyring: options.loadKeyring,
    });
  }

  get env(): Record<string, string | undefined> {
    return rt().env;
  }

  async config(): Promise<CliConfig> {
    if (this.configCache) return this.configCache;
    const loaded = await loadConfig(this.paths.config, this.store);
    if (loaded.migrated) {
      log.warn(
        `Migrated the 0.1 config at ${this.paths.config} to profile "default"` +
          (loaded.migrated.secretStoredIn
            ? `; the API key moved to ${this.store.describe(loaded.migrated.secretStoredIn, "default")}`
            : ""),
      );
    }
    this.configCache = loaded.config;
    return loaded.config;
  }

  saveConfig(config: CliConfig): void {
    saveConfig(this.paths.config, config);
    this.configCache = config;
    this.settingsCache = undefined;
  }

  invalidate(): void {
    this.settingsCache = undefined;
  }

  async settings(): Promise<ResolvedSettings> {
    if (this.settingsCache) return this.settingsCache;
    this.settingsCache = await resolveSettings({
      config: await this.config(),
      flagProfile: this.globals.profile,
      env: this.env,
      store: this.store,
      onDeprecatedKey: () =>
        warnOnce("LATEX_API_KEY", "LATEX_API_KEY is deprecated; set LATEX_API_TOKEN instead."),
    });
    return this.settingsCache;
  }

  /** Throws `profile_not_found` when --profile / LATEX_API_PROFILE names an unknown profile. */
  assertProfileExists(settings: ResolvedSettings): void {
    if (settings.profile) return;
    if (settings.profileSource === "flag" || settings.profileSource === "env") {
      throw new CliError("profile_not_found", `Profile "${settings.profileName}" does not exist`, {
        exitCode: EXIT.NOT_FOUND,
        hint: `Create it with \`latex-api profile set ${settings.profileName} --url <baseUrl>\` or list them with \`latex-api profile list\``,
      });
    }
  }

  async api(options: ApiOptions = {}): Promise<{ api: LatexApi; settings: ResolvedSettings }> {
    const settings = await this.settings();
    if (!options.allowMissingProfile) this.assertProfileExists(settings);
    const token = options.token ?? settings.token;
    if (options.requireAuth && !token) {
      throw new CliError(
        "not_authenticated",
        `No credential for profile "${settings.profileName}"`,
        {
          exitCode: EXIT.AUTH,
          hint: "Run `latex-api auth login`, or set LATEX_API_TOKEN to a token from the dashboard",
        },
      );
    }
    const api = new LatexApi({
      baseUrl: options.baseUrl ?? settings.baseUrl,
      apiKey: token ?? "",
      fetch: rt().fetch,
      userAgent: `latex-api-cli/${CLI_VERSION}`,
    });
    return { api, settings };
  }

  /** Meta for the envelope; never throws (schema/skill must work with a broken config). */
  async meta(): Promise<{ profile?: string; baseUrl?: string }> {
    try {
      const s = await this.settings();
      return { profile: s.profileName, baseUrl: s.baseUrl };
    } catch {
      return {};
    }
  }
}
