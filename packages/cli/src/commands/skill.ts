import { rt } from "../blocks/runtime";
import { colors } from "../blocks/style";
import { group, leaf, t } from "../command";
import { EXIT } from "../exit";
import { log, out } from "../output";
import { installSkill, planInstall, readBundledSkill, SKILL_TARGETS } from "../skill";
import { CLI_VERSION } from "../version";

const getCommand = leaf({
  name: "get",
  description: "Print the agent skill (SKILL.md) bundled with this exact CLI version",
  contract: {
    data: t.object({
      name: t.string(),
      version: t.string(),
      description: t.string(),
      content: t.string("The full SKILL.md"),
    }),
    exitCodes: [EXIT.OK, EXIT.COMPILE_FAILED],
    auth: "none",
    effect: "read",
    output: "raw",
    notes: "Prints the Markdown itself, even when piped; --json wraps it in the envelope.",
  },
  examples: ["latex-api skill get > SKILL.md", "latex-api skill get --json | jq -r .data.version"],
  async run() {
    const skill = readBundledSkill();
    if (skill.version !== CLI_VERSION) {
      log.warn(`Bundled skill is v${skill.version} but the CLI is v${CLI_VERSION}.`);
    }
    return {
      data: {
        name: skill.name,
        version: skill.version,
        description: skill.description,
        content: skill.content,
      },
      raw: skill.content.replace(/\n$/, ""),
    };
  },
});

const installCommand = leaf({
  name: "install",
  description:
    "Write the bundled skill where an agent reads it (Claude Code, .agents, Cursor rules, or a directory)",
  args: {
    target: {
      type: "string",
      description: `${SKILL_TARGETS.join(", ")} or a directory (default: claude)`,
      valueHint: "claude|agents|cursor|dir",
    },
    global: {
      type: "boolean",
      description: "Install for your user (default for claude: ~/.claude/skills)",
    },
    project: {
      type: "boolean",
      description: "Install into the current directory (default for agents and cursor)",
    },
    force: { type: "boolean", description: "Replace a different or edited copy" },
  },
  contract: {
    data: t.object({
      target: t.string(),
      scope: t.enum(["global", "project", "directory"]),
      path: t.string(),
      version: t.string("The version written (equals the CLI version)"),
      previousVersion: t.nullable(t.string()),
      status: t.enum(["installed", "updated", "unchanged"]),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.CONFLICT],
    auth: "none",
    effect: "write",
    notes:
      "claude → ~/.claude/skills/latex-api/SKILL.md (--project: ./.claude/skills/...); agents → ./.agents/skills/latex-api/SKILL.md (--global: ~/.agents/...); cursor → ./.cursor/rules/latex-api.mdc; <dir> → <dir>/latex-api/SKILL.md. An existing different copy is a conflict (exit 5) unless --force.",
  },
  examples: [
    "latex-api skill install",
    "latex-api skill install --target agents --project",
    "latex-api skill install --target cursor",
  ],
  async run({ args }) {
    const skill = readBundledSkill();
    const plan = planInstall(String(args.target ?? "claude"), {
      global: args.global,
      project: args.project,
    });
    const result = installSkill(skill, plan, Boolean(args.force));
    return {
      data: result,
      human: (d) => {
        const c = colors(rt().stdout);
        const verb =
          d.status === "unchanged"
            ? "Already installed"
            : d.status === "updated"
              ? `Updated (was ${d.previousVersion ?? "unversioned"})`
              : "Installed";
        out(`${c.ok("✔")} ${verb}: latex-api skill ${c.bold(`v${d.version}`)}`);
        out(`  ${c.muted(d.path)}`);
      },
    };
  },
});

export const skillGroup = group({
  name: "skill",
  description: "The agent skill for this CLI version (print it or install it for your agent)",
  commands: [getCommand, installCommand],
});
