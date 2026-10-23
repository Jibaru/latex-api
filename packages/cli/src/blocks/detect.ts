// Adapted from cligentic block `detect` (https://github.com/Railly/cligentic, registry/platform/detect.ts).
// Hybrid: kept isWsl/isCi/isHeadlessLinux/hasCommand; replaced `detectMode`/`shouldColor`
// because they only look at stdout. Here color is decided per stream (a banner on stderr
// must not color when stderr is piped, even if stdout is a terminal) and env comes from the
// runtime seam so tests can drive it. Output mode lives in ../output.ts.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type OutStream, rt } from "./runtime";

let wslCache: boolean | null = null;
export function isWsl(): boolean {
  if (wslCache !== null) return wslCache;
  if (process.platform !== "linux") {
    wslCache = false;
    return false;
  }
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    wslCache = version.includes("microsoft") || version.includes("wsl");
  } catch {
    wslCache = false;
  }
  return wslCache;
}

export function isCi(env = rt().env): boolean {
  return Boolean(
    env.CI ||
      env.CONTINUOUS_INTEGRATION ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.CIRCLECI ||
      env.BUILDKITE,
  );
}

/** Headless Linux: no display. WSL is not headless (it can open the Windows browser). */
export function isHeadlessLinux(env = rt().env): boolean {
  if (process.platform !== "linux") return false;
  if (isWsl()) return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function hasCommand(cmd: string, env = rt().env): boolean {
  const win = process.platform === "win32";
  const dirs = (env.PATH || env.Path || "").split(win ? ";" : ":");
  const exts = win ? [".exe", ".cmd", ".bat", ""] : [""];
  return dirs.some((dir) => exts.some((ext) => dir && existsSync(path.join(dir, `${cmd}${ext}`))));
}

/** NO_COLOR (any non-empty value) wins, then FORCE_COLOR, then the stream being a TTY. */
export function shouldColor(stream: OutStream = rt().stdout, env = rt().env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}
