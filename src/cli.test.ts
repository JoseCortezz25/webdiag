import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
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

/**
 * The axes still served by the fixture.
 *
 * AGENT is left out on purpose: its probe is real, so including it would make
 * this suite require a working network and turn an outage into a red build. The
 * real axis is covered by `scan/agent/*.test.ts` (rules) and by the integration
 * test in `scan/orchestrator.test.ts` (wiring), and by running the CLI against a
 * live site, which is not something a unit suite should do on every commit.
 */
const FIXTURE_AXES = 'PERF,A11Y,SEO,DEPS,SEC';

describe('webdiag scan (end to end)', () => {
  const outDir = `${process.env.TMPDIR ?? '/tmp'}/webdiag-cli-e2e-${process.pid}`;

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  test('writes the five artifacts and repeats findings.json byte for byte', async () => {
    const first = await runProcess([
      'scan',
      'https://example.com',
      '--mode',
      'quick',
      '--axes',
      FIXTURE_AXES,
      '--out',
      outDir,
    ]);

    expect(first.exitCode).toBe(EXIT.OK);
    expect(first.stderr).toBe('');

    for (const artifact of ['findings.json', 'summary.json', 'meta.json', 'report.html']) {
      expect(await Bun.file(`${outDir}/${artifact}`).exists()).toBe(true);
    }
    expect(await Bun.file(`${outDir}/raw/PERF.json`).exists()).toBe(true);

    const findings = await Bun.file(`${outDir}/findings.json`).text();

    const second = await runProcess([
      'scan',
      'https://example.com',
      '--mode',
      'quick',
      '--axes',
      FIXTURE_AXES,
      '--out',
      outDir,
    ]);

    expect(second.exitCode).toBe(EXIT.OK);
    expect(await Bun.file(`${outDir}/findings.json`).text()).toBe(findings);
  });
});
