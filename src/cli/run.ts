import type { ScanOptions } from '../scan/index.ts';
import { PROGRAM_NAME } from '../version.ts';
import { findCommand } from './commands.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';
import { renderHelp, renderVersion } from './help.ts';
import { runScanCommand } from './scan-command.ts';

/**
 * Where the CLI writes. Injected so the whole surface is testable without
 * spawning a process or capturing global stdout.
 */
export type CliOutput = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

const HELP_FLAGS = new Set(['-h', '--help', 'help']);
const VERSION_FLAGS = new Set(['-v', '--version', 'version']);

export async function runCli(
  argv: readonly string[],
  out: CliOutput,
  options: ScanOptions = {},
): Promise<ExitCode> {
  const [first, ...rest] = argv;

  if (first === undefined || HELP_FLAGS.has(first)) {
    out.stdout(renderHelp());
    return EXIT.OK;
  }

  if (VERSION_FLAGS.has(first)) {
    out.stdout(renderVersion());
    return EXIT.OK;
  }

  const command = findCommand(first);

  if (command === undefined) {
    out.stderr(`${PROGRAM_NAME}: unknown command '${first}'`);
    out.stderr(`Run '${PROGRAM_NAME} --help' to see the available commands.`);
    return EXIT.USAGE;
  }

  if (command.name === 'scan') {
    return runScanCommand(command, rest, out, options);
  }

  out.stderr(`${PROGRAM_NAME}: '${command.name}' is not implemented yet.`);
  out.stderr(`Planned interface: ${command.usage}`);
  return EXIT.NOT_IMPLEMENTED;
}
