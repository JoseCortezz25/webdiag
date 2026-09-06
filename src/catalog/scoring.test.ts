import { describe, expect, test } from 'bun:test';
import { createFinding, type Finding } from './finding.ts';
import { coverPageFindings, lowConfidenceFindings, scoreAxes, scoreAxis } from './scoring.ts';
import { type Confidence, MAX_AXIS_SCORE, type Severity } from './taxonomy.ts';

function finding(
  id: string,
  overrides: { severity?: Severity; confidence?: Confidence } = {},
): Finding {
  return createFinding({
    id,
    confidence: overrides.confidence ?? 'high',
    count: 1,
    affected: ['https://cliente.com/'],
    evidence: {},
    source: 'probe:test',
    tool: 'internal',
    mode: 'quick',
    remediation: 'Corregirlo.',
    ...(overrides.severity === undefined ? {} : { severity: overrides.severity }),
  });
}

describe('severity deductions', () => {
  test('an axis with no findings keeps a full score', () => {
    expect(scoreAxis('SEO', []).score).toBe(MAX_AXIS_SCORE);
  });

  test('high subtracts 15, medium 5, low 1 and info nothing', () => {
    const findings = [
      finding('SEO-TITLE-MISSING'),
      finding('SEO-H1-MISSING'),
      finding('SEO-META-DESC-MISSING'),
    ];

    expect(scoreAxis('SEO', findings).score).toBe(MAX_AXIS_SCORE - 15 - 5 - 1);
  });

  test('info findings cost nothing, so the mandatory three are free', () => {
    const result = scoreAxis('A11Y', [finding('A11Y-MANUAL-REVIEW-PENDING')]);

    expect(result.score).toBe(MAX_AXIS_SCORE);
    expect(result.deductions).toEqual([]);
    expect(result.scored).toHaveLength(1);
  });

  test('one finding on 200 pages is deducted once, not 200 times', () => {
    const widespread = createFinding({
      id: 'A11Y-IMG-ALT-MISSING',
      confidence: 'high',
      count: 200,
      affected: ['https://cliente.com/'],
      evidence: {},
      source: 'probe:a11y',
      tool: 'axe-core',
      mode: 'deep',
      remediation: 'Agregar alt.',
    });

    expect(scoreAxis('A11Y', [widespread]).score).toBe(MAX_AXIS_SCORE - 15);
  });

  test('a score never goes below zero', () => {
    const many = Array.from({ length: 20 }, () => finding('SEO-TITLE-MISSING'));

    expect(scoreAxis('SEO', many).score).toBe(0);
  });
});

describe('override rule', () => {
  test('a blocking critical zeroes its axis and goes to the cover', () => {
    const result = scoreAxis('SEO', [finding('SEO-NOINDEX-UNINTENDED')]);

    expect(result.score).toBe(0);
    expect(result.zeroed).toBe(true);
    expect(result.zeroedBy).toEqual(['SEO-NOINDEX-UNINTENDED']);
    expect(result.coverPage).toEqual(['SEO-NOINDEX-UNINTENDED']);
  });

  test('a non-blocking critical zeroes its axis without reaching the cover', () => {
    const result = scoreAxis('DEPS', [finding('DEPS-VULN-CRITICAL')]);

    expect(result.score).toBe(0);
    expect(result.zeroed).toBe(true);
    expect(result.coverPage).toEqual([]);
  });

  test('zeroing replaces the arithmetic instead of averaging with it', () => {
    const result = scoreAxis('SEO', [
      finding('SEO-NOINDEX-UNINTENDED'),
      finding('SEO-META-DESC-MISSING'),
    ]);

    expect(result.score).toBe(0);
    expect(result.deductions).toEqual([]);
  });

  test('a blocking critical in one axis leaves the other axes untouched', () => {
    const scores = scoreAxes([finding('SEO-STATUS-ERROR'), finding('PERF-TBT-HIGH')]);

    expect(scores.SEO.score).toBe(0);
    expect(scores.PERF.score).toBe(MAX_AXIS_SCORE - 5);
    expect(scores.A11Y.score).toBe(MAX_AXIS_SCORE);
    expect(scores.SEC.score).toBe(MAX_AXIS_SCORE);
    expect(scores.DEPS.score).toBe(MAX_AXIS_SCORE);
    expect(scores.AGENT.score).toBe(MAX_AXIS_SCORE);
  });

  test('A11Y-FORM-LABEL-MISSING deducts as high and never zeroes the axis', () => {
    const result = scoreAxis('A11Y', [finding('A11Y-FORM-LABEL-MISSING')]);

    expect(result.score).toBe(MAX_AXIS_SCORE - 15);
    expect(result.zeroed).toBe(false);
  });

  test('coverPageFindings collects the blocking criticals of a run', () => {
    const findings = [
      finding('SEO-REDIRECT-LOOP'),
      finding('DEPS-VULN-CRITICAL'),
      finding('SEO-H1-MISSING'),
    ];

    expect(coverPageFindings(findings).map((item) => item.id)).toEqual(['SEO-REDIRECT-LOOP']);
  });
});

describe('low confidence', () => {
  test('is listed but never deducted', () => {
    const result = scoreAxis('A11Y', [
      finding('A11Y-CONTRAST-INSUFFICIENT', { confidence: 'low' }),
    ]);

    expect(result.score).toBe(MAX_AXIS_SCORE);
    expect(result.lowConfidence).toHaveLength(1);
    expect(result.scored).toEqual([]);
  });

  test('cannot zero an axis, not even on a blocking critical', () => {
    const result = scoreAxis('SEC', [finding('SEC-TLS-EXPIRED', { confidence: 'low' })]);

    expect(result.score).toBe(MAX_AXIS_SCORE);
    expect(result.zeroed).toBe(false);
    expect(result.coverPage).toEqual([]);
    expect(result.lowConfidence.map((item) => item.id)).toEqual(['SEC-TLS-EXPIRED']);
  });

  test('is surfaced separately for the report, never dropped', () => {
    const findings = [
      finding('SEO-TITLE-MISSING', { confidence: 'low' }),
      finding('SEO-H1-MISSING', { confidence: 'medium' }),
    ];

    expect(lowConfidenceFindings(findings).map((item) => item.id)).toEqual(['SEO-TITLE-MISSING']);

    const result = scoreAxis('SEO', findings);

    expect(result.lowConfidence).toHaveLength(1);
    expect(result.scored).toHaveLength(1);
    expect(result.lowConfidence.length + result.scored.length).toBe(findings.length);
  });
});

describe('owner axis', () => {
  test('DEPS-SOURCEMAP-EXPOSED deducts in DEPS and only informs SEC', () => {
    const scores = scoreAxes([finding('DEPS-SOURCEMAP-EXPOSED')]);

    expect(scores.DEPS.score).toBe(MAX_AXIS_SCORE - 5);
    expect(scores.SEC.score).toBe(MAX_AXIS_SCORE);
    expect(scores.SEC.mentions.map((item) => item.id)).toEqual(['DEPS-SOURCEMAP-EXPOSED']);
    expect(scores.SEC.scored).toEqual([]);
  });

  test('A11Y-LANDMARKS-MISSING deducts in A11Y and only informs AGENT', () => {
    const scores = scoreAxes([finding('A11Y-LANDMARKS-MISSING')]);

    expect(scores.A11Y.score).toBe(MAX_AXIS_SCORE - 5);
    expect(scores.AGENT.score).toBe(MAX_AXIS_SCORE);
    expect(scores.AGENT.mentions.map((item) => item.id)).toEqual(['A11Y-LANDMARKS-MISSING']);
  });

  test('a shared finding is counted once across the whole run', () => {
    const scores = scoreAxes([finding('DEPS-SOURCEMAP-EXPOSED')]);
    const deducted = Object.values(scores).flatMap((score) => score.deductions);

    expect(deducted).toHaveLength(1);
  });
});
