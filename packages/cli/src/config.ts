import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://latex-api.crafter.run";
export const ENV_URL = "LATEX_API_URL";
export const ENV_KEY = "LATEX_API_KEY";

export interface CliConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface Settings {
  baseUrl: string;
  apiKey: string | undefined;
  /** Where each value came from, for `login` feedback and debugging. */
  sources: { baseUrl: "env" | "config" | "default"; apiKey: "env" | "config" | "none" };
}

type Env = Record<string, string | undefined>;

/**
 * `$XDG_CONFIG_HOME/latex-api` (or `~/.config/latex-api`) on POSIX,
 * `%APPDATA%\latex-api` on Windows.
 */
export function configDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.LATEX_API_CONFIG_DIR) return env.LATEX_API_CONFIG_DIR;
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "latex-api");
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "latex-api");
}

export function configPath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(configDir(env, platform), "config.json");
}

export async function loadConfig(file: string = configPath()): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const { baseUrl, apiKey } = parsed as Record<string, unknown>;
    return {
      baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
      apiKey: typeof apiKey === "string" ? apiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveConfig(config: CliConfig, file: string = configPath()): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeConfig(file: string = configPath()): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Environment variables always win over the config file. */
export function resolveSettings(config: CliConfig, env: Env = process.env): Settings {
  const envUrl = env[ENV_URL]?.trim();
  const envKey = env[ENV_KEY]?.trim();
  const baseUrl = (envUrl || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = envKey || config.apiKey || undefined;
  return {
    baseUrl,
    apiKey,
    sources: {
      baseUrl: envUrl ? "env" : config.baseUrl ? "config" : "default",
      apiKey: envKey ? "env" : config.apiKey ? "config" : "none",
    },
  };
}

export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  if (!url) throw new Error("The URL is empty");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}
