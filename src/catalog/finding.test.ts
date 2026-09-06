import { describe, expect, test } from 'bun:test';
import { CATALOG_VERSION } from './catalog.ts';
import { createFinding, type Finding, safeParseFinding } from './finding.ts';

const VALID = {
  id: 'SEO-CANONICAL-CONFLICT',
  catalog_version: CATALOG_VERSION,
  severity: 'critical',
  confidence: 'high',
  title: 'El canonical apunta a una URL con noindex',
  affected: ['https://cliente.com/producto/x'],
  count: 1,
  evidence: {
    canonical_target: 'https://cliente.com/producto/',
    target_meta_robots: 'noindex,follow',
  },
  source: 'probe:seo',
  tool: 'internal',
  mode: 'quick',
  remediation: 'Apuntar el canonical a una URL indexable, o quitar el noindex del destino.',
  doc_ref: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
} as const;

describe('findingSchema', () => {
  test('accepts the example finding from the catalog', () => {
    const result = safeParseFinding(VALID);

    expect(result.success).toBe(true);
  });

  test('accepts a finding without the optional fields', () => {
    const { doc_ref: _doc, title: _title, ...minimal } = VALID;

    expect(safeParseFinding(minimal).success).toBe(true);
  });

  test('rejects an ID that is not in the catalog', () => {
    expect(safeParseFinding({ ...VALID, id: 'SEO-KEYWORD-DENSITY-LOW' }).success).toBe(false);
  });

  test('rejects a foreign catalog version', () => {
    expect(safeParseFinding({ ...VALID, catalog_version: '0.9.0' }).success).toBe(false);
  });

  test.each([['severity'], ['confidence'], ['mode']])('rejects an unknown %s', (field) => {
    expect(safeParseFinding({ ...VALID, [field]: 'somewhat' }).success).toBe(false);
  });

  test('rejects a count below one', () => {
    expect(safeParseFinding({ ...VALID, count: 0 }).success).toBe(false);
  });

  test('rejects a fractional count', () => {
    expect(safeParseFinding({ ...VALID, count: 1.5 }).success).toBe(false);
  });

  test('accepts count above the affected sample size', () => {
    const sampled = { ...VALID, count: 200, affected: ['https://cliente.com/a'] };

    expect(safeParseFinding(sampled).success).toBe(true);
  });

  test('rejects more affected entries than count claims', () => {
    const inconsistent = {
      ...VALID,
      count: 1,
      affected: ['https://cliente.com/a', 'https://cliente.com/b'],
    };

    expect(safeParseFinding(inconsistent).success).toBe(false);
  });

  test('rejects a doc_ref that is not a URL', () => {
    expect(safeParseFinding({ ...VALID, doc_ref: 'see the docs' }).success).toBe(false);
  });

  test.each([['source'], ['tool'], ['remediation']])('rejects an empty %s', (field) => {
    expect(safeParseFinding({ ...VALID, [field]: '' }).success).toBe(false);
  });
});

describe('createFinding', () => {
  const base = {
    id: 'PERF-LCP-POOR',
    confidence: 'high',
    count: 3,
    affected: ['https://cliente.com/', 'https://cliente.com/a', 'https://cliente.com/b'],
    evidence: { lcp_ms: 4200 },
    source: 'probe:perf',
    tool: 'lighthouse',
    mode: 'quick',
    remediation: 'Reducir el tiempo de carga del elemento LCP.',
  } as const;

  test('defaults severity to the catalog base and stamps the version', () => {
    const finding: Finding = createFinding(base);

    expect(finding.severity).toBe('high');
    expect(finding.catalog_version).toBe(CATALOG_VERSION);
  });

  test('allows a run to escalate severity above the base', () => {
    expect(createFinding({ ...base, severity: 'critical' }).severity).toBe('critical');
  });

  test('omits optional fields rather than emitting undefined', () => {
    const finding = createFinding(base);

    expect('doc_ref' in finding).toBe(false);
    expect('title' in finding).toBe(false);
  });

  test('throws on an unknown ID instead of emitting an invalid finding', () => {
    expect(() => createFinding({ ...base, id: 'PERF-MADE-UP' })).toThrow(/Unknown catalog ID/);
  });
});
