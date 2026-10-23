#!/usr/bin/env node
import { run } from "./app";

run().then(
  (code) => {
    // Let pending stdout writes flush before exiting (piped output can be asynchronous).
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`latex-api: unexpected failure: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
