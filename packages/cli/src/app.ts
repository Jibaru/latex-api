import { type CommandDef, defineCommand, runCommand, showUsage } from "citty";
import { consola } from "consola";
import { CLI_VERSION } from "./client";
import { loginCommand, logoutCommand } from "./commands/auth";
import { compileCommand, reportError } from "./commands/compile";
import { jobsCommand } from "./commands/jobs";
import { healthCommand, limitsCommand, statsCommand } from "./commands/meta";
import { templatesCommand } from "./commands/templates";
import { CliError, EXIT, exitCodeFor } from "./exit";

export const main = defineCommand({
  meta: {
    name: "latex-api",
    version: CLI_VERSION,
    description:
      "Compile LaTeX to PDF with the LaTeX API. Config: ~/.config/latex-api/config.json " +
      "(LATEX_API_URL and LATEX_API_KEY override it). Exit codes: 1 LaTeX errors, 2 usage, 3 network/auth.",
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    compile: compileCommand,
    jobs: jobsCommand,
    templates: templatesCommand,
    limits: limitsCommand,
    stats: statsCommand,
    health: healthCommand,
  },
});

// biome-ignore lint/suspicious/noExplicitAny: citty commands are generic over their args
type AnyCommand = CommandDef<any>;

async function subCommandsOf(cmd: AnyCommand) {
  return typeof cmd.subCommands === "function" ? await cmd.subCommands() : cmd.subCommands;
}

/** Walks `rawArgs` through `subCommands` so `--help` shows the usage of the deepest command. */
export async function resolveSubCommand(
  cmd: AnyCommand,
  rawArgs: string[],
  parent?: AnyCommand,
): Promise<{ command: AnyCommand; parent: AnyCommand | undefined; rest: string[] }> {
  const subCommands = await subCommandsOf(cmd);
  if (!subCommands) return { command: cmd, parent, rest: rawArgs };
  const index = rawArgs.findIndex((arg) => !arg.startsWith("-"));
  if (index === -1) return { command: cmd, parent, rest: rawArgs };
  const name = rawArgs[index]!;
  const entry = subCommands[name];
  if (!entry) return { command: cmd, parent, rest: rawArgs };
  const sub = (await (typeof entry === "function" ? entry() : entry)) as AnyCommand;
  return resolveSubCommand(sub, rawArgs.slice(index + 1), cmd);
}

/**
 * Entry point. Mirrors citty's `runMain` but maps errors to the documented exit codes:
 * 1 LaTeX errors, 2 usage, 3 network/auth.
 */
export async function run(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  try {
    if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
      console.log(CLI_VERSION);
      return;
    }
    const { command, parent, rest } = await resolveSubCommand(main, rawArgs);
    const wantsHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
    const isGroup = Boolean(await subCommandsOf(command)) && !command.run;
    if (wantsHelp || isGroup) {
      await showUsage(command, parent);
      const stray = rest.find((arg) => !arg.startsWith("-"));
      if (!wantsHelp && isGroup && stray) {
        throw new CliError(`Unknown command "${stray}"`, EXIT.USAGE);
      }
      return;
    }
    await runCommand(main, { rawArgs });
  } catch (error) {
    if (error instanceof CliError) {
      consola.error(error.message);
      process.exit(error.exitCode);
    }
    if (error instanceof Error && error.name === "CLIError") {
      consola.error(error.message);
      process.exit(EXIT.USAGE);
    }
    reportError(error, false);
    process.exit(exitCodeFor(error));
  }
}
