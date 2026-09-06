import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { buildMeta } from './meta.ts';
import { normalize } from './normalize.ts';
import { runProbe } from './probe.ts';
import { escapeHtml, renderReport } from './report.ts';
import { stubProbes } from './stub-probe.ts';
import { buildSummary } from './summary.ts';

async function renderStubReport() {
  const context = { url: 'https://example.com', mode: 'quick' as const, pages: 1 };
  const outcomes = await Promise.all(stubProbes().map((probe) => runProbe(probe, context)));
  const documents = outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.raw] : []));
  const { findings, rejected } = normalize(documents);

  const summary = buildSummary({
    url: context.url,
    mode: context.mode,
    pages: 1,
    requestedAxes: AXES,
    outcomes,
    findings,
    rejected,
  });

  const meta = buildMeta({
    url: context.url,
    mode: context.mode,
    pages: 1,
    axes: AXES,
    outcomes,
    startedAt: new Date('2026-09-06T12:00:00.000Z'),
    finishedAt: new Date('2026-09-06T12:00:01.000Z'),
    artifacts: ['findings.json'],
    runtime: { engine: 'bun@test', platform: 'test', arch: 'test' },
  });

  return { html: renderReport(summary, meta), summary };
}

describe('escapeHtml', () => {
  test('neutralises markup and quotes so evidence cannot break the document', () => {
    expect(escapeHtml('<img src="x" onerror=\'alert(1)\'> & more')).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; more',
    );
  });
});

describe('renderReport', () => {
  test('is a self-contained document with no external requests', async () => {
    const { html } = await renderStubReport();

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('cdn.');
  });

  test('shows every axis with its own score', async () => {
    const { html, summary } = await renderStubReport();

    for (const axis of summary.byAxis) {
      expect(html).toContain(`id="axis-${axis.axis}"`);
      expect(html).toContain(`${axis.score}<small>/100</small>`);
    }
  });

  test('states that no composite metric exists', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('No se publica un numero unico');
    expect(html).toContain('Cada eje se evalua de forma independiente');
  });

  test('promotes the blocking critical to the cover instead of averaging it away', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('hallazgo(s) bloqueante(s)');
    expect(html).toContain('SEO-NOINDEX-UNINTENDED');
    expect(html).toContain('Anulado por hallazgo bloqueante');
  });

  test('lists low-confidence findings rather than hiding them', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('Confianza baja');
    expect(html).toContain('DEPS-VULN-HIGH');
  });

  test('carries the tool and catalog versions in the footer', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('webdiag-stub');
    expect(html).toContain('0.0.0-fixture');
    expect(html).toContain('catalogo <code>1.0.0</code>');
  });

  test('shows the arithmetic behind a score instead of only the number', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('Como se calculo este puntaje');
    expect(html).toContain('Puntaje fijado en 0 por');
  });
});
