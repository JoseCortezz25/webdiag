import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { normalize } from './normalize.ts';
import { runProbe } from './probe.ts';
import { stubProbes } from './stub-probe.ts';
import { buildSummary, DISCLAIMERS } from './summary.ts';

async function summarize() {
  const context = { url: 'https://example.com', mode: 'quick' as const, pages: 1 };
  const outcomes = await Promise.all(stubProbes().map((probe) => runProbe(probe, context)));
  const documents = outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.raw] : []));
  const { findings, rejected } = normalize(documents);

  return buildSummary({
    url: context.url,
    mode: context.mode,
    pages: 1,
    requestedAxes: AXES,
    outcomes,
    findings,
    rejected,
  });
}

describe('buildSummary', () => {
  test('is self-sufficient: layer 3 never reads the raw files', async () => {
    const summary = await summarize();

    for (const axis of summary.byAxis) {
      for (const finding of [...axis.findings, ...axis.lowConfidence]) {
        expect(finding.remediation.length).toBeGreaterThan(0);
        expect(finding.affected.length).toBeGreaterThan(0);
        expect(finding.evidence).toBeDefined();
        expect(finding.ownerAxis).toBeDefined();
      }
    }
  });

  test('carries the disclaimers that stop the report reading as a certificate', async () => {
    const summary = await summarize();

    expect(summary.disclaimers).toEqual(DISCLAIMERS);
  });

  test('counts scored and low-confidence findings separately', async () => {
    const summary = await summarize();

    expect(summary.totals.findings).toBe(summary.totals.scored + summary.totals.lowConfidence);
    expect(summary.totals.lowConfidence).toBeGreaterThan(0);
  });

  test('reports an axis whose probe never ran as failed rather than omitting it', async () => {
    const summary = buildSummary({
      url: 'https://example.com',
      mode: 'quick',
      pages: 1,
      requestedAxes: ['SEC'],
      outcomes: [],
      findings: [],
      rejected: [],
    });

    expect(summary.byAxis).toHaveLength(1);
    expect(summary.byAxis[0]?.probe.status).toBe('failed');
    expect(summary.byAxis[0]?.probe.error).toContain('No probe registered');
  });
});
