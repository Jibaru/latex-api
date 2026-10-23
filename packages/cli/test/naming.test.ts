// Vocabulary enforced by the build, not by review: noun-verb commands from one canonical verb
// list, no banned aliases, and every leaf carrying a complete contract.

import { describe, expect, it } from "vitest";
import { root } from "../src/app";
import { type CommandNode, GLOBAL_ARGS, walkLeaves } from "../src/command";
import { EXIT } from "../src/exit";

/** Verbs a group may expose. Adding one is a deliberate, reviewed change to this list. */
const VERBS = new Set([
  "get",
  "list",
  "create",
  "set",
  "use",
  "rename",
  "remove",
  "revoke",
  "cancel",
  "wait",
  "init",
  "preview",
  "compile",
  "install",
  "login",
  "logout",
]);

/** Sub-resources read with an implicit "get": `jobs logs <id>`, `jobs pdf <id>`, `auth status`, `auth token`. */
const LEAF_NOUNS = new Set(["logs", "pdf", "status", "token"]);

/** Top-level commands that are not nouns: the shorthand, the tooling, and read-only server info. */
const TOP_LEVEL_LEAVES = new Set(["compile", "doctor", "schema", "health", "limits", "stats"]);

const BANNED_COMMANDS = [
  "info",
  "ls",
  "rm",
  "show",
  "delete",
  "del",
  "new",
  "whoami",
  "describe",
  "add",
];
const BANNED_FLAGS = [
  "format",
  "output-format",
  "skip-confirmations",
  "no-confirm",
  "confirm",
  "yes-i-am-sure",
];

function allNames(node: CommandNode): string[] {
  if (node.kind === "leaf") return [node.name];
  return [node.name, ...Object.values(node.commands).flatMap(allNames)];
}

describe("command vocabulary", () => {
  it("never uses banned command names", () => {
    const names = allNames(root);
    for (const banned of BANNED_COMMANDS) expect(names, banned).not.toContain(banned);
  });

  it("is noun-verb: groups are nouns, their leaves come from the canonical verb list", () => {
    for (const [name, child] of Object.entries(root.commands)) {
      if (child.kind === "leaf") {
        expect(
          TOP_LEVEL_LEAVES.has(name),
          `top-level leaf "${name}" must be a group (noun verb)`,
        ).toBe(true);
        continue;
      }
      expect(VERBS.has(name), `group "${name}" looks like a verb`).toBe(false);
      for (const verb of Object.keys(child.commands)) {
        expect(
          VERBS.has(verb) || LEAF_NOUNS.has(verb),
          `"${name} ${verb}" is not a canonical verb`,
        ).toBe(true);
      }
    }
  });

  it("keeps the documented command tree", () => {
    expect(walkLeaves(root).map(({ path }) => path.join(" "))).toEqual([
      "compile",
      "auth login",
      "auth status",
      "auth logout",
      "auth token",
      "token list",
      "token create",
      "token revoke",
      "profile list",
      "profile get",
      "profile use",
      "profile set",
      "profile rename",
      "profile remove",
      "jobs create",
      "jobs get",
      "jobs list",
      "jobs wait",
      "jobs logs",
      "jobs cancel",
      "jobs pdf",
      "templates list",
      "templates get",
      "templates init",
      "templates preview",
      "templates compile",
      "skill get",
      "skill install",
      "doctor",
      "schema",
      "health",
      "limits",
      "stats",
    ]);
  });

  it("uses kebab-case flags, keeps --json for output only and bans confirmation aliases", () => {
    for (const { path, command } of walkLeaves(root)) {
      for (const [flag, def] of Object.entries(command.args)) {
        const where = `${path.join(" ")} --${flag}`;
        expect(flag, where).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(BANNED_FLAGS, where).not.toContain(flag);
        expect(flag in GLOBAL_ARGS, `${where} shadows a global flag`).toBe(false);
        if (def.type !== "positional")
          expect(flag.startsWith("no-"), `${where}: use default:true + --no-`).toBe(false);
      }
    }
  });

  it("gives every leaf a complete contract; destructive commands are gated", () => {
    const exits = new Set<number>(Object.values(EXIT));
    for (const { path, command } of walkLeaves(root)) {
      const name = path.join(" ");
      const c = command.contract;
      expect(c.exitCodes[0], name).toBe(EXIT.OK);
      for (const code of c.exitCodes) expect(exits.has(code), `${name}: exit ${code}`).toBe(true);
      expect(c.data.type, name).toBe("object");
      expect(command.description.length, name).toBeGreaterThan(10);
      expect(command.examples.length, `${name} needs an example`).toBeGreaterThan(0);
      if (c.effect === "destructive" && name !== "auth logout") {
        expect(Object.keys(command.args), name).toEqual(expect.arrayContaining(["yes", "dry-run"]));
      }
    }
  });
});
