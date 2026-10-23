import type { ApiToken } from "@jibaru/latex-api-sdk";
import { rt } from "../blocks/runtime";
import { colors } from "../blocks/style";
import { group, leaf, t } from "../command";
import { CliError, EXIT } from "../exit";
import { approve } from "../gate";
import { log, out } from "../output";
import { formatRelative, renderFields, renderTable } from "../ui";

export const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

function statusColor(status: ApiToken["status"]): string {
  const c = colors(rt().stdout);
  return status === "active"
    ? c.ok(status)
    : status === "revoked"
      ? c.muted(status)
      : c.warn(status);
}

const listCommand = leaf({
  name: "list",
  description: "List your personal API tokens (secrets are never shown)",
  contract: {
    data: t.object({
      tokens: t.array(t.ref("ApiToken")),
      currentTokenId: t.nullable(t.string("The token this profile is using, when known")),
    }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
  },
  examples: [
    "latex-api token list",
    "latex-api token list --json | jq '.data.tokens[] | select(.status==\"active\")'",
  ],
  async run({ app }) {
    const { api, settings } = await app.api({ requireAuth: true });
    const tokens = await api.tokens.list();
    const currentTokenId =
      settings.tokenSource === "keychain" || settings.tokenSource === "file"
        ? (settings.profile?.tokenId ?? null)
        : null;
    return {
      data: { tokens, currentTokenId },
      human: (d) => {
        if (d.tokens.length === 0) {
          out("No tokens yet. Create one with: latex-api token create --name <name>");
          return;
        }
        const c = colors(rt().stdout);
        out(
          renderTable(
            ["", "id", "name", "prefix", "origin", "status", "created", "expires", "last used"],
            d.tokens.map((token: ApiToken) => [
              token.id === d.currentTokenId ? c.info("*") : "",
              token.id,
              token.name,
              `${token.prefix}…`,
              token.origin,
              statusColor(token.status),
              formatRelative(token.createdAt),
              token.expiresAt ? formatRelative(token.expiresAt) : c.muted("never"),
              formatRelative(token.lastUsedAt),
            ]),
            { maxWidths: { 2: 28 } },
          ),
        );
        if (d.currentTokenId) out(c.muted("\n* the token this profile is using"));
      },
      nextSteps: ["latex-api token create --name <name>", "latex-api token revoke <id>"],
    };
  },
});

const createCommand = leaf({
  name: "create",
  description: "Create a personal API token; the secret is printed once",
  args: {
    name: {
      type: "string",
      required: true,
      description: "A label, e.g. ci or laptop",
      valueHint: "name",
    },
    "expires-in-days": {
      type: "string",
      description: `Days until it expires (default ${DEFAULT_TOKEN_EXPIRY_DAYS})`,
      valueHint: "days",
    },
    expiry: {
      type: "boolean",
      default: true,
      description: "Give the token an expiry date",
      negativeDescription: "Create a token that never expires",
    },
  },
  contract: {
    data: t.object({
      token: t.string("The secret. Shown once; store it now (e.g. as LATEX_API_TOKEN in CI)"),
      apiToken: t.ref("ApiToken"),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND, EXIT.CONFLICT],
    auth: "required",
    effect: "write",
  },
  examples: [
    "latex-api token create --name ci --expires-in-days 30",
    "latex-api token create --name build-server --no-expiry --json | jq -r .data.token",
  ],
  async run({ args, app }) {
    const name = String(args.name ?? "").trim();
    if (!name) throw new CliError("usage", "--name is required", { exitCode: EXIT.USAGE });
    if (args["expires-in-days"] !== undefined && args.expiry === false) {
      throw new CliError("usage", "Use either --expires-in-days or --no-expiry, not both", {
        exitCode: EXIT.USAGE,
      });
    }
    let expiresInDays: number | null = DEFAULT_TOKEN_EXPIRY_DAYS;
    if (args.expiry === false) expiresInDays = null;
    else if (args["expires-in-days"] !== undefined) {
      const days = Number(args["expires-in-days"]);
      if (!Number.isInteger(days) || days < 1) {
        throw new CliError("usage", "--expires-in-days must be a whole number of days (>= 1)", {
          exitCode: EXIT.USAGE,
        });
      }
      expiresInDays = days;
    }
    const { api } = await app.api({ requireAuth: true });
    const created = await api.tokens.create({ name, expiresInDays });
    return {
      data: created,
      human: (d) => {
        const c = colors(rt().stdout);
        out(
          `${c.ok("✔")} Created token ${c.bold(d.apiToken.name)} ${c.muted(`(${d.apiToken.id})`)}`,
        );
        out("");
        out(`  ${c.bold(d.token)}`);
        out("");
        out(
          renderFields([
            ["expires", d.apiToken.expiresAt ?? "never"],
            ["use it", "LATEX_API_TOKEN=<token> latex-api compile …"],
          ]),
        );
        log.warn("This is the only time the secret is shown. Store it now.");
      },
      nextSteps: ["latex-api token list"],
    };
  },
});

const revokeCommand = leaf({
  name: "revoke",
  description: "Revoke a token (irreversible). Asks first on a terminal; needs --yes otherwise",
  args: {
    id: { type: "positional", required: true, description: "Token id (see `token list`)" },
    yes: { type: "boolean", alias: "y", description: "Skip the confirmation" },
    "dry-run": {
      type: "boolean",
      description: "Look the token up and show what would be revoked, without revoking",
    },
  },
  contract: {
    data: t.object({
      dryRun: t.boolean(),
      revoked: t.boolean(),
      apiToken: t.ref("ApiToken"),
      usedByThisProfile: t.boolean("true when this is the token the active profile signs in with"),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND, EXIT.CONFLICT],
    auth: "required",
    effect: "destructive",
    notes:
      "Without --yes in machine mode it fails with confirmation_required (exit 2) instead of prompting.",
  },
  examples: ["latex-api token revoke tok_123 --dry-run", "latex-api token revoke tok_123 --yes"],
  async run({ args, app, machine }) {
    const id = String(args.id);
    const { api, settings } = await app.api({ requireAuth: true });
    // The preview runs the real lookup, so a dry run proves the id exists and is revocable.
    const found = (await api.tokens.list()).find((token) => token.id === id);
    if (!found) {
      throw new CliError("token_not_found", `No token with id "${id}"`, {
        exitCode: EXIT.NOT_FOUND,
        hint: "List your tokens with `latex-api token list`",
      });
    }
    const usedByThisProfile =
      (settings.tokenSource === "keychain" || settings.tokenSource === "file") &&
      settings.profile?.tokenId === id;
    if (args["dry-run"]) {
      return {
        data: { dryRun: true, revoked: false, apiToken: found, usedByThisProfile },
        human: (d) => {
          const c = colors(rt().stdout);
          out(
            `${c.warn("dry run")} would revoke ${c.bold(d.apiToken.name)} (${d.apiToken.prefix}…, ${d.apiToken.status})`,
          );
          if (d.usedByThisProfile) out(c.warn("  this is the token this profile signs in with"));
        },
        nextSteps: [`latex-api token revoke ${id} --yes`],
      };
    }
    if (found.status !== "active") {
      throw new CliError("token_not_active", `Token "${found.name}" is already ${found.status}`, {
        exitCode: EXIT.CONFLICT,
      });
    }
    await approve({
      summary: `Revoke token "${found.name}" (${found.prefix}…)`,
      details: [
        ["id", found.id],
        ["origin", found.origin],
        [
          "note",
          usedByThisProfile ? "this profile signs in with it; you will be logged out" : undefined,
        ],
      ],
      retryCommand: `latex-api token revoke ${id} --yes`,
      yes: args.yes,
      machine,
    });
    const apiToken = await api.tokens.revoke(id);
    return {
      data: { dryRun: false, revoked: true, apiToken, usedByThisProfile },
      human: (d) => {
        const c = colors(rt().stdout);
        out(`${c.ok("✔")} Revoked ${c.bold(d.apiToken.name)} (${d.apiToken.prefix}…)`);
        if (d.usedByThisProfile)
          log.warn("This profile's credential no longer works; run `latex-api auth login`.");
      },
      nextSteps: usedByThisProfile ? ["latex-api auth login"] : ["latex-api token list"],
    };
  },
});

export const tokenGroup = group({
  name: "token",
  description: "Manage personal API tokens (for CI and other machines)",
  commands: [listCommand, createCommand, revokeCommand],
});
