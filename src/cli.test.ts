import { describe, expect, test } from 'bun:test';
import { EXIT } from './cli/exit-codes.ts';

const ENTRYPOINT = new URL('./cli.ts', import.meta.url).pathname;

async function runProcess(args: string[]) {
  const proc = Bun.spawn(['bun', 'run', ENTRYPOINT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe('webdiag executable', () => {
  test('--help prints the CLI interface and exits 0', async () => {
    const { stdout, stderr, exitCode } = await runProcess(['--help']);

    expect(exitCode).toBe(EXIT.OK);
    expect(stderr).toBe('');
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('webdiag <command> [options]');
    expect(stdout).toContain('scan');
  });

  test('an unknown command exits non-zero and writes to stderr', async () => {
    const { stdout, stderr, exitCode } = await runProcess(['nope']);

    expect(exitCode).toBe(EXIT.USAGE);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown command');
  });
});
