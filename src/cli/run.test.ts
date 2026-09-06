import { beforeEach, describe, expect, test } from 'bun:test';
import { COMMANDS } from './commands.ts';
import { EXIT } from './exit-codes.ts';
import { type CliOutput, runCli } from './run.ts';

function makeOutput(): CliOutput & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];

  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}

describe('runCli', () => {
  let io: ReturnType<typeof makeOutput>;

  beforeEach(() => {
    io = makeOutput();
  });

  test.each([['--help'], ['-h'], ['help']])('prints help for %s and exits 0', (flag) => {
    const code = runCli([flag], io);

    expect(code).toBe(EXIT.OK);
    expect(io.err).toEqual([]);
    expect(io.out.join('\n')).toContain('USAGE');
  });

  test('prints help when invoked with no arguments', () => {
    const code = runCli([], io);

    expect(code).toBe(EXIT.OK);
    expect(io.out.join('\n')).toContain('COMMANDS');
  });

  test('help lists every registered command', () => {
    runCli(['--help'], io);
    const help = io.out.join('\n');

    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.usage);
    }
  });

  test.each([['--version'], ['-v']])('prints the version for %s', (flag) => {
    const code = runCli([flag], io);

    expect(code).toBe(EXIT.OK);
    expect(io.out.join('\n')).toMatch(/^webdiag \d+\.\d+\.\d+$/);
  });

  test('rejects an unknown command with the usage exit code', () => {
    const code = runCli(['definitely-not-a-command'], io);

    expect(code).toBe(EXIT.USAGE);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain("unknown command 'definitely-not-a-command'");
  });

  test('reports planned commands as not implemented instead of pretending to work', () => {
    const code = runCli(['scan', 'https://example.com'], io);

    expect(code).toBe(EXIT.NOT_IMPLEMENTED);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain('not implemented yet');
  });
});
