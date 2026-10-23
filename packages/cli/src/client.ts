import { LatexApi } from "@jibaru/latex-api-sdk";
import { consola } from "consola";
import { loadConfig, resolveSettings, type Settings } from "./config";
import { EXIT } from "./exit";

export const CLI_VERSION = "0.1.0";

export interface Session {
  api: LatexApi;
  settings: Settings;
}

/** Builds a client from env + config. Warns (once) when a key is needed but missing. */
export async function createSession(opts: { requireKey?: boolean } = {}): Promise<Session> {
  const settings = resolveSettings(await loadConfig());
  if (opts.requireKey && !settings.apiKey) {
    consola.error(
      "No API key configured. Run `latex-api login` or set LATEX_API_KEY (and LATEX_API_URL for self-hosted servers).",
    );
    process.exit(EXIT.NETWORK);
  }
  const api = new LatexApi({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    userAgent: `latex-api-cli/${CLI_VERSION}`,
  });
  return { api, settings };
}
