/**
 * `report.html` — the client-facing artifact.
 *
 * Self-contained by design (spec §2): one file, inline CSS, no fonts, no CDN,
 * no script. It has to survive being emailed, and a report that phones home to
 * render is a report that will one day render blank.
 *
 * The layout enforces the scoring decision rather than merely respecting it:
 * there is no slot anywhere for a single number. Six independent axis cards,
 * each with its own score and its own arithmetic, and an explicit line saying a
 * composite does not exist — because the first thing a reader does with six
 * numbers is average them.
 *
 * Copy is Spanish: the catalogue's published meanings and remediations are
 * Spanish (they are the contract, see `entries.ts`), and an English shell around
 * Spanish content would read as a bug to the client it is written for.
 */
import type { Severity } from '../catalog/index.ts';
import { requireEntry } from '../catalog/index.ts';
import { PROGRAM_NAME, VERSION } from '../version.ts';
import type { Meta } from './meta.ts';
import {
  type MetricState,
  type PerfDetail,
  type PerfDiagnostic,
  type PerfMetric,
  type PerfOpportunity,
  parsePerfDetail,
} from './perf/detail.ts';
import type { AxisSummary, FindingSummary, Summary } from './summary.ts';

const AXIS_LABEL: Readonly<Record<string, string>> = {
  PERF: 'Rendimiento',
  A11Y: 'Accesibilidad',
  SEO: 'SEO tecnico',
  DEPS: 'Dependencias',
  SEC: 'Seguridad',
  AGENT: 'Agent-readiness',
};

/**
 * Axes whose findings must be read with a stated caveat.
 *
 * AGENT is here because spec §5.1 requires it: "se reporta con su propio nivel,
 * declarando explicitamente que su impacto no esta probado". The caveat is
 * rendered on the axis card *and* in the axis section, so a reader who only
 * skims the grid still gets it, and it cannot be lost by scrolling past the
 * disclaimer block at the top.
 */
const AXIS_CAVEAT: Readonly<Record<string, string>> = {
  AGENT:
    'Impacto no probado. Este eje no se combina con ningun otro y su puntaje no debe leerse como un factor de posicionamiento demostrado: llms.txt, por ejemplo, esta clasificado por Google como mito.',
};

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: 'Critico',
  high: 'Alto',
  medium: 'Medio',
  low: 'Bajo',
  info: 'Informativo',
};

const CONFIDENCE_LABEL: Readonly<Record<string, string>> = {
  high: 'confianza alta',
  medium: 'confianza media',
  low: 'confianza baja',
};

/** Escapes text for both element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function axisLabel(axis: string): string {
  return AXIS_LABEL[axis] ?? axis;
}

function meaningOf(id: string): string {
  return requireEntry(id).detects;
}

function headlineOf(finding: FindingSummary): string {
  return finding.title ?? meaningOf(finding.id);
}

function evidenceRow(key: string, value: unknown): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(rendered ?? 'null')}</span></div>`;
}

function findingCard(finding: FindingSummary): string {
  const evidence = Object.entries(finding.evidence)
    .map(([key, value]) => evidenceRow(key, value))
    .join('');

  const affected =
    finding.affected.length === 0
      ? ''
      : `<p class="affected"><span class="k">Donde</span> ${finding.affected
          .map((path) => `<code>${escapeHtml(path)}</code>`)
          .join(' ')}</p>`;

  const docRef =
    finding.docRef === undefined
      ? ''
      : `<p class="doc"><a href="${escapeHtml(finding.docRef)}">Referencia</a></p>`;

  const badges = [
    `<span class="badge sev-${finding.severity}">${SEVERITY_LABEL[finding.severity]}</span>`,
    `<span class="badge conf">${CONFIDENCE_LABEL[finding.confidence] ?? finding.confidence}</span>`,
    finding.count > 1 ? `<span class="badge count">${finding.count} ocurrencias</span>` : '',
    finding.blocking ? '<span class="badge blocking">Bloqueante</span>' : '',
  ].join('');

  return [
    '<article class="finding">',
    `<header><h4>${escapeHtml(headlineOf(finding))}</h4><div class="badges">${badges}</div></header>`,
    `<p class="id"><code>${escapeHtml(finding.id)}</code> · ${escapeHtml(meaningOf(finding.id))}</p>`,
    affected,
    evidence === '' ? '' : `<div class="evidence">${evidence}</div>`,
    `<p class="fix"><span class="k">Como se corrige</span> ${escapeHtml(finding.remediation)}</p>`,
    docRef,
    '</article>',
  ].join('');
}

function findingList(findings: readonly FindingSummary[], empty: string): string {
  if (findings.length === 0) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
  }

  return findings.map(findingCard).join('');
}

/**
 * An axis whose probe never ran has no findings, and an axis with no findings
 * scores 100. Printing that number would turn a browser that failed to start
 * into a perfect result — the exact "reporte como certificado" failure spec §9
 * warns about. So a failed axis shows no score at all.
 */
function unmeasured(axis: AxisSummary): boolean {
  return axis.probe.status === 'failed';
}

function scoreMarkup(axis: AxisSummary): string {
  return unmeasured(axis)
    ? '<span class="axis-score unmeasured">sin medir</span>'
    : `<span class="axis-score">${axis.score}<small>/${axis.maxScore}</small></span>`;
}

function axisCard(axis: AxisSummary): string {
  const state = unmeasured(axis)
    ? 'unmeasured'
    : axis.zeroed
      ? 'zeroed'
      : axis.score >= 90
        ? 'good'
        : axis.score >= 70
          ? 'fair'
          : 'poor';
  const probe = unmeasured(axis)
    ? `<p class="probe-failed">Probe no disponible: ${escapeHtml(axis.probe.error ?? 'error desconocido')}</p>`
    : '';

  const caveat =
    AXIS_CAVEAT[axis.axis] === undefined
      ? ''
      : '<span class="axis-caveat">Impacto no probado</span>';

  return [
    `<a class="axis-card ${state}" href="#axis-${escapeHtml(axis.axis)}">`,
    `<span class="axis-name">${escapeHtml(axisLabel(axis.axis))}</span>`,
    scoreMarkup(axis),
    axis.zeroed ? '<span class="axis-note">Anulado por hallazgo bloqueante</span>' : '',
    `<span class="axis-meta">${axis.counts.scored} hallazgos puntuados</span>`,
    axis.probe.notes.length === 0
      ? ''
      : `<span class="axis-note limited">Cobertura parcial (${axis.probe.notes.length})</span>`,
    caveat,
    probe,
    '</a>',
  ].join('');
}

function deductionTable(axis: AxisSummary): string {
  if (axis.zeroed) {
    return `<p class="arithmetic">Puntaje fijado en 0 por: ${axis.zeroedBy
      .map((id) => `<code>${escapeHtml(id)}</code>`)
      .join(', ')}. No se promedia.</p>`;
  }

  if (axis.deductions.length === 0) {
    return '<p class="arithmetic">Sin deducciones: el eje conserva los 100 puntos.</p>';
  }

  const rows = axis.deductions
    .map(
      (deduction) =>
        `<tr><td><code>${escapeHtml(deduction.id)}</code></td><td>-${deduction.points}</td></tr>`,
    )
    .join('');

  return [
    '<table class="arithmetic-table">',
    '<caption>Como se calculo este puntaje</caption>',
    '<thead><tr><th>Hallazgo</th><th>Puntos</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    `<tfoot><tr><td>${axis.maxScore} - deducciones</td><td>${axis.score}</td></tr></tfoot>`,
    '</table>',
  ].join('');
}

/**
 * The tool line. It names the sub-tool versions too, because a Performance score
 * measured by a different Chrome build is not comparable to last quarter's and
 * the reader has no other way to notice (spec §9).
 */
function toolLine(axis: AxisSummary): string {
  const components = (axis.probe.components ?? [])
    .map((component) => `${component.name}@${component.version}`)
    .join(', ');

  const suffix = components === '' ? '' : ` (<code>${escapeHtml(components)}</code>)`;

  return `<p class="tool">Herramienta: <code>${escapeHtml(axis.probe.tool)}</code>${suffix} · estado <code>${escapeHtml(axis.probe.status)}</code></p>`;
}

/**
 * What the probe admits it did not check. Rendered next to the score rather than
 * in a footnote: a reader who does not see it will read the score as coverage.
 */
function coverageSection(axis: AxisSummary): string {
  if (axis.probe.notes.length === 0) {
    return '';
  }

  return [
    '<div class="coverage">',
    '<h3>Alcance de esta medicion</h3>',
    `<ul>${axis.probe.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`,
    '</div>',
  ].join('');
}

/**
 * The Performance axis gets a Lighthouse-style section on top of the generic
 * finding list. It is the one axis whose audience expects to see the numbers
 * themselves, not only the ones that crossed a threshold.
 *
 * Same guarantees as the rest of the report: no JS (native `<details>`), no
 * external requests (the gauge is inline SVG), and no combined axis score — the
 * gauge is Lighthouse's own, labelled as such, and never replaces the axis
 * score this report computes.
 */
const PERF_STATE_LABEL: Readonly<Record<MetricState, string>> = {
  good: 'Bueno',
  'needs-improvement': 'Mejorable',
  poor: 'Malo',
};

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function perfGauge(detail: PerfDetail): string {
  if (detail.score === null) {
    return '';
  }

  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dash = (detail.score / 100) * circumference;
  const color =
    detail.score >= 90 ? 'var(--good)' : detail.score >= 50 ? 'var(--medium)' : 'var(--critical)';

  return [
    '<div class="perf-gauge">',
    `<svg viewBox="0 0 120 120" role="img" aria-label="Score de Lighthouse: ${detail.score} sobre 100">`,
    `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="var(--line)" stroke-width="10"/>`,
    `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 60 60)"/>`,
    `<text x="60" y="60" class="perf-gauge-value" text-anchor="middle" dominant-baseline="central">${detail.score}</text>`,
    '</svg>',
    '<span class="perf-gauge-label">Score de Lighthouse</span>',
    '<span class="perf-gauge-note">Compone FCP, SI, LCP, TBT y CLS. No sustituye al puntaje del eje.</span>',
    '</div>',
  ].join('');
}

function perfMetricCard(metric: PerfMetric): string {
  return [
    `<div class="metric ${metric.state}">`,
    `<span class="metric-label">${escapeHtml(metric.label)} <code>${escapeHtml(metric.id)}</code></span>`,
    `<span class="metric-value">${escapeHtml(metric.display)}</span>`,
    `<span class="metric-state">${escapeHtml(PERF_STATE_LABEL[metric.state])}</span>`,
    metric.note === undefined ? '' : `<span class="metric-note">${escapeHtml(metric.note)}</span>`,
    '</div>',
  ].join('');
}

function perfExamples(examples: readonly string[] | undefined): string {
  if (examples === undefined || examples.length === 0) {
    return '';
  }

  return [
    '<details class="examples">',
    `<summary>Ver ejemplos (${examples.length})</summary>`,
    `<ul>${examples.map((example) => `<li><code>${escapeHtml(example)}</code></li>`).join('')}</ul>`,
    '</details>',
  ].join('');
}

function perfOpportunityItem(item: PerfOpportunity): string {
  const savings: string[] = [];
  if (item.savingsMs !== undefined && item.savingsMs > 0) {
    savings.push(`~${formatDuration(item.savingsMs)}`);
  }
  if (item.savingsKb !== undefined && item.savingsKb > 0) {
    savings.push(`~${item.savingsKb} KB`);
  }

  const savingsMarkup =
    savings.length === 0
      ? ''
      : `<span class="savings">Ahorro estimado: ${escapeHtml(savings.join(' / '))}</span>`;
  const count =
    item.count === undefined ? '' : `<span class="count">${item.count} recurso(s)</span>`;

  return `<li>${escapeHtml(item.title)}${savingsMarkup}${count}${perfExamples(item.examples)}</li>`;
}

function perfDiagnosticItem(item: PerfDiagnostic): string {
  const detail =
    item.detail === undefined ? '' : `<span class="count">${escapeHtml(item.detail)}</span>`;
  const count =
    item.count === undefined ? '' : `<span class="count">${item.count} elemento(s)</span>`;

  return `<li>${escapeHtml(item.title)}${detail}${count}${perfExamples(item.examples)}</li>`;
}

function perfBlock(title: string, items: readonly string[]): string {
  if (items.length === 0) {
    return '';
  }

  return [
    '<details class="perf-block">',
    `<summary>${escapeHtml(title)} (${items.length})</summary>`,
    `<ul class="perf-items">${items.join('')}</ul>`,
    '</details>',
  ].join('');
}

function perfSection(axis: AxisSummary): string {
  if (axis.axis !== 'PERF') {
    return '';
  }

  const detail = parsePerfDetail(axis.detail);

  if (detail === undefined) {
    return '';
  }

  return [
    '<div class="perf">',
    '<div class="perf-head">',
    perfGauge(detail),
    `<div class="metrics">${detail.metrics.map(perfMetricCard).join('')}</div>`,
    '</div>',
    perfBlock('Oportunidades', detail.opportunities.map(perfOpportunityItem)),
    perfBlock('Diagnosticos', detail.diagnostics.map(perfDiagnosticItem)),
    '</div>',
  ].join('');
}

function axisSection(axis: AxisSummary): string {
  const mentions =
    axis.mentions.length === 0
      ? ''
      : [
          '<h3>Mencionado desde otro eje</h3>',
          '<p class="hint">Estos hallazgos se puntuan en el eje que los posee. Aqui solo se listan por contexto.</p>',
          findingList(axis.mentions, ''),
        ].join('');

  const low =
    axis.lowConfidence.length === 0
      ? ''
      : [
          '<h3>Confianza baja</h3>',
          '<p class="hint">Se listan siempre, nunca se ocultan, y no afectan el puntaje.</p>',
          findingList(axis.lowConfidence, ''),
        ].join('');

  const caveatText = AXIS_CAVEAT[axis.axis];
  const caveat = caveatText === undefined ? '' : `<p class="caveat">${escapeHtml(caveatText)}</p>`;

  return [
    `<section class="axis" id="axis-${escapeHtml(axis.axis)}">`,
    '<header class="axis-header">',
    `<h2>${escapeHtml(axisLabel(axis.axis))} <span class="axis-code">${escapeHtml(axis.axis)}</span></h2>`,
    unmeasured(axis)
      ? '<p class="axis-score-inline unmeasured">sin medir</p>'
      : `<p class="axis-score-inline">${axis.score}<small>/${axis.maxScore}</small></p>`,
    '</header>',
    caveat,
    toolLine(axis),
    coverageSection(axis),
    perfSection(axis),
    deductionTable(axis),
    findingList(axis.findings, 'Sin hallazgos puntuados en este eje.'),
    mentions,
    low,
    '</section>',
  ].join('');
}

function coverSection(summary: Summary): string {
  if (summary.coverPage.length === 0) {
    return '<section class="cover ok"><h2>Sin hallazgos bloqueantes</h2><p>Ningun eje quedo anulado por un hallazgo critico marcado como bloqueante.</p></section>';
  }

  return [
    '<section class="cover alert">',
    `<h2>${summary.coverPage.length} hallazgo(s) bloqueante(s)</h2>`,
    '<p>Un hallazgo bloqueante fija su eje en 0 y sube a portada. No se promedia con el resto.</p>',
    summary.coverPage.map(findingCard).join(''),
    '</section>',
  ].join('');
}

function rejectedSection(summary: Summary): string {
  if (summary.rejected.length === 0) {
    return '';
  }

  const rows = summary.rejected
    .map(
      (rejection) =>
        `<tr><td><code>${escapeHtml(rejection.id)}</code></td><td>${escapeHtml(rejection.axis)}</td><td>${escapeHtml(rejection.reason)}</td><td>${escapeHtml(rejection.detail)}</td></tr>`,
    )
    .join('');

  return [
    '<section class="rejected">',
    '<h2>Observaciones descartadas</h2>',
    '<p class="hint">Un probe reporto algo que el catalogo no reconoce. Se muestra para que la omision sea visible.</p>',
    '<table><thead><tr><th>ID</th><th>Eje</th><th>Motivo</th><th>Detalle</th></tr></thead>',
    `<tbody>${rows}</tbody></table>`,
    '</section>',
  ].join('');
}

const STYLES = `
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#9198a1;--accent:#58a6ff;
--critical:#f85149;--high:#ff7b72;--medium:#d29922;--low:#8b949e;--info:#58a6ff;--good:#3fb950}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 4px}
h2{font-size:19px;margin:0 0 8px}
h3{font-size:15px;margin:28px 0 4px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
h4{font-size:15px;margin:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:#22272e;padding:1px 5px;border-radius:4px}
a{color:var(--accent)}
.target{color:var(--dim);margin:0 0 24px;font-size:13.5px}
.disclaimers{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--medium);border-radius:8px;padding:14px 18px;margin:0 0 28px}
.disclaimers ul{margin:0;padding-left:18px}
.disclaimers li{color:var(--dim);font-size:13.5px}
.cover{border:1px solid var(--line);border-radius:10px;padding:18px;margin:0 0 28px;background:var(--panel)}
.cover.alert{border-color:var(--critical)}
.cover.ok{border-color:var(--good)}
.axis-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 12px}
.axis-card{display:flex;flex-direction:column;gap:2px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);text-decoration:none;color:inherit}
.axis-card.good{border-left:3px solid var(--good)}
.axis-card.fair{border-left:3px solid var(--medium)}
.axis-card.poor{border-left:3px solid var(--high)}
.axis-card.zeroed{border-left:3px solid var(--critical)}
.axis-card.unmeasured{border-left:3px solid var(--line);opacity:.75}
.axis-score.unmeasured,.axis-score-inline.unmeasured{font-size:1rem;color:var(--muted)}
.axis-name{font-size:13px;color:var(--dim)}
.axis-score{font-size:30px;font-weight:600;line-height:1.1}
.axis-score small,.axis-score-inline small{font-size:14px;color:var(--dim);font-weight:400}
.axis-note{font-size:12px;color:var(--critical)}
.axis-meta{font-size:12px;color:var(--dim)}
.probe-failed{font-size:12px;color:var(--medium);margin:4px 0 0}
.axis-note.limited{color:var(--medium)}
.axis-caveat{font-size:11px;color:var(--medium);border:1px solid var(--medium);border-radius:999px;padding:1px 7px;align-self:flex-start;margin-top:4px}
.caveat{background:var(--panel);border:1px solid var(--medium);border-left:3px solid var(--medium);border-radius:8px;padding:10px 14px;margin:0 0 12px;color:var(--dim);font-size:13px}
.coverage{border:1px solid var(--line);border-left:3px solid var(--medium);border-radius:8px;background:var(--panel);padding:10px 16px;margin:0 0 14px}
.coverage h3{margin:0 0 4px}
.coverage ul{margin:0;padding-left:18px}
.coverage li{color:var(--dim);font-size:13px}
.no-composite{color:var(--dim);font-size:13px;margin:0 0 32px;border-top:1px dashed var(--line);padding-top:10px}
.axis{border-top:1px solid var(--line);padding-top:22px;margin-top:34px}
.axis-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.axis-code{color:var(--dim);font-size:13px;font-weight:400}
.axis-score-inline{font-size:26px;font-weight:600;margin:0}
.tool{color:var(--dim);font-size:12.5px;margin:0 0 12px}
.arithmetic{color:var(--dim);font-size:13px}
.arithmetic-table,.rejected table{width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px}
.arithmetic-table caption,.rejected caption{text-align:left;color:var(--dim);font-size:12px;padding-bottom:6px}
.arithmetic-table th,.arithmetic-table td,.rejected th,.rejected td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
.arithmetic-table tfoot td{font-weight:600;border-bottom:none}
.finding{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 10px}
.finding header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.badges{display:flex;gap:6px;flex-wrap:wrap}
.badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.badge.sev-critical{color:var(--critical);border-color:var(--critical)}
.badge.sev-high{color:var(--high);border-color:var(--high)}
.badge.sev-medium{color:var(--medium);border-color:var(--medium)}
.badge.sev-low{color:var(--low)}
.badge.sev-info{color:var(--info);border-color:var(--info)}
.badge.blocking{color:var(--critical);border-color:var(--critical);font-weight:600}
.finding .id{color:var(--dim);font-size:12.5px;margin:6px 0}
.evidence{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:10px 0;font-size:12.5px}
.kv{display:contents}
.k{color:var(--dim);text-transform:uppercase;font-size:11px;letter-spacing:.05em}
.v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.affected,.fix,.doc{font-size:13px;margin:6px 0 0}
.hint,.empty{color:var(--dim);font-size:13px}
footer{margin-top:48px;border-top:1px solid var(--line);padding-top:16px;color:var(--dim);font-size:12.5px}
footer table{border-collapse:collapse;font-size:12.5px;margin-top:8px}
footer td,footer th{text-align:left;padding:3px 14px 3px 0}
.perf{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:16px;margin:0 0 16px}
.perf-head{display:flex;gap:22px;align-items:center;flex-wrap:wrap}
.perf-gauge{display:flex;flex-direction:column;align-items:center;min-width:150px}
.perf-gauge svg{width:120px;height:120px}
.perf-gauge-value{font:600 34px ui-sans-serif,system-ui,sans-serif;fill:var(--fg)}
.perf-gauge-label{font-size:13px;color:var(--dim);margin-top:4px}
.perf-gauge-note{font-size:11px;color:var(--dim);text-align:center;margin-top:2px;max-width:180px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;flex:1}
.metric{display:flex;flex-direction:column;gap:2px;border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--bg)}
.metric.good{border-left-color:var(--good)}
.metric.needs-improvement{border-left-color:var(--medium)}
.metric.poor{border-left-color:var(--critical)}
.metric-label{font-size:11.5px;color:var(--dim)}
.metric-value{font-size:20px;font-weight:600}
.metric-state{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.metric.good .metric-state{color:var(--good)}
.metric.needs-improvement .metric-state{color:var(--medium)}
.metric.poor .metric-state{color:var(--critical)}
.metric-note{font-size:11px;color:var(--dim)}
.perf-block{margin-top:14px;border-top:1px solid var(--line);padding-top:8px}
.perf-block>summary{cursor:pointer;font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.perf-items{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.perf-items>li{border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}
.perf-items .savings{color:var(--medium);font-weight:600;margin-left:6px}
.perf-items .count{color:var(--dim);margin-left:6px}
.examples{margin-top:6px}
.examples>summary{cursor:pointer;color:var(--dim);font-size:12px}
.examples ul{margin:4px 0 0;padding-left:16px}
.examples li{margin:2px 0;word-break:break-word}
`;

/** Renders the whole report as one self-contained HTML document. */
export function renderReport(summary: Summary, meta: Meta): string {
  const toolRows = meta.tools
    .map(
      (tool) =>
        `<tr><td>${escapeHtml(tool.axis)}</td><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.version)}</td><td>${escapeHtml(tool.status)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeHtml(`${PROGRAM_NAME} ${VERSION}`)}">
<title>Diagnostico tecnico — ${escapeHtml(summary.target.url)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Diagnostico tecnico</h1>
<p class="target"><code>${escapeHtml(summary.target.url)}</code> · modo <code>${escapeHtml(summary.target.mode)}</code> · catalogo v${escapeHtml(summary.catalogVersion)} · ${escapeHtml(meta.run.finishedAt)}</p>

<div class="disclaimers"><ul>${summary.disclaimers.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div>

${coverSection(summary)}

<h2>Ejes evaluados</h2>
<div class="axis-grid">${summary.byAxis.map(axisCard).join('')}</div>
<p class="no-composite">Cada eje tiene su propio puntaje sobre ${summary.scoring.maxAxisScore}. No se publica un numero unico que los combine: promediarlos enterraria el hallazgo que importa.</p>

${summary.byAxis.map(axisSection).join('')}

${rejectedSection(summary)}

<footer>
<p>Generado por <code>${escapeHtml(PROGRAM_NAME)} ${escapeHtml(meta.webdiag)}</code> · catalogo <code>${escapeHtml(meta.catalogVersion)}</code> · ${escapeHtml(meta.run.durationMs.toString())} ms</p>
<table>
<thead><tr><th>Eje</th><th>Herramienta</th><th>Version</th><th>Estado</th></tr></thead>
<tbody>${toolRows}</tbody>
</table>
</footer>
</main>
</body>
</html>
`;
}
