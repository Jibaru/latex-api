import * as p from "@clack/prompts";
import { LatexApi, LatexApiError } from "@jibaru/latex-api-sdk";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";
import { CLI_VERSION } from "../client";
import {
  configPath,
  DEFAULT_BASE_URL,
  ENV_KEY,
  ENV_URL,
  loadConfig,
  normalizeBaseUrl,
  removeConfig,
  resolveSettings,
  saveConfig,
} from "../config";
import { CliError, EXIT } from "../exit";

function cancelled(): never {
  p.cancel("Login cancelled.");
  process.exit(EXIT.USAGE);
}

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Store the server URL and API key in the user config directory",
  },
  args: {
    url: { type: "string", description: `Base URL of the API (default ${DEFAULT_BASE_URL})` },
    key: { type: "string", description: "API key (prompted when omitted)" },
    "no-verify": { type: "boolean", description: "Skip calling the server to validate the key" },
  },
  async run({ args }) {
    const existing = await loadConfig();
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    let baseUrl = args.url;
    let apiKey = args.key;

    if ((!baseUrl || !apiKey) && !interactive) {
      throw new CliError(
        "Not a TTY: pass --url and --key (or set LATEX_API_URL / LATEX_API_KEY).",
        EXIT.USAGE,
      );
    }

    if (!baseUrl || !apiKey) p.intro(pc.bold(`latex-api login v${CLI_VERSION}`));
    if (!baseUrl) {
      const answer = await p.text({
        message: "API base URL",
        initialValue: existing.baseUrl ?? DEFAULT_BASE_URL,
        validate: (value) => {
          try {
            normalizeBaseUrl(value ?? "");
            return undefined;
          } catch {
            return "Enter a valid URL";
          }
        },
      });
      if (p.isCancel(answer)) cancelled();
      baseUrl = answer;
    }
    if (!apiKey) {
      const answer = await p.password({
        message: "API key",
        validate: (value) => (value?.trim() ? undefined : "The key cannot be empty"),
      });
      if (p.isCancel(answer)) cancelled();
      apiKey = answer;
    }

    baseUrl = normalizeBaseUrl(baseUrl);
    apiKey = apiKey.trim();

    if (!args["no-verify"]) {
      const spinner = interactive ? p.spinner() : undefined;
      spinner?.start(`Checking ${baseUrl}`);
      const api = new LatexApi({ baseUrl, apiKey, userAgent: `latex-api-cli/${CLI_VERSION}` });
      try {
        const limits = await api.limits();
        await api.stats();
        spinner?.stop(`Connected: ${limits.engines.join(", ")} available`);
      } catch (error) {
        spinner?.stop("Verification failed");
        if (error instanceof LatexApiError && error.status === 401) {
          throw new CliError(`The server rejected the API key (${error.message})`, EXIT.NETWORK);
        }
        if (error instanceof LatexApiError) {
          throw new CliError(`Could not reach ${baseUrl}: ${error.message}`, EXIT.NETWORK, {
            cause: error,
          });
        }
        throw error;
      }
    }

    const file = await saveConfig({ baseUrl, apiKey });
    const settings = resolveSettings({ baseUrl, apiKey });
    const notes: string[] = [`Saved to ${file}`];
    if (settings.sources.baseUrl === "env" || settings.sources.apiKey === "env") {
      notes.push(`Note: ${ENV_URL}/${ENV_KEY} are set and take precedence over the config file.`);
    }
    if (interactive) p.outro(notes.join("\n"));
    else consola.success(notes.join("\n"));
  },
});

export const logoutCommand = defineCommand({
  meta: { name: "logout", description: "Remove the stored credentials" },
  async run() {
    const removed = await removeConfig();
    if (removed) consola.success(`Removed ${configPath()}`);
    else consola.info(`Nothing to remove (${configPath()} does not exist)`);
    if (process.env[ENV_KEY]) {
      consola.warn(`${ENV_KEY} is still set in your environment.`);
    }
  },
});
