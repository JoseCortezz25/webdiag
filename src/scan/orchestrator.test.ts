import { describe, expect, test } from 'bun:test';
import { AXES, CATALOG_VERSION } from '../catalog/index.ts';
import type { ArtifactWriter, ScanRequest } from './orchestrator.ts';
import { runScan } from './orchestrator.ts';
import type { Probe } from './probe.ts';
import { RAW_SCHEMA_VERSION } from './raw.ts';
import { STUB_TOOL, stubProbes } from './stub-probe.ts';

function memoryWriter(): ArtifactWriter & { files: Map<string, string>; dirs: string[] } {
  const files = new Map<string, string>();
  const dirs: string[] = [];

  return {
    files,
    dirs,
    ensureDir: (path) => {
      dirs.push(path);
      return Promise.resolve();
    },
    writeFile: (path, contents) => {
      files.set(path, contents);
      return Promise.resolve();
    },
  };
}

const REQUEST: ScanRequest = {
  url: 'https://example.com',
  mode: 'quick',
  axes: AXES,
  pages: 1,
  out: '/out',
};

const FIXED_CLOCK = () => new Date('2026-09-06T12:00:00.000Z');

async function scan(overrides: Partial<ScanRequest> = {}, probes?: readonly Probe[]) {
  const writer = memoryWriter();
  const result = await runScan(
    { ...REQUEST, ...overrides },
    { writer, clock: FIXED_CLOCK, ...(probes === undefined ? {} : { probes }) },
  );

  return { writer, result };
}

describe('runScan', () => {
  test('writes the five artifacts the CLI contract promises', async () => {
    const { writer } = await scan();
    const written = [...writer.files.keys()];

    expect(writer.dirs).toContain('/out/raw');
    expect(written).toContain('/out/findings.json');
    expect(written).toContain('/out/summary.json');
    expect(written).toContain('/out/meta.json');
    expect(written).toContain('/out/report.html');
    expect(written.filter((path) => path.startsWith('/out/raw/'))).toHaveLength(AXES.length);
  });

  test('writes one raw document per axis in the intermediate format', async () => {
    const { writer } = await scan();
    const raw = JSON.parse(writer.files.get('/out/raw/PERF.json') ?? '{}');

    expect(raw.schema).toBe(RAW_SCHEMA_VERSION);
    expect(raw.axis).toBe('PERF');
    expect(raw.tool).toEqual(STUB_TOOL);
  });

  test('two consecutive runs produce an identical findings.json', async () => {
    const first = await scan();
    const second = await scan();

    expect(second.writer.files.get('/out/findings.json')).toBe(
      first.writer.files.get('/out/findings.json') ?? '',
    );
  });

  test('findings.json does not depend on the order the probes are registered', async () => {
    const forwards = await scan();
    const backwards = await scan({}, [...stubProbes()].reverse());

    expect(backwards.writer.files.get('/out/findings.json')).toBe(
      forwards.writer.files.get('/out/findings.json') ?? '',
    );
  });

  test('scores every axis independently and publishes no composite', async () => {
    const { result, writer } = await scan();
    const summary = JSON.parse(writer.files.get('/out/summary.json') ?? '{}');

    expect(result.summary.byAxis.map((axis) => axis.axis)).toEqual([...AXES]);
    expect(summary.scoring).toEqual({
      model: 'independent-per-axis',
      maxAxisScore: 100,
      composite: null,
    });
    expect(Object.keys(summary)).not.toContain('score');
  });

  test('a blocking critical zeroes its own axis and no other', async () => {
    const { result } = await scan();
    const byAxis = new Map(result.summary.byAxis.map((axis) => [axis.axis, axis]));

    expect(byAxis.get('SEO')?.score).toBe(0);
    expect(byAxis.get('SEO')?.zeroed).toBe(true);
    expect(byAxis.get('SEO')?.zeroedBy).toEqual(['SEO-NOINDEX-UNINTENDED']);
    expect(byAxis.get('SEC')?.score).toBeGreaterThan(0);
    expect(byAxis.get('PERF')?.score).toBeGreaterThan(0);
    expect(result.summary.coverPage.map((finding) => finding.id)).toEqual([
      'SEO-NOINDEX-UNINTENDED',
    ]);
  });

  test('low-confidence findings are listed but never deducted', async () => {
    const { result } = await scan();
    const deps = result.summary.byAxis.find((axis) => axis.axis === 'DEPS');

    expect(deps?.lowConfidence.map((finding) => finding.id)).toEqual(['DEPS-VULN-HIGH']);
    expect(deps?.deductions.map((deduction) => deduction.id)).not.toContain('DEPS-VULN-HIGH');
    expect(result.summary.lowConfidence.map((finding) => finding.id)).toEqual(['DEPS-VULN-HIGH']);
  });

  test('a shared finding is scored once and only mentioned in the other axis', async () => {
    const { result } = await scan();
    const sec = result.summary.byAxis.find((axis) => axis.axis === 'SEC');
    const deps = result.summary.byAxis.find((axis) => axis.axis === 'DEPS');

    expect(sec?.mentions.map((finding) => finding.id)).toContain('DEPS-SOURCEMAP-EXPOSED');
    expect(sec?.deductions.map((deduction) => deduction.id)).not.toContain(
      'DEPS-SOURCEMAP-EXPOSED',
    );
    expect(deps?.deductions.map((deduction) => deduction.id)).toContain('DEPS-SOURCEMAP-EXPOSED');
  });

  test('meta.json records the catalog version and every tool version', async () => {
    const { writer } = await scan();
    const meta = JSON.parse(writer.files.get('/out/meta.json') ?? '{}');

    expect(meta.catalogVersion).toBe(CATALOG_VERSION);
    expect(meta.tools).toHaveLength(AXES.length);
    for (const tool of meta.tools) {
      expect(tool.name).toBe(STUB_TOOL.name);
      expect(tool.version).toBe(STUB_TOOL.version);
      expect(tool.status).toBe('ok');
    }
  });

  test('a failing probe narrows the run instead of ending it', async () => {
    const broken: Probe = {
      axis: 'SEC',
      tool: { name: 'broken', version: '0.0.0' },
      run: () => Promise.reject(new Error('testssl.sh not on PATH')),
    };
    const probes = [...stubProbes().filter((probe) => probe.axis !== 'SEC'), broken];

    const { result, writer } = await scan({}, probes);
    const sec = result.summary.byAxis.find((axis) => axis.axis === 'SEC');

    expect(sec?.probe.status).toBe('failed');
    expect(sec?.probe.error).toContain('testssl.sh not on PATH');
    expect(writer.files.has('/out/raw/SEC.json')).toBe(false);
    expect(writer.files.has('/out/report.html')).toBe(true);
    expect(result.summary.byAxis).toHaveLength(AXES.length);
  });

  test('--axes narrows what is evaluated and says what it skipped', async () => {
    const { result } = await scan({ axes: ['PERF', 'SEO'] });

    expect(result.summary.axesEvaluated).toEqual(['PERF', 'SEO']);
    expect(result.summary.axesSkipped).toEqual(['A11Y', 'DEPS', 'SEC', 'AGENT']);
    expect(result.summary.byAxis).toHaveLength(2);
  });

  test('every artifact ends in a newline so the files stay diffable', async () => {
    const { writer } = await scan();

    for (const contents of writer.files.values()) {
      expect(contents.endsWith('\n')).toBe(true);
    }
  });
});
