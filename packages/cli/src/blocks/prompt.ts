// Two interactive primitives, both of which refuse (return null) without a TTY so a piped
// or agent-driven run fails with a structured error instead of hanging.
//
// `promptSecret` is adapted from cligentic block `prompt-secret` (registry/agent/prompt-secret.ts):
// raw mode, one mask char per key, Ctrl-C rejects. Change: the prompt and mask go to stderr,
// not stdout, because stdout carries data (a token prompt on stdout would end up in a pipe).
//
// `confirm` is the interactive half of cligentic block `trust-ladder`'s `approveGate`
// (registry/agent/trust-ladder.ts): readline on stderr, default No. The non-interactive half
// (throw when there is no TTY or --json) lives in ../gate.ts with this CLI's error envelope.

import { createInterface } from "node:readline/promises";
import { rt } from "./runtime";

export function isInteractive(): boolean {
  const { stdin, stderr } = rt();
  return stdin.isTTY === true && stderr.isTTY === true;
}

export function promptSecret(label: string, mask = "•"): Promise<string | null> {
  const { stdin, stderr } = rt();
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
    return Promise.resolve(null);
  }
  const setRaw = stdin.setRawMode.bind(stdin);
  stderr.write(label);
  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    setRaw(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      setRaw(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n" || code === 4) {
          stderr.write("\n");
          cleanup();
          resolve(chars.join(""));
          return;
        }
        if (code === 3) {
          stderr.write("\n");
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (code === 8 || code === 127) {
          if (chars.pop() !== undefined && mask) stderr.write("\b \b");
          continue;
        }
        if (code >= 32) {
          chars.push(ch);
          if (mask) stderr.write(mask);
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Asks a yes/no question on stderr. Resolves null when not interactive. Default: no. */
export async function confirm(question: string): Promise<boolean | null> {
  if (!isInteractive()) return null;
  const { stdin, stderr } = rt();
  const rl = createInterface({ input: stdin, output: stderr as NodeJS.WritableStream });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
