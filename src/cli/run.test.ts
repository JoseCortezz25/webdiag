import { beforeEach, describe, expect, test } from 'bun:test';
import { type ArtifactWriter, stubProbes } from '../scan/index.ts';
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

/**
 * Keeps `runCli` off the real filesystem while still exercising the dispatch.
 * Its counterpart is `probes: stubProbes()` below, which keeps it off the
 * network: the default registry launches Chrome and shells out to external
 * binaries, and these tests are about argument dispatch, not about what a live
 * host answered.
 */
function memoryWriter(): ArtifactWriter & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    ensureDir: () => Promise.resolve(),
    writeFile: (path, contents) => {
      files.set(path, contents);
      return Promise.resolve();
    },
  };
}

describe('runCli', () => {
  let io: ReturnType<typeof makeOutput>;

  beforeEach(() => {
    io = makeOutput();
  });

  test.each([['--help'], ['-h'], ['help']])('prints help for %s and exits 0', async (flag) => {
    const code = await runCli([flag], io);

    expect(code).toBe(EXIT.OK);
    expect(io.err).toEqual([]);
    expect(io.out.join('\n')).toContain('USAGE');
  });

  test('prints help when invoked with no arguments', async () => {
    const code = await runCli([], io);

    expect(code).toBe(EXIT.OK);
    expect(io.out.join('\n')).toContain('COMMANDS');
  });

  test('help lists every registered command', async () => {
    await runCli(['--help'], io);
    const help = io.out.join('\n');

    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.usage);
    }
  });

  test.each([['--version'], ['-v']])('prints the version for %s', async (flag) => {
    const code = await runCli([flag], io);

    expect(code).toBe(EXIT.OK);
    expect(io.out.join('\n')).toMatch(/^webdiag \d+\.\d+\.\d+$/);
  });

  test('rejects an unknown command with the usage exit code', async () => {
    const code = await runCli(['definitely-not-a-command'], io);

    expect(code).toBe(EXIT.USAGE);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain("unknown command 'definitely-not-a-command'");
  });

  test('dispatches scan and reports every artifact it wrote', async () => {
    const writer = memoryWriter();
    const code = await runCli(['scan', 'https://example.com', '--out', '/tmp/x'], io, {
      writer,
      probes: stubProbes(),
    });

    expect(code).toBe(EXIT.OK);
    expect([...writer.files.keys()]).toContain('/tmp/x/findings.json');
    expect(io.out.join('\n')).toContain('/tmp/x/report.html');
  });

  test('scan without --fail-on exits 0 even with a blocking finding in the fixture', async () => {
    // The stub fixture's SEO-NOINDEX-UNINTENDED is a blocking critical (see
    // stub-probe.ts). A budget is opt-in, so this must stay green either way.
    const code = await runCli(['scan', 'https://example.com', '--out', '/tmp/x'], io, {
      writer: memoryWriter(),
      probes: stubProbes(),
    });

    expect(code).toBe(EXIT.OK);
  });

  test('--fail-on fails the build on the fixture blocking finding', async () => {
    const code = await runCli(
      ['scan', 'https://example.com', '--out', '/tmp/x', '--fail-on', 'critical'],
      io,
      { writer: memoryWriter(), probes: stubProbes() },
    );

    expect(code).toBe(EXIT.BUDGET_EXCEEDED);
    expect(io.err.join('\n')).toContain('SEO-NOINDEX-UNINTENDED (critical, blocking)');
  });

  test('--fail-on above every finding severity still exits 0', async () => {
    // Nothing in the fixture reaches critical except the blocking finding
    // already covered above; --fail-on critical without a blocking finding
    // would pass, so this asserts the threshold itself is respected using a
    // subset of axes the fixture keeps under `high`.
    const code = await runCli(
      ['scan', 'https://example.com', '--out', '/tmp/x', '--axes', 'SEC', '--fail-on', 'critical'],
      io,
      { writer: memoryWriter(), probes: stubProbes() },
    );

    expect(code).toBe(EXIT.OK);
  });

  test('rejects a scan invocation without a URL', async () => {
    const code = await runCli(['scan'], io, { writer: memoryWriter(), probes: stubProbes() });

    expect(code).toBe(EXIT.USAGE);
    expect(io.err.join('\n')).toContain('scan requires a URL');
  });

  test('reports a per-axis score line and never a composite one', async () => {
    // The fixture probes keep this test about the CLI's output format. The real
    // SEO probe would reach the network and score whatever it found there.
    await runCli(['scan', 'https://example.com', '--out', '/tmp/x'], io, {
      writer: memoryWriter(),
      probes: stubProbes(),
    });
    const stdout = io.out.join('\n');

    expect(stdout).toContain('PERF');
    expect(stdout).toContain('SEO     0/100');
    expect(stdout).not.toMatch(/overall|global|total score/i);
  });
});
