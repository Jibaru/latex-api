import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appPaths,
  DEFAULT_BASE_URL,
  emptyConfig,
  homeDir,
  loadConfig,
  normalizeBaseUrl,
  resolveBaseUrl,
  resolveProfileName,
  resolveSettings,
  saveConfig,
  validateProfileName,
} from "../src/config";
import { CredentialStore } from "../src/credentials";
import { BASE, memoryKeyring, runCli, tempHome } from "./helpers";

describe("home directory", () => {
  it("prefers LATEX_API_HOME, then the 0.1 LATEX_API_CONFIG_DIR", () => {
    expect(homeDir({ LATEX_API_HOME: "/tmp/h", LATEX_API_CONFIG_DIR: "/old" }, "linux")).toBe(
      path.resolve("/tmp/h"),
    );
    expect(homeDir({ LATEX_API_CONFIG_DIR: "/old" }, "linux")).toBe(path.resolve("/old"));
  });

  it("uses %APPDATA% on Windows and XDG / ~/.config elsewhere", () => {
    expect(homeDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "latex-api"),
    );
    expect(homeDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join("/xdg", "latex-api"));
    expect(homeDir({}, "darwin")).toBe(path.join(os.homedir(), ".config", "latex-api"));
    const paths = appPaths({ LATEX_API_HOME: "/h" }, "linux");
    expect(path.basename(paths.config)).toBe("config.json");
    expect(path.basename(paths.credentials)).toBe("credentials.json");
    expect(path.basename(paths.ledger)).toBe("jobs.jsonl");
  });
});

describe("validation", () => {
  it("accepts sane profile names and rejects the rest", () => {
    expect(validateProfileName("staging")).toBe("staging");
    expect(validateProfileName("ci.prod_2")).toBe("ci.prod_2");
    for (const bad of ["", "-x", "a b", "../x", "x".repeat(65)]) {
      expect(() => validateProfileName(bad)).toThrow(/Invalid profile name/);
    }
  });

  it("normalizes URLs", () => {
    expect(normalizeBaseUrl("latex.example.com")).toBe("https://latex.example.com");
    expect(normalizeBaseUrl("http://localhost:3999/")).toBe("http://localhost:3999");
    expect(normalizeBaseUrl(" https://x.test/api/ ")).toBe("https://x.test/api");
    expect(() => normalizeBaseUrl("")).toThrow();
    expect(() => normalizeBaseUrl("http://")).toThrow();
  });
});

describe("precedence: flags > env > profile > defaults", () => {
  const config = {
    ...emptyConfig(),
    currentProfile: "work",
    profiles: {
      work: { baseUrl: "https://work.test", createdAt: "2026-01-01T00:00:00.000Z" },
      staging: { baseUrl: "http://localhost:3999", createdAt: "2026-01-01T00:00:00.000Z" },
    },
  };

  it("resolves the profile name", () => {
    expect(resolveProfileName("staging", { LATEX_API_PROFILE: "work" }, config)).toEqual({
      name: "staging",
      source: "flag",
    });
    expect(resolveProfileName(undefined, { LATEX_API_PROFILE: "staging" }, config)).toEqual({
      name: "staging",
      source: "env",
    });
    expect(resolveProfileName(undefined, {}, config)).toEqual({ name: "work", source: "config" });
    expect(resolveProfileName(undefined, {}, emptyConfig())).toEqual({
      name: "default",
      source: "default",
    });
  });

  it("resolves the base URL", () => {
    expect(resolveBaseUrl({ LATEX_API_URL: "env.test/" }, config.profiles.work)).toEqual({
      baseUrl: "https://env.test",
      source: "env",
    });
    expect(resolveBaseUrl({}, config.profiles.work)).toEqual({
      baseUrl: "https://work.test",
      source: "profile",
    });
    expect(resolveBaseUrl({}, undefined)).toEqual({ baseUrl: DEFAULT_BASE_URL, source: "default" });
  });

  it("resolves the token: LATEX_API_TOKEN > LATEX_API_KEY > stored secret", async () => {
    const home = await tempHome();
    const store = new CredentialStore(home, { loadKeyring: memoryKeyring().loader });
    await store.set("work", "lta_stored");
    let deprecated = 0;
    const base = { config, flagProfile: undefined, store, onDeprecatedKey: () => deprecated++ };
    expect(
      await resolveSettings({ ...base, env: { LATEX_API_TOKEN: "lta_env", LATEX_API_KEY: "old" } }),
    ).toMatchObject({
      token: "lta_env",
      tokenSource: "env",
    });
    expect(await resolveSettings({ ...base, env: { LATEX_API_KEY: "old" } })).toMatchObject({
      token: "old",
      tokenSource: "env-deprecated",
    });
    expect(deprecated).toBe(1);
    expect(await resolveSettings({ ...base, env: {} })).toMatchObject({
      profileName: "work",
      baseUrl: "https://work.test",
      token: "lta_stored",
      tokenSource: "keychain",
    });
    expect(await resolveSettings({ ...base, flagProfile: "staging", env: {} })).toMatchObject({
      profileName: "staging",
      profileSource: "flag",
      baseUrl: "http://localhost:3999",
      token: undefined,
      tokenSource: "none",
    });
  });

  it("applies end to end through the CLI (meta reflects the resolution)", async () => {
    const home = await tempHome();
    const noUrl = { LATEX_API_URL: undefined };
    await runCli(["profile", "set", "staging", "--url", "http://localhost:3999"], {
      home,
      env: noUrl,
    });
    await runCli(["profile", "set", "work", "--url", "https://work.test"], { home, env: noUrl });
    await runCli(["profile", "use", "work"], { home, env: noUrl });

    const current = await runCli(["profile", "get"], { home, env: noUrl });
    expect(current.envelope.meta).toMatchObject({ profile: "work", baseUrl: "https://work.test" });

    const fromEnv = await runCli(["profile", "get"], {
      home,
      env: { ...noUrl, LATEX_API_PROFILE: "staging" },
    });
    expect(fromEnv.envelope.meta).toMatchObject({
      profile: "staging",
      baseUrl: "http://localhost:3999",
    });

    const flagWins = await runCli(["profile", "get", "--profile", "work"], {
      home,
      env: { ...noUrl, LATEX_API_PROFILE: "staging" },
    });
    expect(flagWins.envelope.meta.profile).toBe("work");
    expect(flagWins.envelope.data.effective.profileSource).toBe("flag");

    const urlEnv = await runCli(["profile", "get"], {
      home,
      env: { LATEX_API_URL: "https://override.test" },
    });
    expect(urlEnv.envelope.data.effective).toMatchObject({
      baseUrl: "https://override.test",
      baseUrlSource: "env",
    });

    const missing = await runCli(["auth", "status", "--profile", "nope"], { home, env: noUrl });
    expect(missing.code).toBe(4);
    expect(missing.envelope.error.code).toBe("profile_not_found");
  });
});

describe("config file", () => {
  let home: string;
  beforeEach(async () => {
    home = await tempHome();
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("round-trips profiles and never writes a secret", async () => {
    const file = path.join(home, "config.json");
    const store = new CredentialStore(home, { loadKeyring: memoryKeyring().loader });
    expect((await loadConfig(file, store)).exists).toBe(false);
    const config = emptyConfig();
    config.profiles.default = {
      baseUrl: BASE,
      tokenId: "tok_1",
      tokenPrefix: "lta_x",
      createdAt: "2026-10-22T00:00:00.000Z",
    };
    saveConfig(file, config);
    const loaded = await loadConfig(file, store);
    expect(loaded.config).toEqual(config);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("migrates the 0.1 flat config: key into the store, URL into profile default", async () => {
    const file = path.join(home, "config.json");
    await fs.writeFile(
      file,
      JSON.stringify({ baseUrl: "https://old.test", apiKey: "legacy-secret" }),
    );
    const keyring = memoryKeyring();
    const store = new CredentialStore(home, { loadKeyring: keyring.loader });
    const loaded = await loadConfig(file, store);
    expect(loaded.migrated).toEqual({ from: "flat", secretStoredIn: "keychain" });
    expect(loaded.config.profiles.default?.baseUrl).toBe("https://old.test");
    expect(loaded.config.currentProfile).toBe("default");
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("legacy-secret");
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1, currentProfile: "default" });
    expect(await store.get("default")).toEqual({ secret: "legacy-secret", store: "keychain" });
    // Second read is a no-op.
    expect((await loadConfig(file, store)).migrated).toBeUndefined();
  });

  it("migrates through the CLI and warns once on stderr", async () => {
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ apiKey: "legacy" }));
    const result = await runCli(["profile", "list"], {
      home,
      env: { LATEX_API_CREDENTIAL_STORE: "file" },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/Migrated the 0.1 config/);
    expect(result.envelope.data.profiles[0]).toMatchObject({ name: "default", credential: "file" });
    expect(readFileSync(path.join(home, "config.json"), "utf8")).not.toContain("legacy");
    expect(existsSync(path.join(home, "credentials.json"))).toBe(true);
  });

  it("reports unreadable JSON as config_invalid (exit 2)", async () => {
    await fs.writeFile(path.join(home, "config.json"), "{nope");
    const result = await runCli(["profile", "list"], { home });
    expect(result.code).toBe(2);
    expect(result.envelope.error).toMatchObject({ code: "config_invalid" });
    expect(result.envelope.error.hint).toMatch(/config\.json/);
  });

  it("warns once when the deprecated LATEX_API_KEY supplies the token", async () => {
    const result = await runCli(["auth", "token"], { home, env: { LATEX_API_KEY: "old-key" } });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("old-key\n");
    expect(result.stderr.match(/LATEX_API_KEY is deprecated/g)).toHaveLength(1);
  });
});
