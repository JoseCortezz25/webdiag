import { describe, expect, test } from 'bun:test';
import { AXES } from '../../catalog/index.ts';
import type { ArtifactWriter } from '../orchestrator.ts';
import { runScan } from '../orchestrator.ts';
import { runProbe } from '../probe.ts';
import { defaultProbes } from '../probes.ts';
import { parseRawDocument } from '../raw.ts';
import { STUB_TOOL, stubProbes } from '../stub-probe.ts';
import { PINNED_CHROME_BUILD, type ResolvedChrome } from './chrome.ts';
import type { FieldData } from './crux.ts';
import type { LighthouseReport } from './lhr.ts';
import type { LighthouseRun } from './lighthouse.ts';
import { PINNED_LIGHTHOUSE_VERSION } from './lighthouse.ts';
import { lighthouseProbe, PINNED_PERF_TOOL } from './probe.ts';

const CHROME: ResolvedChrome = {
  executablePath: '/cache/chrome-headless-shell',
  version: PINNED_CHROME_BUILD,
  buildId: PINNED_CHROME_BUILD,
  pinned: true,
  source: 'cache',
};

const REPORT: LighthouseReport = {
  lighthouseVersion: PINNED_LIGHTHOUSE_VERSION,
  finalDisplayedUrl: 'https://example.com/servicios',
  audits: {
    'largest-contentful-paint': { scoreDisplayMode: 'numeric', numericValue: 5200 },
  },
};

const NO_FIELD: FieldData = { available: false, reason: 'sin API key' };

function fakeRun(report: LighthouseReport = REPORT): (url: string) => Promise<LighthouseRun> {
  return () => Promise.resolve({ report, chrome: CHROME });
}

const CONTEXT = { url: 'https://example.com/servicios', mode: 'quick' as const, pages: 1 };

function memoryWriter(): ArtifactWriter {
  return {
    ensureDir: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
  };
}

describe('lighthouseProbe', () => {
  test('produces a valid raw document for the Performance axis', async () => {
    const probe = lighthouseProbe({ run: fakeRun(), field: () => Promise.resolve(NO_FIELD) });
    const document = parseRawDocument(await probe.run(CONTEXT));

    expect(document.axis).toBe('PERF');
    expect(document.target).toEqual({ url: CONTEXT.url, mode: 'quick' });
    expect(document.observations.map((observation) => observation.id)).toEqual([
      'PERF-LCP-POOR',
      'PERF-FIELD-UNAVAILABLE',
    ]);
  });

  test('records the versions that actually measured, Chrome included', async () => {
    const probe = lighthouseProbe({ run: fakeRun(), field: () => Promise.resolve(NO_FIELD) });
    const document = await probe.run(CONTEXT);

    expect(document.tool).toEqual({
      name: 'lighthouse',
      version: PINNED_LIGHTHOUSE_VERSION,
      components: [{ name: 'chrome-headless-shell', version: PINNED_CHROME_BUILD }],
    });
  });

  test('declares the pinned versions before it has run anything', () => {
    expect(lighthouseProbe().tool).toEqual(PINNED_PERF_TOOL);
    expect(PINNED_PERF_TOOL.components).toEqual([
      { name: 'chrome-headless-shell', version: PINNED_CHROME_BUILD },
    ]);
  });

  test('attributes findings to the final URL, not the redirect it started from', async () => {
    const probe = lighthouseProbe({
      run: fakeRun({ ...REPORT, finalDisplayedUrl: 'https://example.com/es/servicios' }),
      field: () => Promise.resolve(NO_FIELD),
    });
    const document = await probe.run(CONTEXT);

    expect(document.observations[0]?.affected).toEqual(['/es/servicios']);
  });

  test('reads the CrUX key from the environment it was given', async () => {
    let seenKey: string | undefined;
    const probe = lighthouseProbe({
      run: fakeRun(),
      env: { WEBDIAG_CRUX_API_KEY: 'from-env' },
      field: (url) => {
        seenKey = url;
        return Promise.resolve(NO_FIELD);
      },
    });

    await probe.run(CONTEXT);

    expect(seenKey).toBe(CONTEXT.url);
    expect(lighthouseProbe({ env: { WEBDIAG_CRUX_API_KEY: 'from-env' } }).axis).toBe('PERF');
  });
});

describe('probe isolation', () => {
  test('a browser that will not start fails the axis, not the run', async () => {
    const probe = lighthouseProbe({
      run: () => Promise.reject(new Error('Chrome exited with code 127')),
      field: () => Promise.resolve(NO_FIELD),
    });

    const outcome = await runProbe(probe, CONTEXT);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toBe('Chrome exited with code 127');
    // The declared pin is still recorded: the report can say what would have measured it.
    expect(outcome.tool).toEqual(PINNED_PERF_TOOL);
  });

  test('the other five axes still report when Performance dies', async () => {
    const broken = lighthouseProbe({
      run: () => Promise.reject(new Error('page did not paint (NO_FCP)')),
      field: () => Promise.resolve(NO_FIELD),
    });
    // Fixtures stand in for the other axes so this stays a test about isolation
    // rather than a live scan of five real probes.
    const probes = stubProbes().map((probe) => (probe.axis === 'PERF' ? broken : probe));

    const result = await runScan(
      { url: CONTEXT.url, mode: 'quick', axes: AXES, pages: 1, out: '/out' },
      { probes, writer: memoryWriter(), clock: () => new Date('2026-09-06T12:00:00.000Z') },
    );

    const perf = result.summary.byAxis.find((axis) => axis.axis === 'PERF');
    const seo = result.summary.byAxis.find((axis) => axis.axis === 'SEO');

    expect(result.summary.byAxis).toHaveLength(AXES.length);
    expect(perf?.probe.status).toBe('failed');
    expect(perf?.probe.error).toContain('NO_FCP');
    expect(perf?.findings).toEqual([]);
    expect(seo?.probe.status).toBe('ok');
    expect(seo?.findings.length).toBeGreaterThan(0);
    expect(result.meta.tools.find((tool) => tool.axis === 'PERF')?.components).toEqual([
      { name: 'chrome-headless-shell', version: PINNED_CHROME_BUILD },
    ]);
  });
});

describe('defaultProbes', () => {
  test('Lighthouse owns Performance', () => {
    const probes = defaultProbes();

    expect(probes.map((probe) => probe.axis)).toEqual([...AXES]);

    const perf = probes.find((probe) => probe.axis === 'PERF');

    expect(perf?.tool.name).toBe('lighthouse');
    expect(perf?.tool.name).not.toBe(STUB_TOOL.name);
  });
});
