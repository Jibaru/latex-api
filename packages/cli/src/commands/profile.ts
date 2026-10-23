import { rt } from "../blocks/runtime";
import { colors } from "../blocks/style";
import { group, leaf, t } from "../command";
import {
  type CliConfig,
  DEFAULT_BASE_URL,
  DEFAULT_PROFILE,
  normalizeBaseUrl,
  type ProfileConfig,
  validateProfileName,
} from "../config";
import type { AppContext } from "../context";
import type { StoreKind } from "../credentials";
import { CliError, EXIT } from "../exit";
import { approve } from "../gate";
import { log, out } from "../output";
import { renderFields, renderTable } from "../ui";

const profileShape = t.object({
  name: t.string(),
  current: t.boolean("true for the profile used when --profile/LATEX_API_PROFILE are not set"),
  configured: t.boolean("false for the implicit default profile before anything was saved"),
  baseUrl: t.string(),
  "user?": t.ref("User"),
  "tokenId?": t.string(),
  "tokenPrefix?": t.string(),
  credential: t.nullable(t.enum(["keychain", "file"], "Where this profile's secret is stored")),
  "createdAt?": t.string(),
  "updatedAt?": t.string(),
});

interface ProfileView {
  name: string;
  current: boolean;
  configured: boolean;
  baseUrl: string;
  user?: ProfileConfig["user"];
  tokenId?: string;
  tokenPrefix?: string;
  credential: StoreKind | null;
  createdAt?: string;
  updatedAt?: string;
}

async function view(app: AppContext, config: CliConfig, name: string): Promise<ProfileView> {
  const profile = config.profiles[name];
  const stored = await app.store.get(name);
  return {
    name,
    current: config.currentProfile === name,
    configured: Boolean(profile),
    baseUrl: profile?.baseUrl ?? DEFAULT_BASE_URL,
    ...(profile?.user ? { user: profile.user } : {}),
    ...(profile?.tokenId ? { tokenId: profile.tokenId } : {}),
    ...(profile?.tokenPrefix ? { tokenPrefix: profile.tokenPrefix } : {}),
    credential: stored?.store ?? null,
    ...(profile?.createdAt ? { createdAt: profile.createdAt } : {}),
    ...(profile?.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  };
}

function requireProfile(config: CliConfig, name: string): ProfileConfig {
  const profile = config.profiles[name];
  if (!profile) {
    throw new CliError("profile_not_found", `Profile "${name}" does not exist`, {
      exitCode: EXIT.NOT_FOUND,
      hint: "List profiles with `latex-api profile list`",
    });
  }
  return profile;
}

const listCommand = leaf({
  name: "list",
  description: "List profiles, which one is current, and whether each has a stored credential",
  contract: {
    data: t.object({ currentProfile: t.string(), profiles: t.array(profileShape) }),
    exitCodes: [EXIT.OK, EXIT.USAGE],
    auth: "none",
    effect: "read",
  },
  examples: [
    "latex-api profile list",
    "latex-api profile list --json | jq -r '.data.profiles[].name'",
  ],
  async run({ app }) {
    const config = await app.config();
    const names = Object.keys(config.profiles);
    if (!names.includes(config.currentProfile)) names.unshift(config.currentProfile);
    const profiles = await Promise.all(names.map((name) => view(app, config, name)));
    return {
      data: { currentProfile: config.currentProfile, profiles },
      human: (d) => {
        const c = colors(rt().stdout);
        out(
          renderTable(
            ["", "profile", "server", "user", "token", "stored in"],
            d.profiles.map((p: ProfileView) => [
              p.current ? c.info("*") : "",
              p.current ? c.bold(p.name) : p.name,
              p.baseUrl === DEFAULT_BASE_URL ? p.baseUrl : c.info(p.baseUrl),
              p.user?.email ?? p.user?.id ?? c.muted("-"),
              p.tokenPrefix ? `${p.tokenPrefix}…` : c.muted("-"),
              p.credential ?? c.muted("not signed in"),
            ]),
          ),
        );
        out(c.muted("\n* current profile  ·  switch with: latex-api profile use <name>"));
      },
      nextSteps: ["latex-api profile use <name>", "latex-api profile set <name> --url <baseUrl>"],
    };
  },
});

const getCommand = leaf({
  name: "get",
  description: "Show one profile (default: the one in effect) and the settings it resolves to",
  args: { name: { type: "positional", required: false, description: "Profile name" } },
  contract: {
    data: t.object({
      profile: profileShape,
      "effective?": t.object(
        {
          profileSource: t.enum(["flag", "env", "config", "default"]),
          baseUrl: t.string(),
          baseUrlSource: t.enum(["env", "profile", "default"]),
          tokenSource: t.enum(["env", "env-deprecated", "keychain", "file", "none"]),
        },
        "Present when the profile is the one in effect: what each setting resolved to and why",
      ),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.NOT_FOUND],
    auth: "none",
    effect: "read",
  },
  examples: ["latex-api profile get", "latex-api profile get staging"],
  async run({ args, app }) {
    const config = await app.config();
    const settings = await app.settings();
    const name = args.name ? validateProfileName(String(args.name)) : settings.profileName;
    if (args.name || settings.profileSource === "flag" || settings.profileSource === "env") {
      if (name !== DEFAULT_PROFILE || config.profiles[name]) requireProfile(config, name);
    }
    const profile = await view(app, config, name);
    const effective =
      name === settings.profileName
        ? {
            profileSource: settings.profileSource,
            baseUrl: settings.baseUrl,
            baseUrlSource: settings.baseUrlSource,
            tokenSource: settings.tokenSource,
          }
        : undefined;
    return {
      data: { profile, ...(effective ? { effective } : {}) },
      meta: { profile: name, baseUrl: effective?.baseUrl ?? profile.baseUrl },
      human: (d) => {
        const c = colors(rt().stdout);
        out(`${c.bold(d.profile.name)}${d.profile.current ? c.info("  (current)") : ""}`);
        out(
          renderFields([
            ["server", d.profile.baseUrl],
            ["user", d.profile.user?.email ?? d.profile.user?.id],
            ["token", d.profile.tokenPrefix ? `${d.profile.tokenPrefix}…` : undefined],
            ["stored in", d.profile.credential ?? "not signed in"],
            ...(d.effective
              ? ([
                  [
                    "effective url",
                    `${d.effective.baseUrl} ${c.muted(`(${d.effective.baseUrlSource})`)}`,
                  ],
                  ["token from", d.effective.tokenSource],
                ] as Array<[string, string]>)
              : []),
          ]),
        );
      },
    };
  },
});

const useCommand = leaf({
  name: "use",
  description: "Make a profile the current one",
  args: { name: { type: "positional", required: true, description: "Profile name" } },
  contract: {
    data: t.object({ currentProfile: t.string(), previous: t.string() }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.NOT_FOUND],
    auth: "none",
    effect: "write",
  },
  examples: ["latex-api profile use staging"],
  async run({ args, app }) {
    const name = validateProfileName(String(args.name));
    const config = await app.config();
    if (name !== DEFAULT_PROFILE) requireProfile(config, name);
    const previous = config.currentProfile;
    config.currentProfile = name;
    app.saveConfig(config);
    const baseUrl = config.profiles[name]?.baseUrl ?? DEFAULT_BASE_URL;
    if (app.env.LATEX_API_PROFILE) {
      log.warn(
        `LATEX_API_PROFILE=${app.env.LATEX_API_PROFILE} is set and overrides the current profile.`,
      );
    }
    return {
      data: { currentProfile: name, previous },
      meta: { profile: name, baseUrl },
      human: (d) => out(`${colors(rt().stdout).ok("✔")} Now using profile ${d.currentProfile}`),
      nextSteps: ["latex-api auth status"],
    };
  },
});

const setCommand = leaf({
  name: "set",
  description: "Create a profile or change its server URL",
  args: {
    name: { type: "positional", required: true, description: "Profile name" },
    url: {
      type: "string",
      description: `Server base URL (default ${DEFAULT_BASE_URL})`,
      valueHint: "baseUrl",
    },
  },
  contract: {
    data: t.object({ created: t.boolean(), profile: profileShape }),
    exitCodes: [EXIT.OK, EXIT.USAGE],
    auth: "none",
    effect: "write",
  },
  examples: ["latex-api profile set staging --url http://localhost:3999"],
  async run({ args, app }) {
    const name = validateProfileName(String(args.name));
    const config = await app.config();
    const existing = config.profiles[name];
    const now = new Date().toISOString();
    if (existing && args.url === undefined) {
      throw new CliError("usage", "Nothing to change: pass --url <baseUrl>", {
        exitCode: EXIT.USAGE,
      });
    }
    const baseUrl = args.url === undefined ? DEFAULT_BASE_URL : normalizeBaseUrl(String(args.url));
    if (existing) {
      if (existing.baseUrl !== baseUrl && existing.tokenId) {
        log.warn(
          `Profile "${name}" has a token for ${existing.baseUrl}; sign in again for ${baseUrl}.`,
        );
      }
      existing.baseUrl = baseUrl;
      existing.updatedAt = now;
    } else {
      config.profiles[name] = { baseUrl, createdAt: now };
    }
    app.saveConfig(config);
    const profile = await view(app, config, name);
    return {
      data: { created: !existing, profile },
      meta: { profile: name, baseUrl },
      human: (d) =>
        out(
          `${colors(rt().stdout).ok("✔")} ${d.created ? "Created" : "Updated"} profile ${d.profile.name} → ${d.profile.baseUrl}`,
        ),
      nextSteps: [`latex-api auth login --profile ${name}`, `latex-api profile use ${name}`],
    };
  },
});

const renameCommand = leaf({
  name: "rename",
  description: "Rename a profile (its stored credential moves with it)",
  args: {
    from: { type: "positional", required: true, description: "Current name" },
    to: { type: "positional", required: true, description: "New name" },
  },
  contract: {
    data: t.object({ from: t.string(), to: t.string(), currentProfile: t.string() }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.NOT_FOUND, EXIT.CONFLICT],
    auth: "none",
    effect: "write",
  },
  examples: ["latex-api profile rename default personal"],
  async run({ args, app }) {
    const from = validateProfileName(String(args.from));
    const to = validateProfileName(String(args.to));
    const config = await app.config();
    const profile = requireProfile(config, from);
    if (config.profiles[to]) {
      throw new CliError("profile_exists", `Profile "${to}" already exists`, {
        exitCode: EXIT.CONFLICT,
        hint: `Remove it first with \`latex-api profile remove ${to}\``,
      });
    }
    await app.store.rename(from, to);
    delete config.profiles[from];
    config.profiles[to] = { ...profile, updatedAt: new Date().toISOString() };
    if (config.currentProfile === from) config.currentProfile = to;
    app.saveConfig(config);
    return {
      data: { from, to, currentProfile: config.currentProfile },
      meta: { profile: config.currentProfile },
      human: (d) => out(`${colors(rt().stdout).ok("✔")} Renamed ${d.from} → ${d.to}`),
    };
  },
});

const removeCommand = leaf({
  name: "remove",
  description:
    "Delete a profile and its locally stored credential (asks first; --yes when not a terminal)",
  args: {
    name: { type: "positional", required: true, description: "Profile name" },
    yes: { type: "boolean", alias: "y", description: "Skip the confirmation" },
    "dry-run": { type: "boolean", description: "Show what would be removed, change nothing" },
  },
  contract: {
    data: t.object({
      dryRun: t.boolean(),
      removed: t.string("The profile name"),
      credentialRemovedFrom: t.array(t.enum(["keychain", "file"])),
      currentProfile: t.string("The current profile afterwards"),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.NOT_FOUND],
    auth: "none",
    effect: "destructive",
    notes:
      "Does not revoke the token on the server; run `auth logout --profile <name>` first for that. Without --yes in machine mode it fails with confirmation_required (exit 2).",
  },
  examples: [
    "latex-api profile remove staging --dry-run",
    "latex-api profile remove staging --yes",
  ],
  async run({ args, app, machine }) {
    const name = validateProfileName(String(args.name));
    const config = await app.config();
    const profile = requireProfile(config, name);
    const stored = await app.store.get(name);
    const remaining = Object.keys(config.profiles).filter((n) => n !== name);
    const nextCurrent =
      config.currentProfile !== name
        ? config.currentProfile
        : remaining.includes(DEFAULT_PROFILE)
          ? DEFAULT_PROFILE
          : (remaining[0] ?? DEFAULT_PROFILE);
    if (args["dry-run"]) {
      return {
        data: {
          dryRun: true,
          removed: name,
          credentialRemovedFrom: stored ? [stored.store] : [],
          currentProfile: nextCurrent,
        },
        human: (d) =>
          out(
            `${colors(rt().stdout).warn("dry run")} would remove profile ${d.removed}${stored ? ` and its credential (${stored.store})` : ""}`,
          ),
        nextSteps: [`latex-api profile remove ${name} --yes`],
      };
    }
    await approve({
      summary: `Remove profile "${name}"`,
      details: [
        ["server", profile.baseUrl],
        ["user", profile.user?.email ?? profile.user?.id],
        ["credential", stored ? `${stored.store} (deleted locally, not revoked)` : "none"],
      ],
      retryCommand: `latex-api profile remove ${name} --yes`,
      yes: args.yes,
      machine,
    });
    const credentialRemovedFrom = await app.store.delete(name);
    delete config.profiles[name];
    config.currentProfile = nextCurrent;
    app.saveConfig(config);
    if (profile.tokenId && credentialRemovedFrom.length > 0) {
      log.warn(
        `Token ${profile.tokenId} is still valid on the server; revoke it with \`latex-api token revoke ${profile.tokenId}\`.`,
      );
    }
    return {
      data: { dryRun: false, removed: name, credentialRemovedFrom, currentProfile: nextCurrent },
      meta: { profile: nextCurrent },
      human: (d) =>
        out(
          `${colors(rt().stdout).ok("✔")} Removed profile ${d.removed}; current is ${d.currentProfile}`,
        ),
    };
  },
});

export const profileGroup = group({
  name: "profile",
  description: "Named server + credential pairs (default, staging, ...)",
  commands: [listCommand, getCommand, useCommand, setCommand, renameCommand, removeCommand],
});
