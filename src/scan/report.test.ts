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

describe('renderReport — seccion de Rendimiento estilo Lighthouse', () => {
  test('renders the score gauge and the score metrics', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('class="perf"');
    expect(html).toContain('Score de Lighthouse');
    expect(html).toContain('First Contentful Paint');
    expect(html).toContain('Largest Contentful Paint');
    expect(html).toContain('Speed Index');
    expect(html).toContain('Total Blocking Time');
    expect(html).toContain('Cumulative Layout Shift');
  });

  test('colours the metrics by threshold band', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('class="metric good"');
    expect(html).toContain('class="metric poor"');
  });

  test('states that TBT is a proxy, never INP', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('Proxy de laboratorio para INP');
  });

  test('shows opportunities with estimated savings and diagnostics, collapsible without JS', async () => {
    const { html } = await renderStubReport();

    expect(html).toContain('<details class="perf-block"');
    expect(html).toContain('Oportunidades');
    expect(html).toContain('Diagnosticos');
    expect(html).toContain('Ahorro estimado');
    expect(html).toContain('~1.6 s');
    expect(html).toContain('1840 KB');
    expect(html).toContain('Imagenes sin width/height');
  });

  test('renders no Lighthouse section for a Performance axis that failed to measure', async () => {
    const summary = buildSummary({
      url: 'https://example.com',
      mode: 'quick',
      pages: 1,
      requestedAxes: ['PERF'],
      outcomes: [],
      findings: [],
      rejected: [],
    });

    const meta = buildMeta({
      url: 'https://example.com',
      mode: 'quick',
      pages: 1,
      axes: ['PERF'],
      outcomes: [],
      startedAt: new Date('2026-09-06T12:00:00.000Z'),
      finishedAt: new Date('2026-09-06T12:00:01.000Z'),
      artifacts: ['report.html'],
      runtime: { engine: 'bun@test', platform: 'test', arch: 'test' },
    });

    const html = renderReport(summary, meta);

    expect(html).toContain('id="axis-PERF"');
    expect(html).toContain('sin medir');
    expect(html).not.toContain('class="perf"');
  });
});

describe('renderReport — el eje AGENT declara su impacto no probado', () => {
  test('states it in the axis section, not only in the disclaimer block', async () => {
    const { html } = await renderStubReport();
    const section = html.slice(html.indexOf('id="axis-AGENT"'));

    expect(section).toContain('Impacto no probado');
    expect(section).toContain('no debe leerse como un factor de posicionamiento demostrado');
  });

  test('marks the axis card too, so a reader who only skims the grid still sees it', async () => {
    const { html } = await renderStubReport();
    const grid = html.slice(html.indexOf('<div class="axis-grid">'));

    expect(grid.slice(0, grid.indexOf('no-composite'))).toContain('class="axis-caveat"');
  });

  test('no other axis carries the caveat', async () => {
    const { html } = await renderStubReport();

    expect(html.match(/class="axis-caveat"/g)).toHaveLength(1);
  });

  test('and the summary disclaimers carry it in machine-readable form', async () => {
    const { summary } = await renderStubReport();

    expect(summary.disclaimers.some((line) => line.includes('Agent-readiness'))).toBe(true);
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
