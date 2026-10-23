import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialStore } from "../src/credentials";
import { memoryKeyring, tempHome } from "./helpers";

describe("credential store", () => {
  it("uses the keychain when it works and writes no file", async () => {
    const home = await tempHome();
    const keyring = memoryKeyring();
    const store = new CredentialStore(home, { loadKeyring: keyring.loader });
    expect(await store.set("default", "lta_secret")).toBe("keychain");
    expect(keyring.entries.get("latex-api/default")).toBe("lta_secret");
    expect(existsSync(store.filePath)).toBe(false);
    expect(await store.get("default")).toEqual({ secret: "lta_secret", store: "keychain" });
    expect(store.describe("keychain", "default")).toContain(
      'service "latex-api", account "default"',
    );
  });

  it("falls back to a 0600 credentials.json when the native module fails to load", async () => {
    const home = await tempHome();
    const store = new CredentialStore(home, {
      loadKeyring: memoryKeyring({ fail: "load" }).loader,
    });
    expect(await store.set("ci", "lta_ci")).toBe("file");
    expect(store.keychainUnavailableReason).toMatch(/failed to load/);
    expect(JSON.parse(readFileSync(store.filePath, "utf8")).credentials.ci.token).toBe("lta_ci");
    if (process.platform !== "win32")
      expect((await fs.stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect(await store.get("ci")).toEqual({ secret: "lta_ci", store: "file" });
    expect(await store.keychainAvailable()).toBe(false);
  });

  it("falls back when the keychain loads but every call fails (headless Linux, CI)", async () => {
    const home = await tempHome();
    const store = new CredentialStore(home, {
      loadKeyring: memoryKeyring({ fail: "calls" }).loader,
    });
    expect(await store.set("default", "lta_x")).toBe("file");
    expect(store.keychainUnavailableReason).toMatch(/secret service/);
    expect(await store.get("default")).toEqual({ secret: "lta_x", store: "file" });
    expect(await store.delete("default")).toEqual(["file"]);
    expect(existsSync(store.filePath)).toBe(false);
  });

  it("never loads the keychain with LATEX_API_CREDENTIAL_STORE=file", async () => {
    const home = await tempHome();
    let loads = 0;
    const store = new CredentialStore(home, {
      mode: "file",
      loadKeyring: async () => {
        loads++;
        return memoryKeyring().loader();
      },
    });
    expect(await store.set("default", "s")).toBe("file");
    expect(loads).toBe(0);
  });

  it("refuses the file fallback when keychain mode is forced", async () => {
    const home = await tempHome();
    const store = new CredentialStore(home, {
      mode: "keychain",
      loadKeyring: memoryKeyring({ fail: "load" }).loader,
    });
    await expect(store.set("default", "s")).rejects.toThrow(/LATEX_API_CREDENTIAL_STORE=keychain/);
    expect(existsSync(path.join(home, "credentials.json"))).toBe(false);
  });

  it("deletes from both stores and renames across them", async () => {
    const home = await tempHome();
    const keyring = memoryKeyring();
    const store = new CredentialStore(home, { loadKeyring: keyring.loader });
    await store.set("a", "secret-a");
    expect(await store.rename("a", "b")).toBe("keychain");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toEqual({ secret: "secret-a", store: "keychain" });
    expect(await store.rename("missing", "c")).toBeNull();
    expect(await store.delete("b")).toEqual(["keychain"]);
    expect(await store.get("b")).toBeNull();
  });

  it("a keychain write removes a stale file copy", async () => {
    const home = await tempHome();
    const fileStore = new CredentialStore(home, { mode: "file" });
    await fileStore.set("default", "old");
    const store = new CredentialStore(home, { loadKeyring: memoryKeyring().loader });
    await store.set("default", "new");
    expect(existsSync(store.filePath)).toBe(false);
    expect(await store.get("default")).toEqual({ secret: "new", store: "keychain" });
  });
});
