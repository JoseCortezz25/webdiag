import { describe, expect, test } from 'bun:test';
import { RAW_SCHEMA_VERSION, rawDocumentSchema } from '../raw.ts';
import { parsePerfDetail, perfDetail } from './detail.ts';
import type { LighthouseReport } from './lhr.ts';

function report(overrides: Partial<LighthouseReport> = {}): LighthouseReport {
  return {
    lighthouseVersion: '13.4.1',
    finalDisplayedUrl: 'https://example.com/',
    categories: { performance: { score: 0.46 } },
    audits: {},
    ...overrides,
  };
}

function richReport(): LighthouseReport {
  return report({
    audits: {
      'first-contentful-paint': { scoreDisplayMode: 'numeric', numericValue: 1200 },
      'largest-contentful-paint': { scoreDisplayMode: 'numeric', numericValue: 4120 },
      'speed-index': { scoreDisplayMode: 'numeric', numericValue: 3200 },
      'total-blocking-time': { scoreDisplayMode: 'numeric', numericValue: 890 },
      'cumulative-layout-shift': { scoreDisplayMode: 'numeric', numericValue: 0.06 },
      'server-response-time': { scoreDisplayMode: 'metricSavings', numericValue: 620 },
      'render-blocking-insight': {
        scoreDisplayMode: 'metricSavings',
        metricSavings: { FCP: 1600, LCP: 1600 },
        details: {
          type: 'table',
          items: [
            { url: 'https://example.com/style.css' },
            { url: 'https://example.com/modernizr.js' },
          ],
        },
      },
      'image-delivery-insight': {
        scoreDisplayMode: 'metricSavings',
        details: {
          type: 'table',
          items: [{ url: 'https://example.com/img/hero.png', wastedBytes: 1_884_160 }],
        },
      },
      'unsized-images': {
        scoreDisplayMode: 'metricSavings',
        details: { type: 'table', items: [{ url: 'https://example.com/img/logo.png' }] },
      },
      'dom-size': { scoreDisplayMode: 'numeric', numericValue: 1420 },
    },
  });
}

function findMetric(input: LighthouseReport, id: string) {
  return perfDetail(input).metrics.find((metric) => metric.id === id);
}

describe('perfDetail', () => {
  test('turns the Lighthouse score into a 0-100 value with its band', () => {
    const detail = perfDetail(richReport());

    expect(detail.score).toBe(46);
    expect(detail.scoreState).toBe('poor');
  });

  test('collects the score metrics in a stable order, plus TTFB', () => {
    const detail = perfDetail(richReport());

    expect(detail.metrics.map((metric) => metric.id)).toEqual([
      'FCP',
      'LCP',
      'SI',
      'TBT',
      'CLS',
      'TTFB',
    ]);
  });

  test('bands every metric by its threshold', () => {
    const detail = perfDetail(richReport());

    expect(detail.metrics.map((metric) => [metric.id, metric.state])).toEqual([
      ['FCP', 'good'],
      ['LCP', 'poor'],
      ['SI', 'good'],
      ['TBT', 'poor'],
      ['CLS', 'good'],
      ['TTFB', 'good'],
    ]);
  });

  test('uses the catalogue threshold as the good line for LCP, CLS and TBT', () => {
    const detail = perfDetail(
      report({
        audits: {
          'largest-contentful-paint': { scoreDisplayMode: 'numeric', numericValue: 2600 },
          'cumulative-layout-shift': { scoreDisplayMode: 'numeric', numericValue: 0.15 },
          'total-blocking-time': { scoreDisplayMode: 'numeric', numericValue: 300 },
        },
      }),
    );

    expect(detail.metrics.map((metric) => metric.state)).toEqual([
      'needs-improvement',
      'needs-improvement',
      'needs-improvement',
    ]);
  });

  test('marks TBT as a proxy and only the five metrics as score components', () => {
    const tbt = findMetric(richReport(), 'TBT');
    const ttfb = findMetric(richReport(), 'TTFB');

    expect(tbt?.composesScore).toBe(true);
    expect(String(tbt?.note)).toContain('Proxy');
    expect(ttfb?.composesScore).toBe(false);
    expect(String(ttfb?.note)).toContain('No compone');
  });

  test('formats milliseconds and unitless values for the reader', () => {
    expect(findMetric(richReport(), 'FCP')?.display).toBe('1.2 s');
    expect(findMetric(richReport(), 'TBT')?.display).toBe('890 ms');
    expect(findMetric(richReport(), 'CLS')?.display).toBe('0.06');
  });

  test('surfaces opportunities with their measured savings', () => {
    const detail = perfDetail(richReport());
    const titles = detail.opportunities.map((item) => item.title);

    expect(titles).toContain('Eliminar recursos que bloquean el render');
    expect(titles).toContain('Mejorar la entrega de imagenes');
    expect(detail.opportunities.find((item) => item.savingsMs === 1600)?.savingsMs).toBe(1600);
    expect(detail.opportunities.find((item) => item.savingsKb === 1840)?.savingsKb).toBe(1840);
  });

  test('surfaces diagnostics, including numeric ones', () => {
    const detail = perfDetail(richReport());

    expect(detail.diagnostics.map((item) => item.title)).toContain('Imagenes sin width/height');
    expect(detail.diagnostics.find((item) => item.title === 'Tamano del DOM')?.detail).toBe(
      '1420 elementos',
    );
  });

  test('omits a metric whose audit errored or never ran, without throwing', () => {
    const detail = perfDetail(
      report({
        audits: {
          'largest-contentful-paint': { scoreDisplayMode: 'error', score: null },
        },
      }),
    );

    expect(detail.metrics).toEqual([]);
    expect(detail.opportunities).toEqual([]);
    expect(detail.diagnostics).toEqual([]);
  });

  test('reports a null score when Lighthouse did not score the page', () => {
    const detail = perfDetail({ lighthouseVersion: '13.4.1', audits: {} });

    expect(detail.score).toBeNull();
    expect(detail.scoreState).toBeNull();
  });

  test('survives the raw schema as an opaque payload', () => {
    const document = rawDocumentSchema.parse({
      schema: RAW_SCHEMA_VERSION,
      axis: 'PERF',
      tool: { name: 'lighthouse', version: '13.4.1' },
      target: { url: 'https://example.com/', mode: 'quick' },
      observations: [],
      detail: perfDetail(richReport()),
    });

    expect(parsePerfDetail(document.detail)).toBeDefined();
  });
});

describe('parsePerfDetail', () => {
  test('rejects anything that is not this payload', () => {
    expect(parsePerfDetail(null)).toBeUndefined();
    expect(parsePerfDetail('detail')).toBeUndefined();
    expect(parsePerfDetail({ schema: 'webdiag.perf/0' })).toBeUndefined();
    expect(parsePerfDetail({ schema: 'webdiag.perf/1', metrics: [] })).toBeUndefined();
  });

  test('accepts a payload it just produced', () => {
    expect(parsePerfDetail(perfDetail(richReport()))).toBeDefined();
  });
});
