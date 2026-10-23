// Profiles and settings resolution.
//
// config.json (identifiers only, never a secret):
//   { "version": 1, "currentProfile": "default",
//     "profiles": { "default": { "baseUrl", "user"?, "tokenId"?, "tokenPrefix"?, "createdAt" } } }
//
// Location: $LATEX_API_HOME, else %APPDATA%\latex-api (Windows), else
// $XDG_CONFIG_HOME/latex-api or ~/.config/latex-api. The home override follows the corpus
// convention ({APP}_HOME) so tests and smoke runs never touch the real config.
//
// Precedence, each setting resolved on its own:
//   profile name: --profile > LATEX_API_PROFILE > currentProfile in config > "default"
//   base URL:     LATEX_API_URL > the profile's baseUrl > https://latex-api.crafter.run
//   token:        LATEX_API_TOKEN > LATEX_API_KEY (deprecated) > the profile's stored secret

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson } from "./blocks/atomic-write";
import type { CredentialStore, StoreKind } from "./credentials";
import { CliError, EXIT } from "./exit";

export const DEFAULT_BASE_URL = "https://latex-api.crafter.run";
export const DEFAULT_PROFILE = "default";
export const CONFIG_VERSION = 1;

export const ENV = {
  HOME: "LATEX_API_HOME",
  /** 0.1.x name for the home override; still honoured. */
  LEGACY_HOME: "LATEX_API_CONFIG_DIR",
  URL: "LATEX_API_URL",
  TOKEN: "LATEX_API_TOKEN",
  /** Deprecated alias of LATEX_API_TOKEN. */
  KEY: "LATEX_API_KEY",
  PROFILE: "LATEX_API_PROFILE",
  STORE: "LATEX_API_CREDENTIAL_STORE",
  OUTPUT: "LATEX_API_OUTPUT",
} as const;

export interface ProfileUser {
  id: string;
  email?: string;
}

export interface ProfileConfig {
  baseUrl: string;
  user?: ProfileUser;
  tokenId?: string;
  tokenPrefix?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CliConfig {
  version: number;
  currentProfile: string;
  profiles: Record<string, ProfileConfig>;
}

type Env = Record<string, string | undefined>;

export function emptyConfig(): CliConfig {
  return { version: CONFIG_VERSION, currentProfile: DEFAULT_PROFILE, profiles: {} };
}

export function homeDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  const override = env[ENV.HOME]?.trim() || env[ENV.LEGACY_HOME]?.trim();
  if (override) return path.resolve(override);
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "latex-api");
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "latex-api");
}

export interface AppPaths {
  home: string;
  config: string;
  credentials: string;
  ledger: string;
  pendingLogin: string;
}

export function appPaths(env: Env, platform: NodeJS.Platform = process.platform): AppPaths {
  const home = homeDir(env, platform);
  return {
    home,
    config: path.join(home, "config.json"),
    credentials: path.join(home, "credentials.json"),
    ledger: path.join(home, "jobs.jsonl"),
    pendingLogin: path.join(home, "pending-login.json"),
  };
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_NAME.test(trimmed)) {
    throw new CliError(
      "invalid_profile_name",
      `Invalid profile name "${name}": use letters, digits, ".", "_" or "-" (max 64, starting with a letter or digit)`,
      { exitCode: EXIT.USAGE },
    );
  }
  return trimmed;
}

export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  if (!url) throw new CliError("invalid_url", "The URL is empty", { exitCode: EXIT.USAGE });
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid_url", `Not a valid URL: ${input}`, { exitCode: EXIT.USAGE });
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceProfile(value: unknown): ProfileConfig | undefined {
  if (!isRecord(value)) return undefined;
  const profile: ProfileConfig = {
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl ? value.baseUrl : DEFAULT_BASE_URL,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
  };
  if (isRecord(value.user) && typeof value.user.id === "string") {
    profile.user = { id: value.user.id };
    if (typeof value.user.email === "string") profile.user.email = value.user.email;
  }
  if (typeof value.tokenId === "string") profile.tokenId = value.tokenId;
  if (typeof value.tokenPrefix === "string") profile.tokenPrefix = value.tokenPrefix;
  if (typeof value.updatedAt === "string") profile.updatedAt = value.updatedAt;
  return profile;
}

export interface LoadedConfig {
  config: CliConfig;
  exists: boolean;
  /** Set when a 0.1.x flat `{ baseUrl, apiKey }` file was converted on this read. */
  migrated: { from: "flat"; secretStoredIn: StoreKind | null } | undefined;
}

/**
 * Reads config.json. A 0.1.x flat file is migrated on first read: its URL becomes profile
 * `default`, its key moves into the credential store, and the file is rewritten without it.
 */
export async function loadConfig(file: string, store: CredentialStore): Promise<LoadedConfig> {
  if (!existsSync(file)) return { config: emptyConfig(), exists: false, migrated: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError("config_invalid", `Cannot parse ${file}: ${(error as Error).message}`, {
      exitCode: EXIT.USAGE,
      hint: `Fix the JSON or delete ${file} and run \`latex-api auth login\` again`,
    });
  }
  if (!isRecord(parsed)) {
    throw new CliError("config_invalid", `${file} does not contain a JSON object`, {
      exitCode: EXIT.USAGE,
      hint: `Delete ${file} and run \`latex-api auth login\` again`,
    });
  }

  if (!isRecord(parsed.profiles)) {
    // 0.1.x: { baseUrl?, apiKey? }
    const config = emptyConfig();
    const baseUrl =
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : undefined;
    const apiKey = typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : undefined;
    let secretStoredIn: StoreKind | null = null;
    if (baseUrl || apiKey) {
      config.profiles[DEFAULT_PROFILE] = {
        baseUrl: baseUrl ?? DEFAULT_BASE_URL,
        createdAt: new Date().toISOString(),
      };
      if (apiKey) secretStoredIn = await store.set(DEFAULT_PROFILE, apiKey);
    }
    saveConfig(file, config);
    return { config, exists: true, migrated: { from: "flat", secretStoredIn } };
  }

  const config = emptyConfig();
  config.version = typeof parsed.version === "number" ? parsed.version : CONFIG_VERSION;
  if (typeof parsed.currentProfile === "string" && parsed.currentProfile) {
    config.currentProfile = parsed.currentProfile;
  }
  for (const [name, value] of Object.entries(parsed.profiles)) {
    const profile = coerceProfile(value);
    if (profile) config.profiles[name] = profile;
  }
  return { config, exists: true, migrated: undefined };
}

export function saveConfig(file: string, config: CliConfig): void {
  const ordered: CliConfig = {
    version: CONFIG_VERSION,
    currentProfile: config.currentProfile,
    profiles: config.profiles,
  };
  atomicWriteJson(file, ordered, { mode: 0o600 });
}

export type ProfileSource = "flag" | "env" | "config" | "default";
export type BaseUrlSource = "env" | "profile" | "default";
export type TokenSource = "env" | "env-deprecated" | StoreKind | "none";

export interface ResolvedSettings {
  profileName: string;
  profileSource: ProfileSource;
  profile: ProfileConfig | undefined;
  baseUrl: string;
  baseUrlSource: BaseUrlSource;
  token: string | undefined;
  tokenSource: TokenSource;
}

export function resolveProfileName(
  flag: string | undefined,
  env: Env,
  config: CliConfig,
): { name: string; source: ProfileSource } {
  if (flag?.trim()) return { name: validateProfileName(flag), source: "flag" };
  const fromEnv = env[ENV.PROFILE]?.trim();
  if (fromEnv) return { name: validateProfileName(fromEnv), source: "env" };
  if (config.currentProfile && config.currentProfile in config.profiles) {
    return { name: config.currentProfile, source: "config" };
  }
  if (config.currentProfile && config.currentProfile !== DEFAULT_PROFILE) {
    return { name: config.currentProfile, source: "config" };
  }
  return { name: DEFAULT_PROFILE, source: "default" };
}

export function resolveBaseUrl(
  env: Env,
  profile: ProfileConfig | undefined,
): { baseUrl: string; source: BaseUrlSource } {
  const fromEnv = env[ENV.URL]?.trim();
  if (fromEnv) return { baseUrl: normalizeBaseUrl(fromEnv), source: "env" };
  if (profile?.baseUrl) return { baseUrl: profile.baseUrl.replace(/\/+$/, ""), source: "profile" };
  return { baseUrl: DEFAULT_BASE_URL, source: "default" };
}

export interface ResolveInput {
  config: CliConfig;
  flagProfile: string | undefined;
  env: Env;
  store: CredentialStore;
  /** Called when the deprecated LATEX_API_KEY is what supplied the token. */
  onDeprecatedKey?: () => void;
}

export async function resolveSettings(input: ResolveInput): Promise<ResolvedSettings> {
  const { config, env, store } = input;
  const { name, source } = resolveProfileName(input.flagProfile, env, config);
  const profile = config.profiles[name];
  const { baseUrl, source: baseUrlSource } = resolveBaseUrl(env, profile);

  let token: string | undefined;
  let tokenSource: TokenSource = "none";
  const envToken = env[ENV.TOKEN]?.trim();
  const envKey = env[ENV.KEY]?.trim();
  if (envToken) {
    token = envToken;
    tokenSource = "env";
  } else if (envKey) {
    token = envKey;
    tokenSource = "env-deprecated";
    input.onDeprecatedKey?.();
  } else {
    const stored = await store.get(name);
    if (stored) {
      token = stored.secret;
      tokenSource = stored.store;
    }
  }

  return {
    profileName: name,
    profileSource: source,
    profile,
    baseUrl,
    baseUrlSource,
    token,
    tokenSource,
  };
}
