import { type ArgsDef, type CommandDef, parseArgs, renderUsage } from "citty";
import { printBanner } from "./blocks/banner";
import { shouldColor } from "./blocks/detect";
import { type Runtime, rt, setRuntime } from "./blocks/runtime";
import { colors, stripAnsi } from "./blocks/style";
import {
  type CommandNode,
  GLOBAL_ARGS,
  type GroupCommand,
  group,
  type LeafCommand,
  leaf,
  resolveNode,
  t,
  walkLeaves,
} from "./command";
import { authCommand } from "./commands/auth";
import { compileCommand, printFailure } from "./commands/compile";
import { doctorCommand } from "./commands/doctor";
import { jobsGroup } from "./commands/jobs";
import { healthCommand, limitsCommand, statsCommand } from "./commands/meta";
import { profileGroup } from "./commands/profile";
import { skillGroup } from "./commands/skill";
import { templatesGroup } from "./commands/templates";
import { tokenGroup } from "./commands/token";
import { AppContext, type ContextOptions } from "./context";
import { CliError, EXIT, EXIT_DESCRIPTIONS, toCliError } from "./exit";
import {
  DEFAULT_GLOBALS,
  errorEnvelope,
  type Globals,
  isMachine,
  log,
  type Meta,
  out,
  resetWarnings,
  setGlobals,
  successEnvelope,
  writeEnvelope,
} from "./output";
import { buildSchema } from "./schema";
import { CLI_NAME, CLI_VERSION } from "./version";

const schemaCommand = leaf({
  name: "schema",
  description: "Describe every command, its flags, output data and exit codes as versioned JSON",
  args: {
    command: {
      type: "positional",
      required: false,
      description: 'Limit to one command or group, e.g. "token create" or "jobs"',
    },
  },
  contract: {
    data: t.object({
      schemaVersion: t.number(),
      cli: t.object({ name: t.string(), version: t.string(), package: t.string() }),
      envelope: t.any("Success and error envelope shapes"),
      exitCodes: t.any("Exit code → meaning"),
      globalFlags: t.array(t.any()),
      environment: t.array(t.object({ name: t.string(), description: t.string() })),
      precedence: t.any(),
      commands: t.array(
        t.any(
          "{command, usage, description, positionals, flags, output, auth, effect, data, exitCodes, notes?, examples?}",
        ),
      ),
      definitions: t.any(
        "API object schemas referenced by commands[].data ($ref #/definitions/...)",
      ),
    }),
    exitCodes: [EXIT.OK, EXIT.NOT_FOUND],
    auth: "none",
    effect: "read",
    notes: "Human mode prints the same document as indented JSON.",
  },
  examples: [
    "latex-api schema",
    "latex-api schema token create",
    "latex-api schema --json | jq '.data.commands[].command'",
  ],
  async run({ args }) {
    // citty puts every positional in `_` (the named one included).
    const filter = (args._.length > 0 ? args._ : [args.command]).filter(
      (v): v is string => typeof v === "string" && v !== "",
    );
    const schema = buildSchema(root, filter);
    if (filter.length > 0 && schema.commands.length === 0) {
      throw new CliError("command_not_found", `No command matches "${filter.join(" ")}"`, {
        exitCode: EXIT.NOT_FOUND,
        hint: "Run `latex-api schema` to list every command",
      });
    }
    return {
      data: schema,
      human: (d) => out(JSON.stringify(d, null, 2)),
    };
  },
});

export const root: GroupCommand = group({
  name: CLI_NAME,
  description: "Compile LaTeX to PDF with the LaTeX API, from a terminal or an agent",
  commands: [
    compileCommand,
    authCommand,
    tokenGroup,
    profileGroup,
    jobsGroup,
    templatesGroup,
    skillGroup,
    doctorCommand,
    schemaCommand,
    healthCommand,
    limitsCommand,
    statsCommand,
  ],
});

/** Pulls --json, --profile, --quiet, --help and --version out of argv, wherever they are. */
export function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  const globals: Globals = { ...DEFAULT_GLOBALS };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--json") globals.json = true;
    else if (arg === "--quiet" || arg === "-q") globals.quiet = true;
    else if (arg === "--help" || arg === "-h") globals.help = true;
    else if (arg === "--version" || arg === "-v") globals.version = true;
    else if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError("usage", "--profile needs a profile name", { exitCode: EXIT.USAGE });
      }
      globals.profile = value;
      i++;
    } else if (arg.startsWith("--profile=")) globals.profile = arg.slice("--profile=".length);
    else rest.push(arg);
  }
  return { globals, rest };
}

function argNames(args: ArgsDef): Map<string, ArgsDef[string]> {
  const names = new Map<string, ArgsDef[string]>();
  for (const [name, def] of Object.entries(args)) {
    if (def.type === "positional") continue;
    names.set(name, def);
    const alias = "alias" in def ? def.alias : undefined;
    const aliases = alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
    for (const name of aliases) names.set(name, def);
  }
  return names;
}

/** citty ignores unknown flags; an agent should hear about a typo instead. */
export function findUnknownFlag(tokens: string[], args: ArgsDef): string | undefined {
  const names = argNames(args);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "--") return undefined;
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) continue;
    const raw = token.replace(/^--?/, "").split("=")[0] as string;
    let def = names.get(raw);
    if (!def && raw.startsWith("no-")) {
      const positive = names.get(raw.slice(3));
      if (positive?.type === "boolean") def = positive;
    }
    if (!def) return token;
    if ((def.type === "string" || def.type === "enum") && !token.includes("=")) i++;
  }
  return undefined;
}

function toCitty(node: CommandNode): CommandDef {
  if (node.kind === "leaf") {
    return {
      meta: { name: node.name, description: node.description },
      args: { ...node.args, ...GLOBAL_ARGS },
    };
  }
  const subCommands: Record<string, CommandDef> = {};
  for (const [name, child] of Object.entries(node.commands)) subCommands[name] = toCitty(child);
  return {
    meta: { name: node.name, description: node.description, version: CLI_VERSION },
    subCommands,
    ...(node === root ? { args: GLOBAL_ARGS } : {}),
  };
}

async function usageText(node: CommandNode, path: string[]): Promise<string> {
  const parentName = [CLI_NAME, ...path.slice(0, -1)].join(" ");
  const cmd = toCitty(node);
  const parent: CommandDef | undefined =
    path.length > 0 ? { meta: { name: parentName } } : undefined;
  let text = await renderUsage(cmd, parent);
  const extra: string[] = [];
  if (node.kind === "leaf") {
    const c = node.contract;
    extra.push(
      `OUTPUT: ${c.output === "raw" ? "raw payload on stdout (--json for the envelope)" : c.output === "stream" ? "NDJSON envelopes on stdout in machine mode" : "one JSON envelope on stdout with --json or when piped"}; auth ${c.auth}; ${c.effect}`,
    );
    extra.push(`EXIT CODES: ${c.exitCodes.join(", ")}  (see \`${CLI_NAME} schema\`)`);
    if (node.examples.length > 0) {
      extra.push(`EXAMPLES:\n${node.examples.map((e) => `  $ ${e}`).join("\n")}`);
    }
  } else if (node === root) {
    extra.push(
      `EXIT CODES:\n${Object.entries(EXIT_DESCRIPTIONS)
        .map(([code, text]) => `  ${code}  ${text}`)
        .join("\n")}`,
    );
    extra.push(
      "ENVIRONMENT: LATEX_API_TOKEN, LATEX_API_URL, LATEX_API_PROFILE, LATEX_API_HOME, NO_COLOR\n" +
        "MACHINE MODE: --json or a non-terminal stdout gives one JSON envelope per line; `latex-api schema` describes them",
    );
  }
  text = `${text}\n\n${extra.join("\n\n")}`;
  return shouldColor(rt().stdout) ? text : stripAnsi(text);
}

export interface RunOptions extends ContextOptions {
  runtime?: Partial<Runtime>;
}

/** Runs one invocation and resolves with its exit code. Never calls process.exit. */
export async function run(
  argv: string[] = process.argv.slice(2),
  options: RunOptions = {},
): Promise<number> {
  if (options.runtime) setRuntime(options.runtime);
  resetWarnings();
  let globals: Globals = { ...DEFAULT_GLOBALS };
  let app: AppContext | undefined;
  try {
    const extracted = extractGlobals(argv);
    globals = extracted.globals;
    setGlobals(globals);
    if (globals.version && extracted.rest.length === 0) {
      out(
        isMachine() && globals.json
          ? JSON.stringify(successEnvelope({ version: CLI_VERSION }))
          : CLI_VERSION,
      );
      return EXIT.OK;
    }
    const { node, path, rest } = resolveNode(root, extracted.rest);

    if (globals.help) {
      out(await usageText(node, path));
      return EXIT.OK;
    }
    if (node.kind === "group") {
      const stray = rest.find((arg) => !arg.startsWith("-"));
      if (stray) {
        throw new CliError("command_not_found", `Unknown command "${[...path, stray].join(" ")}"`, {
          exitCode: EXIT.USAGE,
          hint: `Run \`${[CLI_NAME, ...path].join(" ")} --help\` to see the commands`,
        });
      }
      const flag = rest.find((arg) => arg.startsWith("-"));
      if (flag) {
        throw new CliError("unknown_flag", `Unknown flag ${flag}`, {
          exitCode: EXIT.USAGE,
          hint: `Run \`${[CLI_NAME, ...path].join(" ")} --help\``,
        });
      }
      return await bareGroup(node, path);
    }

    const unknown = findUnknownFlag(rest, node.args);
    if (unknown) {
      throw new CliError("unknown_flag", `Unknown flag ${unknown} for "${path.join(" ")}"`, {
        exitCode: EXIT.USAGE,
        hint: `Run \`${CLI_NAME} ${path.join(" ")} --help\` or \`${CLI_NAME} schema ${path.join(" ")}\``,
      });
    }
    const args = parseArgs(rest, node.args);
    app = new AppContext(globals, options);
    return await runLeaf(node, args, app, globals);
  } catch (error) {
    const cliError = toCliError(error);
    const meta: Meta | undefined = app ? await app.meta() : undefined;
    if (isMachine(globals)) writeEnvelope(errorEnvelope(cliError, meta));
    else {
      log.error(cliError);
      if (cliError.code === "compile_failed" || cliError.code.startsWith("job_"))
        printFailure(cliError);
    }
    if (cliError.code === "internal_error" && rt().env.DEBUG && cliError.cause instanceof Error) {
      log.raw(`${cliError.cause.stack ?? ""}\n`);
    }
    return cliError.exitCode;
  }
}

async function runLeaf(
  node: LeafCommand,
  args: ReturnType<typeof parseArgs>,
  app: AppContext,
  globals: Globals,
): Promise<number> {
  const machine = isMachine(globals);
  const result = await node.run({ args, app, globals, machine });
  if (!result) return EXIT.OK;
  if (node.contract.output === "raw" && !globals.json && result.raw !== undefined) {
    out(result.raw);
    return EXIT.OK;
  }
  const meta: Meta = { ...(await app.meta()), ...result.meta, nextSteps: result.nextSteps };
  if (machine || !result.human) {
    writeEnvelope(successEnvelope(result.data, meta));
  } else {
    result.human(result.data);
    if (result.nextSteps?.length && log.chatty()) {
      const c = colors(rt().stderr);
      log.raw(
        `\n${c.muted("next:")} ${result.nextSteps.map((s) => c.info(s)).join(c.muted("  ·  "))}\n`,
      );
    }
  }
  return EXIT.OK;
}

async function bareGroup(node: GroupCommand, path: string[]): Promise<number> {
  const commands = walkLeaves(node, path).map(({ path: p, command }) => ({
    command: p.join(" "),
    description: command.description,
  }));
  if (isMachine()) {
    writeEnvelope(
      successEnvelope(
        { name: CLI_NAME, version: CLI_VERSION, description: node.description, commands },
        {
          nextSteps: [
            `${CLI_NAME} schema${path.length ? ` ${path.join(" ")}` : ""}`,
            `${CLI_NAME} auth login`,
          ],
        },
      ),
    );
    return EXIT.OK;
  }
  if (node === root)
    printBanner({
      version: CLI_VERSION,
      tagline: "LaTeX to PDF, from your terminal or your agent",
    });
  out(await usageText(node, path));
  return EXIT.OK;
}
