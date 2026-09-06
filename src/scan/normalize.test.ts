import { describe, expect, test } from 'bun:test';
import { CATALOG_VERSION, scoreAxis } from '../catalog/index.ts';
import { normalize } from './normalize.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type RawObservation } from './raw.ts';

function observation(overrides: Partial<RawObservation> & { id: string }): RawObservation {
  return {
    confidence: 'high',
    count: 1,
    affected: ['/'],
    evidence: {},
    remediation: 'do the thing',
    ...overrides,
  };
}

function document(axis: RawDocument['axis'], observations: readonly RawObservation[]): RawDocument {
  return {
    schema: RAW_SCHEMA_VERSION,
    axis,
    tool: { name: 'test', version: '1.0.0' },
    target: { url: 'https://example.com', mode: 'quick' },
    observations,
  };
}

describe('normalize', () => {
  test('stamps the catalog version and the producing probe on every finding', () => {
    const { findings } = normalize([document('SEO', [observation({ id: 'SEO-H1-MISSING' })])]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.catalog_version).toBe(CATALOG_VERSION);
    expect(findings[0]?.source).toBe('probe:seo');
    expect(findings[0]?.tool).toBe('test@1.0.0');
  });

  test('defaults severity to the catalog base rather than trusting the probe', () => {
    const { findings } = normalize([
      document('SEO', [observation({ id: 'SEO-NOINDEX-UNINTENDED' })]),
    ]);

    expect(findings[0]?.severity).toBe('critical');
  });

  test('merges repeats of one ID into a single finding with a summed count', () => {
    const { findings } = normalize([
      document('A11Y', [
        observation({ id: 'A11Y-IMG-ALT-MISSING', count: 4, affected: ['/b'] }),
        observation({ id: 'A11Y-IMG-ALT-MISSING', count: 3, affected: ['/a'] }),
      ]),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.count).toBe(7);
    expect(findings[0]?.affected).toEqual(['/a', '/b']);
  });

  test('a merged finding is as severe as its worst occurrence', () => {
    const { findings } = normalize([
      document('SEC', [
        observation({ id: 'SEC-CSP-UNSAFE', severity: 'low' }),
        observation({ id: 'SEC-CSP-UNSAFE', severity: 'high' }),
      ]),
    ]);

    expect(findings[0]?.severity).toBe('high');
  });

  test('a merged finding is as certain as its most certain occurrence', () => {
    const { findings } = normalize([
      document('SEC', [
        observation({ id: 'SEC-HSTS-MISSING', confidence: 'low' }),
        observation({ id: 'SEC-HSTS-MISSING', confidence: 'high' }),
      ]),
    ]);

    expect(findings[0]?.confidence).toBe('high');
  });

  test('rejects an unknown ID instead of throwing, so the other axes survive', () => {
    const { findings, rejected } = normalize([
      document('SEO', [observation({ id: 'SEO-NOT-A-REAL-ID' })]),
      document('SEC', [observation({ id: 'SEC-CSP-MISSING' })]),
    ]);

    expect(findings.map((finding) => finding.id)).toEqual(['SEC-CSP-MISSING']);
    expect(rejected).toEqual([
      {
        id: 'SEO-NOT-A-REAL-ID',
        axis: 'SEO',
        reason: 'unknown-id',
        detail: 'The ID is not published in this catalog version.',
      },
    ]);
  });

  test('rejects a malformed observation without losing the rest of the document', () => {
    const { findings, rejected } = normalize([
      document('PERF', [
        observation({ id: 'PERF-LCP-POOR', count: 1, affected: ['/a', '/b'] }),
        observation({ id: 'PERF-TTFB-SLOW' }),
      ]),
    ]);

    expect(findings.map((finding) => finding.id)).toEqual(['PERF-TTFB-SLOW']);
    expect(rejected[0]?.reason).toBe('invalid-observation');
  });

  test('output order does not depend on the order the probes finished', () => {
    const perf = document('PERF', [observation({ id: 'PERF-LCP-POOR' })]);
    const seo = document('SEO', [observation({ id: 'SEO-H1-MISSING' })]);

    const forwards = normalize([perf, seo]).findings.map((finding) => finding.id);
    const backwards = normalize([seo, perf]).findings.map((finding) => finding.id);

    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual(['PERF-LCP-POOR', 'SEO-H1-MISSING']);
  });

  test('sorts the worst severity first within an axis', () => {
    const { findings } = normalize([
      document('SEO', [
        observation({ id: 'SEO-META-DESC-MISSING' }),
        observation({ id: 'SEO-NOINDEX-UNINTENDED' }),
        observation({ id: 'SEO-H1-MISSING' }),
      ]),
    ]);

    expect(findings.map((finding) => finding.id)).toEqual([
      'SEO-NOINDEX-UNINTENDED',
      'SEO-H1-MISSING',
      'SEO-META-DESC-MISSING',
    ]);
  });

  test('feeds the per-axis override rule: a blocking critical zeroes its own axis only', () => {
    const { findings } = normalize([
      document('SEO', [observation({ id: 'SEO-NOINDEX-UNINTENDED' })]),
      document('SEC', [observation({ id: 'SEC-HSTS-MISSING' })]),
    ]);

    expect(scoreAxis('SEO', findings).score).toBe(0);
    expect(scoreAxis('SEC', findings).score).toBe(95);
  });
});
