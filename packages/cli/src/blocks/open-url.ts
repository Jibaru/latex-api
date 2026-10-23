// Adapted from cligentic block `open-url` (registry/platform/open-url.ts).
// Hybrid: same decision order (manual in CI/headless, $BROWSER, per-OS opener, WSL) and the
// same never-throw / never-block verdict. Changes: Windows uses `rundll32 url.dll` instead of
// interpolating the URL into a PowerShell command string (a URL with a quote would have been
// code), and spawn errors are observed asynchronously so a missing opener cannot crash.

import { spawn } from "node:child_process";
import { hasCommand, isCi, isHeadlessLinux, isWsl } from "./detect";
import { rt } from "./runtime";

export interface OpenUrlResult {
  url: string;
  opened: boolean;
  via: "browser-env" | "darwin" | "windows" | "wsl" | "linux" | "manual";
  reason?: string;
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => {});
  child.unref();
}

export type UrlOpener = (url: string) => Promise<OpenUrlResult>;

export const openUrl: UrlOpener = async (url) => {
  const env = rt().env;
  if (!/^https?:\/\//i.test(url)) {
    return { url, opened: false, via: "manual", reason: "not an http(s) URL" };
  }
  if (isCi(env)) return { url, opened: false, via: "manual", reason: "CI environment" };
  if (isHeadlessLinux(env)) {
    return { url, opened: false, via: "manual", reason: "headless Linux (no DISPLAY)" };
  }
  const tryRun = (via: OpenUrlResult["via"], cmd: string, args: string[]): OpenUrlResult => {
    try {
      spawnDetached(cmd, args);
      return { url, opened: true, via };
    } catch (error) {
      return { url, opened: false, via: "manual", reason: (error as Error).message };
    }
  };
  if (env.BROWSER && env.BROWSER !== "none") return tryRun("browser-env", env.BROWSER, [url]);
  if (process.platform === "darwin") return tryRun("darwin", "open", [url]);
  if (process.platform === "win32") {
    return tryRun("windows", "rundll32", ["url.dll,FileProtocolHandler", url]);
  }
  if (isWsl()) {
    if (hasCommand("wslview", env)) return tryRun("wsl", "wslview", [url]);
    if (hasCommand("cmd.exe", env)) return tryRun("wsl", "cmd.exe", ["/c", "start", "", url]);
    return { url, opened: false, via: "manual", reason: "WSL without wslview or cmd.exe" };
  }
  for (const cmd of ["xdg-open", "gio", "sensible-browser"]) {
    if (hasCommand(cmd, env)) return tryRun("linux", cmd, cmd === "gio" ? ["open", url] : [url]);
  }
  return { url, opened: false, via: "manual", reason: "no browser opener found on PATH" };
};
