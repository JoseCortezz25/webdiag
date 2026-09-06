/**
 * Registry of the CLI surface.
 *
 * The scaffold ships the shape of the interface described in the spec, not its
 * behaviour: every command is `planned` until its own ticket lands. Keeping the
 * registry declarative means `--help` can never drift from what is dispatchable.
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
    status: 'planned',
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}
