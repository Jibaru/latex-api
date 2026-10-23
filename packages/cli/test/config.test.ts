import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configDir,
  configPath,
  loadConfig,
  normalizeBaseUrl,
  removeConfig,
  resolveSettings,
  saveConfig,
} from "../src/config";

describe("config location", () => {
  it("uses XDG_CONFIG_HOME or ~/.config on POSIX", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "latex-api"));
    expect(configDir({}, "darwin")).toBe(path.join(os.homedir(), ".config", "latex-api"));
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(
      path.join("/xdg", "latex-api", "config.json"),
    );
  });

  it("uses %APPDATA% on Windows", () => {
    expect(configDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "latex-api"),
    );
    expect(configDir({}, "win32")).toBe(path.join(os.homedir(), "AppData", "Roaming", "latex-api"));
  });

  it("honours LATEX_API_CONFIG_DIR", () => {
    expect(configDir({ LATEX_API_CONFIG_DIR: "/custom" }, "linux")).toBe("/custom");
  });
});

describe("resolveSettings", () => {
  it("lets environment variables win over the config file", () => {
    const fromConfig = resolveSettings({ baseUrl: "https://cfg.test/", apiKey: "cfg" }, {});
    expect(fromConfig).toEqual({
      baseUrl: "https://cfg.test",
      apiKey: "cfg",
      sources: { baseUrl: "config", apiKey: "config" },
    });
    const fromEnv = resolveSettings(
      { baseUrl: "https://cfg.test", apiKey: "cfg" },
      { LATEX_API_URL: "https://env.test", LATEX_API_KEY: "env" },
    );
    expect(fromEnv.baseUrl).toBe("https://env.test");
    expect(fromEnv.apiKey).toBe("env");
    expect(fromEnv.sources).toEqual({ baseUrl: "env", apiKey: "env" });
    const defaults = resolveSettings({}, {});
    expect(defaults.baseUrl).toBe("https://latex-api.crafter.run");
    expect(defaults.apiKey).toBeUndefined();
    expect(defaults.sources).toEqual({ baseUrl: "default", apiKey: "none" });
  });

  it("normalizes URLs typed by the user", () => {
    expect(normalizeBaseUrl("latex.example.com")).toBe("https://latex.example.com");
    expect(normalizeBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeBaseUrl(" https://x.test/api/ ")).toBe("https://x.test/api");
    expect(() => normalizeBaseUrl("")).toThrow();
  });
});

describe("config file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "latex-cli-config-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips, ignores garbage and removes", async () => {
    const file = path.join(dir, "nested", "config.json");
    expect(await loadConfig(file)).toEqual({});
    await saveConfig({ baseUrl: "https://x.test", apiKey: "k" }, file);
    expect(await loadConfig(file)).toEqual({ baseUrl: "https://x.test", apiKey: "k" });
    if (process.platform !== "win32") {
      const mode = (await fs.stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    await fs.writeFile(file, JSON.stringify({ baseUrl: 42, apiKey: null }));
    expect(await loadConfig(file)).toEqual({ baseUrl: undefined, apiKey: undefined });
    expect(await removeConfig(file)).toBe(true);
    expect(await removeConfig(file)).toBe(false);
  });
});
