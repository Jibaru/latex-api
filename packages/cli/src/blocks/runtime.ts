// Process-wide I/O seams. `run()` installs real streams; tests install fakes so the whole
// command path (parsing, envelope, exit code) runs in-process without spawning a binary.

export interface OutStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export type InStream = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export interface Runtime {
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
  env: Record<string, string | undefined>;
  /** Injected into every SDK client (tests stub the network here). */
  fetch: typeof fetch | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function defaults(): Runtime {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin as InStream,
    env: process.env,
    fetch: undefined,
    sleep: realSleep,
    now: () => Date.now(),
  };
}

let current: Runtime = defaults();

export function rt(): Runtime {
  return current;
}

export function setRuntime(overrides: Partial<Runtime> = {}): Runtime {
  current = { ...defaults(), ...overrides };
  return current;
}
