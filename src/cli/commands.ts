/**
 * Registry of the CLI surface.
 *
 * A command is `planned` until its own ticket lands, and `available` once it is
 * dispatchable. Keeping the registry declarative means `--help` can never drift
 * from what actually runs.
 */

export type CommandStatus = 'planned' | 'available';

export type Command = {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly status: CommandStatus;
};

export const COMMANDS: readonly Command[] = [
  {
    name: 'scan',
    usage:
      'webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR]',
    summary: 'Run a technical diagnostic over a URL and write the report artifacts.',
    status: 'available',
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}
