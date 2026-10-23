// Command definitions carry their own contract (data shape, exit codes, auth, effect), so
// `latex-api schema`, `--help` and the noun-verb test all read the same tree and cannot
// drift from what the commands do.

import type { ArgsDef, ParsedArgs } from "citty";
import type { AppContext } from "./context";
import type { ExitCode } from "./exit";
import type { Globals, Meta } from "./output";

/** A JSON-Schema-flavoured description of a command's `data`. */
export type Shape = Record<string, unknown>;

export const t = {
  string: (description?: string): Shape => ({
    type: "string",
    ...(description && { description }),
  }),
  number: (description?: string): Shape => ({
    type: "number",
    ...(description && { description }),
  }),
  boolean: (description?: string): Shape => ({
    type: "boolean",
    ...(description && { description }),
  }),
  enum: (values: readonly string[], description?: string): Shape => ({
    type: "string",
    enum: [...values],
    ...(description && { description }),
  }),
  array: (items: Shape, description?: string): Shape => ({
    type: "array",
    items,
    ...(description && { description }),
  }),
  nullable: (shape: Shape): Shape => ({ anyOf: [shape, { type: "null" }] }),
  ref: (name: string): Shape => ({ $ref: `#/definitions/${name}` }),
  any: (description?: string): Shape => ({ ...(description && { description }) }),
  /** Keys ending in `?` are optional. */
  object: (props: Record<string, Shape>, description?: string): Shape => {
    const properties: Record<string, Shape> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(props)) {
      const optional = key.endsWith("?");
      const name = optional ? key.slice(0, -1) : key;
      properties[name] = value;
      if (!optional) required.push(name);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 && { required }),
      ...(description && { description }),
    };
  },
};

export interface Contract {
  /** Shape of `data` in the success envelope. */
  data: Shape;
  /** Every exit code the command can return. */
  exitCodes: ExitCode[];
  /** Whether a credential is needed. */
  auth: "required" | "optional" | "none";
  /** What one call can do: read, write (reversible), destructive (irreversible). */
  effect: "read" | "write" | "destructive";
  /**
   * `envelope` (default): one JSON envelope in machine mode.
   * `stream`: NDJSON, several envelopes over time (see `notes`).
   * `raw`: the payload itself on stdout, even when piped; `--json` wraps it in an envelope.
   */
  output?: "envelope" | "stream" | "raw";
  notes?: string;
}

export interface Success<T = unknown> {
  data: T;
  /** Human-mode renderer; writes to stdout via `out()`. */
  human?: (data: T) => void;
  nextSteps?: string[];
  /** Extra or overriding envelope meta (e.g. the profile a `profile use` switched to). */
  meta?: Meta;
  /** For raw-output commands: what to print when not in --json mode. */
  raw?: string;
}

export interface RunContext<A extends ArgsDef> {
  args: ParsedArgs<A>;
  app: AppContext;
  globals: Globals;
  /** True when the envelope goes to stdout (machine mode). */
  machine: boolean;
}

export interface LeafCommand {
  kind: "leaf";
  name: string;
  description: string;
  args: ArgsDef;
  contract: Contract;
  examples: string[];
  // biome-ignore lint/suspicious/noExplicitAny: each leaf narrows its own args and data
  run: (ctx: RunContext<any>) => Promise<Success<any> | undefined>;
}

export interface GroupCommand {
  kind: "group";
  name: string;
  description: string;
  commands: Record<string, CommandNode>;
}

export type CommandNode = LeafCommand | GroupCommand;

export function leaf<A extends ArgsDef>(def: {
  name: string;
  description: string;
  args?: A;
  contract: Contract;
  examples?: string[];
  // biome-ignore lint/suspicious/noExplicitAny: data shapes vary per command; the contract documents them
  run: (ctx: RunContext<A>) => Promise<Success<any> | undefined>;
}): LeafCommand {
  return {
    kind: "leaf",
    name: def.name,
    description: def.description,
    args: def.args ?? {},
    contract: def.contract,
    examples: def.examples ?? [],
    run: def.run as LeafCommand["run"],
  };
}

export function group(def: {
  name: string;
  description: string;
  commands: CommandNode[];
}): GroupCommand {
  const commands: Record<string, CommandNode> = {};
  for (const command of def.commands) commands[command.name] = command;
  return { kind: "group", name: def.name, description: def.description, commands };
}

/** Flags every command accepts; extracted before dispatch so they work in any position. */
export const GLOBAL_ARGS = {
  json: {
    type: "boolean",
    description: "Print one JSON envelope on stdout (automatic when stdout is not a terminal)",
  },
  profile: {
    type: "string",
    description: "Profile to use (default: LATEX_API_PROFILE, then the current profile)",
    valueHint: "name",
  },
  quiet: { type: "boolean", alias: "q", description: "No progress or info lines on stderr" },
} as const satisfies ArgsDef;

export interface LeafEntry {
  path: string[];
  command: LeafCommand;
}

/** Depth-first list of every leaf with its full path (e.g. ["token", "create"]). */
export function walkLeaves(node: CommandNode, prefix: string[] = []): LeafEntry[] {
  if (node.kind === "leaf") return [{ path: prefix, command: node }];
  return Object.values(node.commands).flatMap((child) =>
    walkLeaves(child, [...prefix, child.name]),
  );
}

/** Follows non-flag tokens down the tree; returns the deepest node and what is left. */
export function resolveNode(
  root: GroupCommand,
  argv: string[],
): { node: CommandNode; path: string[]; parent: GroupCommand | undefined; rest: string[] } {
  let node: CommandNode = root;
  let parent: GroupCommand | undefined;
  const path: string[] = [];
  let rest = argv;
  while (node.kind === "group") {
    const index = rest.findIndex((arg) => !arg.startsWith("-"));
    if (index !== 0) break;
    const name = rest[0] as string;
    const child: CommandNode | undefined = node.commands[name];
    if (!child) break;
    parent = node;
    node = child;
    path.push(name);
    rest = rest.slice(1);
  }
  return { node, path, parent, rest };
}
