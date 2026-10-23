// The color path never runs under a test runner (no TTY), so these tests fake a terminal and
// force color to check what a person sees: alignment by visible width, stdout/stderr split,
// NO_COLOR, and that machine mode never carries escapes.

import { describe, expect, it } from "vitest";
import { bannerLines } from "../src/blocks/banner";
import { setRuntime } from "../src/blocks/runtime";
import { colors, padVisible, stripAnsi, truncateVisible, visibleWidth } from "../src/blocks/style";
import { renderTable } from "../src/ui";
import { json, ME, runCli, stubFetch, TOKEN, tempHome } from "./helpers";

// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting ANSI is the point
const ESC = /\u001b\[/;

describe("visible width helpers", () => {
  it("measure and pad styled text by what is on screen", () => {
    const styled = "\u001b[1mHi\u001b[22m";
    expect(styled.length).toBe(11);
    expect(visibleWidth(styled)).toBe(2);
    expect(visibleWidth(padVisible(styled, 6))).toBe(6);
    expect(truncateVisible("abcdefgh", 5)).toBe("abcd…");
    expect(truncateVisible(styled, 5)).toBe(styled);
  });

  it("aligns table columns when cells carry escapes", () => {
    setRuntime({ stdout: { isTTY: true, write: () => true }, env: { FORCE_COLOR: "1" } });
    const c = colors();
    expect(c.enabled).toBe(true);
    const table = renderTable(
      ["name", "status"],
      [
        [c.bold("a"), c.ok("active")],
        ["longer-name", c.danger("revoked")],
      ],
    );
    expect(ESC.test(table)).toBe(true);
    const lines = table.split("\n").map(stripAnsi);
    const statusColumn = lines.map((line) => line.indexOf(line.trim().split(/\s{2,}/)[1] ?? ""));
    expect(new Set(statusColumn).size).toBe(1);
    setRuntime();
  });

  it("disables color for NO_COLOR even on a terminal", () => {
    setRuntime({
      stdout: { isTTY: true, write: () => true },
      env: { NO_COLOR: "1", FORCE_COLOR: "1" },
    });
    expect(colors().enabled).toBe(false);
    expect(colors().danger("x")).toBe("x");
    setRuntime();
  });

  it("renders the banner wordmark in five rows", () => {
    expect(bannerLines("LATEX API")).toHaveLength(5);
  });
});

describe("streams", () => {
  const routes = {
    "GET /v1/me": () => json(ME),
    "GET /v1/tokens": () => json({ tokens: [TOKEN] }),
  };

  it("machine mode: one JSON line on stdout, no ANSI even with FORCE_COLOR", async () => {
    const home = await tempHome();
    const result = await runCli(["token", "list"], {
      home,
      env: { LATEX_API_TOKEN: "t", FORCE_COLOR: "1" },
      fetch: stubFetch(routes).fetch,
    });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(ESC.test(result.stdout)).toBe(false);
  });

  it("human mode on a terminal: data on stdout, colors only when allowed, next steps on stderr", async () => {
    const home = await tempHome();
    const colored = await runCli(["token", "list"], {
      home,
      tty: true,
      env: { LATEX_API_TOKEN: "t", FORCE_COLOR: "1", CI: undefined },
      fetch: stubFetch(routes).fetch,
    });
    expect(colored.code).toBe(0);
    expect(colored.stdout).toContain("lta_Ab12Cd34");
    expect(ESC.test(colored.stdout)).toBe(true);
    expect(colored.stdout.startsWith("{")).toBe(false);
    expect(colored.stderr).toContain("next:");

    const plain = await runCli(["token", "list"], {
      home,
      tty: true,
      env: { LATEX_API_TOKEN: "t", NO_COLOR: "1" },
      fetch: stubFetch(routes).fetch,
    });
    expect(ESC.test(plain.stdout)).toBe(false);
    expect(stripAnsi(colored.stdout)).toBe(plain.stdout);
  });

  it("--json on a terminal still prints the envelope", async () => {
    const home = await tempHome();
    const result = await runCli(["profile", "list", "--json"], { home, tty: true });
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it("errors in human mode go to stderr with a hint; stdout stays empty", async () => {
    const home = await tempHome();
    const result = await runCli(["auth", "status"], { home, tty: true, env: { NO_COLOR: "1" } });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("✖ error [not_authenticated]");
    expect(result.stderr).toContain("hint: Run `latex-api auth login`");
  });

  it("the banner is printed on stderr only, and only for a terminal", async () => {
    const home = await tempHome();
    const tty = await runCli([], { home, tty: true, env: { FORCE_COLOR: "1" } });
    expect(tty.stderr).toContain("█");
    expect(tty.stdout).not.toContain("█");
    expect(tty.stdout).toContain("USAGE");
    const piped = await runCli([], { home });
    expect(piped.stderr).not.toContain("█");
  });

  it("--help is plain text without escapes when piped", async () => {
    const home = await tempHome();
    const help = await runCli(["token", "create", "--help"], { home });
    expect(help.code).toBe(0);
    expect(ESC.test(help.stdout)).toBe(false);
    expect(help.stdout).toContain("--no-expiry");
    expect(help.stdout).toContain("EXIT CODES");
  });
});
