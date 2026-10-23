import { describe, expect, it } from "vitest";
import { main, resolveSubCommand } from "../src/app";

describe("command tree", () => {
  it("exposes every documented command", async () => {
    const subCommands = main.subCommands as Record<string, unknown>;
    expect(Object.keys(subCommands).sort()).toEqual([
      "compile",
      "health",
      "jobs",
      "limits",
      "login",
      "logout",
      "stats",
      "templates",
    ]);
    const jobs = await resolveSubCommand(main, ["jobs"]);
    expect(Object.keys(jobs.command.subCommands as Record<string, unknown>).sort()).toEqual([
      "cancel",
      "create",
      "get",
      "logs",
      "pdf",
      "wait",
    ]);
    const templates = await resolveSubCommand(main, ["templates"]);
    expect(Object.keys(templates.command.subCommands as Record<string, unknown>).sort()).toEqual([
      "compile",
      "init",
      "list",
      "preview",
    ]);
  });

  it("resolves the deepest sub-command for help and keeps the remaining args", async () => {
    const wait = await resolveSubCommand(main, ["jobs", "wait", "abc", "-o", "x.pdf", "--help"]);
    expect((wait.command.meta as { name: string }).name).toBe("wait");
    expect(wait.parent?.meta).toMatchObject({ name: "jobs" });
    expect(wait.rest).toEqual(["abc", "-o", "x.pdf", "--help"]);

    const unknown = await resolveSubCommand(main, ["jobs", "nope"]);
    expect((unknown.command.meta as { name: string }).name).toBe("jobs");
    expect(unknown.rest).toEqual(["nope"]);

    const root = await resolveSubCommand(main, ["--help"]);
    expect((root.command.meta as { name: string }).name).toBe("latex-api");
  });

  it("declares the compile flags from the contract", () => {
    const compile = (
      main.subCommands as Record<string, { args: Record<string, { type: string; alias?: string }> }>
    ).compile!;
    expect(Object.keys(compile.args).sort()).toEqual([
      "bibliography",
      "engine",
      "entrypoint",
      "force",
      "json",
      "open",
      "output",
      "path",
      "timeout",
      "watch",
      "with-siblings",
    ]);
    expect(compile.args.output!.alias).toBe("o");
    expect(compile.args.path!.type).toBe("positional");
  });
});
