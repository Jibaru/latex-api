#!/usr/bin/env node
import { run } from "./app";
import { reportError } from "./commands/compile";
import { EXIT, exitCodeFor } from "./exit";

process.on("unhandledRejection", (error) => {
  reportError(error, false);
  process.exit(exitCodeFor(error));
});

run().then(() => {
  if (process.exitCode && process.exitCode !== EXIT.OK) process.exit(process.exitCode);
});
