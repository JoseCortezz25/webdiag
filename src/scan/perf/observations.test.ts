import { describe, expect, test } from 'bun:test';
import { normalize } from '../normalize.ts';
import { RAW_SCHEMA_VERSION, rawDocumentSchema } from '../raw.ts';
import type { FieldData } from './crux.ts';
import type { LighthouseReport } from './lhr.ts';
import { perfObservations, THRESHOLDS } from './observations.ts';

/**
 * Shapes transcribed from a real Lighthouse 13.4.1 run against python.org. They
 * are handwritten rather than a captured 2 MB LHR so a reader can see exactly
 * which field each assertion depends on — and so a Lighthouse rename shows up
 * here as a failing test instead of as a silently empty Performance axis.
 */
const NO_FIELD: FieldData = { available: false, reason: 'CrUX no tiene datos para el origen.' };

function report(overrides: Partial<LighthouseReport> = {}): LighthouseReport {
  return {
    lighthouseVersion: '13.4.1',
    finalDisplayedUrl: 'https://example.com/servicios',
    categories: { performance: { score: 0.7 } },
    audits: {},
    ...overrides,
  };
}

function poorReport(): LighthouseReport {
  return report({
    audits: {
      'largest-contentful-paint': {
        scoreDisplayMode: 'numeric',
        score: 0.42,
        numericValue: 4282.35,
      },
      'lcp-breakdown-insight': {
        scoreDisplayMode: 'informative',
        details: {
          type: 'list',
          items: [{ type: 'node', selector: 'header.main-header > div.container > p' }],
        },
      },
      'cumulative-layout-shift': { scoreDisplayMode: 'numeric', score: 0.3, numericValue: 0.284 },
      'cls-culprits-insight': {
        scoreDisplayMode: 'metricSavings',
        details: { type: 'table', items: [{ url: 'https://example.com/ads.js' }] },
      },
      'total-blocking-time': { scoreDisplayMode: 'numeric', score: 0.63, numericValue: 444.5 },
      'server-response-time': {
        scoreDisplayMode: 'metricSavings',
        details: {
          type: 'opportunity',
          items: [{ url: 'https://example.com/', responseTime: 1310 }],
        },
        numericValue: 1310,
      },
      'image-delivery-insight': {
        scoreDisplayMode: 'metricSavings',
        details: {
          type: 'table',
          items: [
            {
              url: 'https://example.com/img/hero.png',
              totalBytes: 220_000,
              wastedBytes: 180_000,
            },
          ],
        },
      },
      'unsized-images': {
        scoreDisplayMode: 'metricSavings',
        details: { type: 'table', items: [{ url: 'https://example.com/img/logo.png' }] },
      },
      'render-blocking-insight': {
        scoreDisplayMode: 'metricSavings',
        metricSavings: { FCP: 1600, LCP: 1600 },
        details: {
          type: 'table',
          items: [
            { url: 'https://example.com/style.css', totalBytes: 125_658, wastedMs: 1072 },
            { url: 'https://example.com/modernizr.js', totalBytes: 5242 },
          ],
        },
      },
      'cache-insight': {
        scoreDisplayMode: 'metricSavings',
        details: {
          type: 'table',
          items: [
            { url: 'https://example.com/app.js', cacheLifetimeMs: 3_600_000, totalBytes: 8979 },
            { url: 'https://example.com/style.css', cacheLifetimeMs: 0, totalBytes: 125_658 },
          ],
        },
      },
    },
  });
}

function idsOf(input: Parameters<typeof perfObservations>[0]): readonly string[] {
  return perfObservations(input).map((observation) => observation.id);
}

function findObservation(reportInput: LighthouseReport, id: string, field: FieldData = NO_FIELD) {
  return perfObservations({ report: reportInput, path: '/', field }).find(
    (observation) => observation.id === id,
  );
}

describe('perfObservations', () => {
  test('maps every phase-1 Performance ID a poor page triggers', () => {
    const ids = idsOf({ report: poorReport(), path: '/', field: NO_FIELD });

    expect(ids).toEqual([
      'PERF-LCP-POOR',
      'PERF-CLS-POOR',
      'PERF-TBT-HIGH',
      'PERF-TTFB-SLOW',
      'PERF-IMG-UNOPTIMIZED',
      'PERF-RENDER-BLOCKING',
      'PERF-NO-CACHE-POLICY',
      'PERF-FIELD-UNAVAILABLE',
    ]);
  });

  test('emits nothing but the field disclaimer for a healthy page', () => {
    const healthy = report({
      audits: {
        'largest-contentful-paint': { scoreDisplayMode: 'numeric', score: 1, numericValue: 766.8 },
        'cumulative-layout-shift': { scoreDisplayMode: 'numeric', score: 1, numericValue: 0 },
        'total-blocking-time': { scoreDisplayMode: 'numeric', score: 1, numericValue: 0 },
        'server-response-time': { scoreDisplayMode: 'metricSavings', numericValue: 13 },
        'unsized-images': {
          scoreDisplayMode: 'metricSavings',
          details: { type: 'table', items: [] },
        },
        'render-blocking-insight': {
          scoreDisplayMode: 'metricSavings',
          details: { type: 'table', items: [] },
        },
      },
    });

    expect(idsOf({ report: healthy, path: '/', field: NO_FIELD })).toEqual([
      'PERF-FIELD-UNAVAILABLE',
    ]);
  });

  test('uses the catalogue threshold, not the Lighthouse score', () => {
    // Lighthouse scores this 0.42, which by its own curve is a failure. What
    // decides the finding is whether the number crosses 2500ms.
    const onThreshold = report({
      audits: {
        'largest-contentful-paint': {
          scoreDisplayMode: 'numeric',
          score: 0.42,
          numericValue: THRESHOLDS.lcpMs,
        },
      },
    });

    expect(idsOf({ report: onThreshold, path: '/', field: NO_FIELD })).not.toContain(
      'PERF-LCP-POOR',
    );
  });

  test('an errored audit produces no claim at all', () => {
    const errored = report({
      audits: {
        'largest-contentful-paint': {
          scoreDisplayMode: 'error',
          score: null,
          errorMessage: 'The page did not paint any content. (NO_FCP)',
        },
      },
    });

    expect(idsOf({ report: errored, path: '/', field: NO_FIELD })).toEqual([
      'PERF-FIELD-UNAVAILABLE',
    ]);
  });

  describe('confidence', () => {
    test('is medium when the metric is only just over the line', () => {
      const borderline = report({
        audits: {
          'largest-contentful-paint': {
            scoreDisplayMode: 'numeric',
            score: 0.6,
            numericValue: 2600,
          },
        },
      });

      expect(findObservation(borderline, 'PERF-LCP-POOR')?.confidence).toBe('medium');
    });

    test('is high once one noisy run cannot explain the result', () => {
      expect(findObservation(poorReport(), 'PERF-LCP-POOR')?.confidence).toBe('high');
    });

    test('is raised to high when field data puts real users in the poor bucket', () => {
      const borderline = report({
        audits: {
          'largest-contentful-paint': {
            scoreDisplayMode: 'numeric',
            score: 0.6,
            numericValue: 2600,
          },
        },
      });
      const field: FieldData = { available: true, source: 'CrUX', metrics: { lcp: 4600 } };

      const observation = findObservation(borderline, 'PERF-LCP-POOR', field);

      expect(observation?.confidence).toBe('high');
      expect(observation?.evidence.field_lcp_p75).toBe(4600);
    });

    test('never exceeds medium for TBT, which is a proxy for INP', () => {
      const awful = report({
        audits: {
          'total-blocking-time': { scoreDisplayMode: 'numeric', score: 0, numericValue: 9000 },
        },
      });

      const observation = findObservation(awful, 'PERF-TBT-HIGH');

      expect(observation?.confidence).toBe('medium');
      expect(String(observation?.evidence.note)).toContain('proxy');
    });

    test('drops to medium for images when no byte saving was measured', () => {
      const unsizedOnly = report({
        audits: {
          'unsized-images': {
            scoreDisplayMode: 'metricSavings',
            details: { type: 'table', items: [{ url: 'https://example.com/img/logo.png' }] },
          },
        },
      });

      expect(findObservation(unsizedOnly, 'PERF-IMG-UNOPTIMIZED')?.confidence).toBe('medium');
      expect(findObservation(poorReport(), 'PERF-IMG-UNOPTIMIZED')?.confidence).toBe('high');
    });
  });

  describe('PERF-FIELD-UNAVAILABLE', () => {
    test('carries the reason CrUX gave, so the report can state it', () => {
      const observation = findObservation(poorReport(), 'PERF-FIELD-UNAVAILABLE');

      expect(observation?.evidence).toEqual({
        source: 'CrUX',
        reason: 'CrUX no tiene datos para el origen.',
      });
    });

    test('disappears once field data exists', () => {
      const field: FieldData = { available: true, source: 'CrUX', metrics: { lcp: 1800 } };

      expect(idsOf({ report: poorReport(), path: '/', field })).not.toContain(
        'PERF-FIELD-UNAVAILABLE',
      );
    });
  });

  test('every observation survives the raw schema and the catalogue', () => {
    const document = rawDocumentSchema.parse({
      schema: RAW_SCHEMA_VERSION,
      axis: 'PERF',
      tool: {
        name: 'lighthouse',
        version: '13.4.1',
        components: [{ name: 'chrome-headless-shell', version: '148.0.7778.97' }],
      },
      target: { url: 'https://example.com/', mode: 'quick' },
      observations: perfObservations({ report: poorReport(), path: '/', field: NO_FIELD }),
    });

    const { findings, rejected } = normalize([document]);

    expect(rejected).toEqual([]);
    // Catalogue order, not probe order: severity first, then ID.
    expect(findings.map((finding) => finding.id)).toEqual([
      'PERF-CLS-POOR',
      'PERF-LCP-POOR',
      'PERF-IMG-UNOPTIMIZED',
      'PERF-NO-CACHE-POLICY',
      'PERF-RENDER-BLOCKING',
      'PERF-TBT-HIGH',
      'PERF-TTFB-SLOW',
      'PERF-FIELD-UNAVAILABLE',
    ]);
  });

  test('severity comes from the catalogue, not from the probe', () => {
    for (const observation of perfObservations({
      report: poorReport(),
      path: '/',
      field: NO_FIELD,
    })) {
      expect(observation.severity).toBeUndefined();
    }
  });
});
