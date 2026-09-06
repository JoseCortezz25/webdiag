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
 * The end-to-end run targets a server this file starts, not a public site.
 *
 * The SEC probe is real from phase 1 on: it shells out to curl and testssl.sh
 * and reads whatever the host answers. Pointing this test at `example.com` would
 * make it assert that a third party's headers had not changed overnight — and
 * "findings.json is byte-for-byte reproducible" would then be a claim about
 * their deploy schedule rather than about this code.
 *
 * Serving over plain HTTP is part of the fixture: it exercises the probe's
 * "there is no TLS to inspect" path, which is a stated outcome and not a
 * failure. The TLS branch itself is covered by unit tests over captured
 * `testssl.sh` JSON.
 */
describe('webdiag scan (end to end)', () => {
  const outDir = `${process.env.TMPDIR ?? '/tmp'}/webdiag-cli-e2e-${process.pid}`;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === '/robots.txt') {
        return new Response('User-agent: *\nDisallow: /private/\n', {
          headers: { 'content-type': 'text/plain' },
        });
      }

      return new Response('<!doctype html><title>fixture</title>', {
        headers: {
          'content-type': 'text/html',
          server: 'fixture/1.2.3',
          'set-cookie': 'sid=abc; Path=/',
        },
      });
    },
  });

  const target = `http://127.0.0.1:${server.port}/`;

  afterAll(async () => {
    await server.stop(true);
    await rm(outDir, { recursive: true, force: true });
  });

  test('writes the five artifacts and repeats findings.json byte for byte', async () => {
    const first = await runProcess(['scan', target, '--mode', 'quick', '--out', outDir]);

    expect(first.exitCode).toBe(EXIT.OK);
    expect(first.stderr).toBe('');

    for (const artifact of ['findings.json', 'summary.json', 'meta.json', 'report.html']) {
      expect(await Bun.file(`${outDir}/${artifact}`).exists()).toBe(true);
    }
    expect(await Bun.file(`${outDir}/raw/PERF.json`).exists()).toBe(true);

    const findings = await Bun.file(`${outDir}/findings.json`).text();

    const second = await runProcess(['scan', target, '--mode', 'quick', '--out', outDir]);

    expect(second.exitCode).toBe(EXIT.OK);
    expect(await Bun.file(`${outDir}/findings.json`).text()).toBe(findings);
  });

  test('the SEC axis reports what it read off the real wire', async () => {
    await runProcess(['scan', target, '--mode', 'quick', '--out', outDir]);

    const raw = JSON.parse(await Bun.file(`${outDir}/raw/SEC.json`).text());
    const ids: string[] = raw.observations.map((observation: { id: string }) => observation.id);

    // Every header the fixture omits, plus the two it gets wrong on purpose.
    expect(ids).toContain('SEC-CSP-MISSING');
    expect(ids).toContain('SEC-XFO-MISSING');
    expect(ids).toContain('SEC-COOKIE-INSECURE');
    expect(ids).toContain('SEC-SERVER-VERSION-DISCLOSED');

    // Plain HTTP: the probe must decline these rather than guess at them.
    expect(ids).not.toContain('SEC-HSTS-MISSING');
    expect(raw.notes.join('\n')).toContain('no TLS to inspect');
    expect(raw.notes.join('\n')).toContain('robots.txt');
  });
});
