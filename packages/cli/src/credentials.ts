// Secrets live here and nowhere else: the OS keychain first (service `latex-api`, account =
// profile name), and a 0600 `credentials.json` next to the config when the keychain is not
// usable (headless Linux without a secret service, CI, a container, or a Bun-compiled binary
// where the native module cannot load). config.json only ever holds identifiers.
//
// Pattern: cligentic `auth-patterns` architecture 3 (keychain with file fallback). The
// `session` block's file layout was not adopted: it stores one session, and this CLI needs
// one secret per profile.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./blocks/atomic-write";

export const KEYCHAIN_SERVICE = "latex-api";

export type StoreKind = "keychain" | "file";
export type StoreMode = "auto" | "keychain" | "file";

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

export type KeyringLoader = () => Promise<KeyringModule>;

/**
 * Loads `@napi-rs/keyring` lazily. The specifier is a variable on purpose: bundlers
 * (tsdown, `bun build --compile`) leave it alone, so a binary without the native addon fails
 * here at runtime and falls back to the file instead of failing to build or start.
 */
export const loadNativeKeyring: KeyringLoader = async () => {
  const specifier = ["@napi-rs", "keyring"].join("/");
  const mod = (await import(specifier)) as Partial<KeyringModule> & { default?: KeyringModule };
  const Entry = mod.Entry ?? mod.default?.Entry;
  if (typeof Entry !== "function") throw new Error("@napi-rs/keyring has no Entry export");
  return { Entry };
};

interface CredentialsFile {
  version: 1;
  credentials: Record<string, { token: string; storedAt: string }>;
}

export interface StoredSecret {
  secret: string;
  store: StoreKind;
}

export interface CredentialStoreOptions {
  mode?: StoreMode;
  loadKeyring?: KeyringLoader;
}

export function parseStoreMode(value: string | undefined): StoreMode {
  if (value === "file" || value === "keychain" || value === "auto") return value;
  return "auto";
}

export class CredentialStore {
  readonly filePath: string;
  readonly mode: StoreMode;
  private readonly loader: KeyringLoader;
  private keyring: Promise<KeyringModule | null> | undefined;
  /** Why the keychain is not in use, once that has been determined. */
  keychainUnavailableReason: string | undefined;

  constructor(dir: string, options: CredentialStoreOptions = {}) {
    this.filePath = path.join(dir, "credentials.json");
    this.mode = options.mode ?? "auto";
    this.loader = options.loadKeyring ?? loadNativeKeyring;
  }

  private loadKeyring(): Promise<KeyringModule | null> {
    if (this.mode === "file") {
      this.keychainUnavailableReason = "LATEX_API_CREDENTIAL_STORE=file";
      return Promise.resolve(null);
    }
    this.keyring ??= this.loader().catch((error: unknown) => {
      this.keychainUnavailableReason = `keychain module failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return null;
    });
    return this.keyring;
  }

  private entry(mod: KeyringModule, account: string): KeyringEntry {
    return new mod.Entry(KEYCHAIN_SERVICE, account);
  }

  /** True when a keychain write/read round trip is possible right now. */
  async keychainAvailable(): Promise<boolean> {
    const mod = await this.loadKeyring();
    if (!mod) return false;
    try {
      this.entry(mod, "__latex-api-probe__").getPassword();
      return true;
    } catch (error) {
      this.keychainUnavailableReason = `keychain unavailable: ${(error as Error).message}`;
      return false;
    }
  }

  private readFile(): CredentialsFile {
    if (!existsSync(this.filePath)) return { version: 1, credentials: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CredentialsFile>;
      const credentials =
        parsed && typeof parsed.credentials === "object" && parsed.credentials !== null
          ? parsed.credentials
          : {};
      return { version: 1, credentials };
    } catch {
      return { version: 1, credentials: {} };
    }
  }

  private writeFile(file: CredentialsFile): void {
    if (Object.keys(file.credentials).length === 0) {
      rmSync(this.filePath, { force: true });
      return;
    }
    atomicWriteJson(this.filePath, file, { mode: 0o600 });
  }

  async get(account: string): Promise<StoredSecret | null> {
    const mod = await this.loadKeyring();
    if (mod) {
      try {
        const secret = this.entry(mod, account).getPassword();
        if (secret) return { secret, store: "keychain" };
      } catch (error) {
        this.keychainUnavailableReason = `keychain unavailable: ${(error as Error).message}`;
      }
    }
    const entry = this.readFile().credentials[account];
    return entry?.token ? { secret: entry.token, store: "file" } : null;
  }

  /** Stores the secret, preferring the keychain; returns where it landed. */
  async set(account: string, secret: string): Promise<StoreKind> {
    const mod = await this.loadKeyring();
    if (mod) {
      try {
        const entry = this.entry(mod, account);
        entry.setPassword(secret);
        if (entry.getPassword() === secret) {
          this.removeFromFile(account);
          return "keychain";
        }
        this.keychainUnavailableReason = "keychain did not return the stored secret";
      } catch (error) {
        this.keychainUnavailableReason = `keychain unavailable: ${(error as Error).message}`;
      }
    }
    if (this.mode === "keychain") {
      throw new Error(
        `LATEX_API_CREDENTIAL_STORE=keychain but ${this.keychainUnavailableReason ?? "the keychain failed"}`,
      );
    }
    const file = this.readFile();
    file.credentials[account] = { token: secret, storedAt: new Date().toISOString() };
    this.writeFile(file);
    return "file";
  }

  private removeFromFile(account: string): boolean {
    const file = this.readFile();
    if (!(account in file.credentials)) return false;
    delete file.credentials[account];
    this.writeFile(file);
    return true;
  }

  /** Deletes the secret everywhere it exists; returns the stores it was removed from. */
  async delete(account: string): Promise<StoreKind[]> {
    const removed: StoreKind[] = [];
    const mod = await this.loadKeyring();
    if (mod) {
      try {
        if (this.entry(mod, account).deletePassword()) removed.push("keychain");
      } catch {
        // missing entry or keychain unavailable: nothing to remove there
      }
    }
    if (this.removeFromFile(account)) removed.push("file");
    return removed;
  }

  async rename(from: string, to: string): Promise<StoreKind | null> {
    const existing = await this.get(from);
    if (!existing) return null;
    const store = await this.set(to, existing.secret);
    await this.delete(from);
    return store;
  }

  describe(store: StoreKind | null, account: string): string {
    if (store === "keychain")
      return `OS keychain (service "${KEYCHAIN_SERVICE}", account "${account}")`;
    if (store === "file") return this.filePath;
    return "not stored";
  }
}
