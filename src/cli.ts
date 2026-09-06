#!/usr/bin/env bun
import { runCli } from './cli/run.ts';

const exitCode = runCli(Bun.argv.slice(2), {
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
});

process.exit(exitCode);
