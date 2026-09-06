import { describe, expect, test } from 'bun:test';
import { createFinding, type Finding } from '../catalog/index.ts';
import { evaluateBudget } from './budget.ts';

function finding(
  overrides: Partial<Parameters<typeof createFinding>[0]> & { id: string },
): Finding {
  return createFinding({
    confidence: 'high',
    count: 1,
    affected: ['/'],
    evidence: {},
    source: 'probe:test',
    tool: 'test@0.0.0',
    mode: 'quick',
    remediation: 'fix it',
    ...overrides,
  });
}

describe('evaluateBudget', () => {
  test('a blocking critical always violates, regardless of the threshold drawn', () => {
    const blocking = finding({ id: 'SEO-NOINDEX-UNINTENDED' });

    expect(evaluateBudget([blocking], 'critical')).toEqual([
      { id: 'SEO-NOINDEX-UNINTENDED', severity: 'critical', reason: 'blocking' },
    ]);
    expect(evaluateBudget([blocking], 'info')).toEqual([
      { id: 'SEO-NOINDEX-UNINTENDED', severity: 'critical', reason: 'blocking' },
    ]);
  });

  test('a non-blocking finding violates only at or above the threshold', () => {
    const high = finding({ id: 'SEC-CSP-MISSING' }); // baseSeverity: high

    expect(evaluateBudget([high], 'critical')).toEqual([]);
    expect(evaluateBudget([high], 'high')).toEqual([
      { id: 'SEC-CSP-MISSING', severity: 'high', reason: 'severity' },
    ]);
    expect(evaluateBudget([high], 'low')).toEqual([
      { id: 'SEC-CSP-MISSING', severity: 'high', reason: 'severity' },
    ]);
  });

  test('a medium finding stays under a high threshold', () => {
    const medium = finding({ id: 'SEC-HSTS-MISSING' }); // baseSeverity: medium

    expect(evaluateBudget([medium], 'high')).toEqual([]);
  });

  test('low confidence never violates, even a blocking critical', () => {
    const blocking = finding({ id: 'SEO-NOINDEX-UNINTENDED', confidence: 'low' });
    const high = finding({ id: 'SEC-CSP-MISSING', confidence: 'low' });

    expect(evaluateBudget([blocking, high], 'low')).toEqual([]);
  });

  test('a clean run violates nothing', () => {
    expect(evaluateBudget([], 'critical')).toEqual([]);
  });
});
