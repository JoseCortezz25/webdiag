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
 * Keeps `runCli` off the real filesystem *and* off the network while still
 * exercising the dispatch. The default probe set launches Chrome (spec §8,
 * phase 1); a CLI test asserts routing, not accessibility.
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

  test('rejects a scan invocation without a URL', async () => {
    const code = await runCli(['scan'], io, { writer: memoryWriter(), probes: stubProbes() });

    expect(code).toBe(EXIT.USAGE);
    expect(io.err.join('\n')).toContain('scan requires a URL');
  });

  test('reports a per-axis score line and never a composite one', async () => {
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
