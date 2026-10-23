// `latex-api schema`: a versioned description of the whole command surface, generated from
// the same command tree that dispatches, so it cannot drift from what the commands accept
// and return. API object shapes come from the OpenAPI document bundled at build time.

import openapi from "@latex-api/openapi/openapi.json" with { type: "json" };
import type { ArgDef } from "citty";
import {
  type CommandNode,
  GLOBAL_ARGS,
  type GroupCommand,
  type Shape,
  t,
  walkLeaves,
} from "./command";
import { DEFAULT_BASE_URL, DEFAULT_PROFILE, ENV } from "./config";
import { EXIT_DESCRIPTIONS } from "./exit";
import { CLI_NAME, CLI_VERSION, PACKAGE_NAME } from "./version";

export const SCHEMA_VERSION = 1;

const API_DEFINITIONS = [
  "Job",
  "JobResult",
  "Diagnostic",
  "Engine",
  "BibliographyMode",
  "ApiToken",
  "User",
  "Template",
  "TemplateFile",
  "Limits",
  "Stats",
  "Health",
] as const;

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        key === "$ref" && typeof inner === "string"
          ? inner.replace("#/components/schemas/", "#/definitions/")
          : rewriteRefs(inner);
    }
    return out;
  }
  return value;
}

export function apiDefinitions(): Record<string, Shape> {
  const schemas = (openapi as { components: { schemas: Record<string, unknown> } }).components
    .schemas;
  const defs: Record<string, Shape> = {};
  for (const name of API_DEFINITIONS) {
    if (schemas[name]) defs[name] = rewriteRefs(schemas[name]) as Shape;
  }
  return defs;
}

export interface FlagDoc {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  aliases?: string[];
  options?: string[];
  valueHint?: string;
  /** Boolean flags with default true are turned off with `--no-<name>`. */
  negation?: string;
}

export interface PositionalDoc {
  name: string;
  description?: string;
  required: boolean;
  default?: unknown;
}

export function describeArgs(args: Record<string, ArgDef>): {
  positionals: PositionalDoc[];
  flags: FlagDoc[];
} {
  const positionals: PositionalDoc[] = [];
  const flags: FlagDoc[] = [];
  for (const [name, def] of Object.entries(args)) {
    if (def.type === "positional") {
      positionals.push({
        name,
        description: def.description,
        required: def.required !== false && def.default === undefined,
        ...(def.default !== undefined && { default: def.default }),
      });
      continue;
    }
    const alias = "alias" in def ? def.alias : undefined;
    const aliases: string[] = alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
    flags.push({
      name: `--${name}`,
      type: def.type ?? "string",
      ...(def.description && { description: def.description }),
      ...(def.required && { required: true }),
      ...(def.default !== undefined && { default: def.default }),
      ...(aliases.length > 0 && {
        aliases: aliases.map((a) => (a.length === 1 ? `-${a}` : `--${a}`)),
      }),
      ...(def.type === "enum" &&
        "options" in def && { options: [...(def.options ?? [])].map(String) }),
      ...("valueHint" in def && def.valueHint && { valueHint: def.valueHint }),
      ...(def.type === "boolean" && def.default === true && { negation: `--no-${name}` }),
    });
  }
  return { positionals, flags };
}

export function buildSchema(root: GroupCommand, filter?: string[]) {
  const query = (filter ?? []).join(" ").replace(/[.:]/g, " ").trim();
  const leaves = walkLeaves(root as CommandNode).filter(({ path }) => {
    if (!query) return true;
    const name = path.join(" ");
    return name === query || name.startsWith(`${query} `) || path.join("-") === query;
  });
  const commands = leaves.map(({ path, command }) => {
    const { positionals, flags } = describeArgs(command.args as Record<string, ArgDef>);
    return {
      command: path.join(" "),
      usage: `${CLI_NAME} ${path.join(" ")}${positionals
        .map((p) => (p.required ? ` <${p.name}>` : ` [${p.name}]`))
        .join("")}`,
      description: command.description,
      positionals,
      flags,
      output: command.contract.output ?? "envelope",
      auth: command.contract.auth,
      effect: command.contract.effect,
      data: command.contract.data,
      exitCodes: command.contract.exitCodes,
      ...(command.contract.notes && { notes: command.contract.notes }),
      ...(command.examples.length > 0 && { examples: command.examples }),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    cli: { name: CLI_NAME, version: CLI_VERSION, package: PACKAGE_NAME },
    envelope: {
      machineMode:
        "Machine mode is on with --json or whenever stdout is not a terminal. Then stdout carries exactly one JSON envelope per line; diagnostics and progress go to stderr.",
      success: t.object({
        ok: { const: true },
        data: t.any("Command specific; see commands[].data"),
        meta: t.object({
          "profile?": t.string(),
          "baseUrl?": t.string(),
          "nextSteps?": t.array(t.string(), "Commands worth running next"),
        }),
      }),
      error: t.object({
        ok: { const: false },
        error: t.object({
          code: t.string(
            "Stable snake_case code (API codes such as unauthorized, rate_limited, compile_failed pass through)",
          ),
          message: t.string(),
          "hint?": t.string("What to run or change to recover"),
          "details?": t.any("Structured context, e.g. diagnostics for compile_failed"),
        }),
        "meta?": t.any(),
      }),
    },
    exitCodes: EXIT_DESCRIPTIONS,
    globalFlags: describeArgs(GLOBAL_ARGS as Record<string, ArgDef>).flags,
    environment: [
      { name: ENV.TOKEN, description: "API token; overrides the profile's stored credential" },
      { name: ENV.KEY, description: `Deprecated alias of ${ENV.TOKEN} (warns once)` },
      { name: ENV.URL, description: "Server base URL; overrides the profile's baseUrl" },
      { name: ENV.PROFILE, description: "Profile to use when --profile is not given" },
      { name: ENV.HOME, description: "Directory for config.json, credentials.json and jobs.jsonl" },
      {
        name: ENV.STORE,
        description: "Credential storage: auto (keychain, then file), keychain or file",
      },
      {
        name: ENV.OUTPUT,
        description: "human or json: override the stdout-is-a-terminal guess (--json always wins)",
      },
      { name: "NO_COLOR", description: "Disable colors" },
    ],
    precedence: {
      profile: `--profile > ${ENV.PROFILE} > currentProfile in config > "${DEFAULT_PROFILE}"`,
      baseUrl: `${ENV.URL} > profile baseUrl > ${DEFAULT_BASE_URL}`,
      token: `${ENV.TOKEN} > ${ENV.KEY} (deprecated) > the profile's stored secret (keychain, then credentials.json)`,
    },
    commands,
    definitions: apiDefinitions(),
  };
}
