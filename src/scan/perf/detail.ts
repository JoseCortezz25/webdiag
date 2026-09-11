/**
 * The Performance axis' presentation payload.
 *
 * Findings answer "what crossed a threshold"; this module answers "what did the
 * page score and how did it get there". That is the only thing a
 * Lighthouse-style section needs and the one thing findings cannot give back: a
 * metric under its threshold produces no finding at all, and an opportunity that
 * saved nothing is still an opportunity. Reconstructing the section from the
 * finding list would show a fraction of it.
 *
 * This is layer-1 knowledge and stays here. `raw.ts` carries the result opaquely
 * (`detail`) into `summary.json`, and the report renders it. The normalizer never
 * sees a single field of it, which is what keeps layer 2 axis-agnostic.
 *
 * **Thresholds.** LCP, CLS and TBT reuse the catalogue's own boundaries from
 * `observations.ts` as the "good" line, so a red metric and a finding agree by
 * construction. FCP, Speed Index and the "poor" line of every metric are the
 * published Core Web Vitals / Lighthouse thresholds: the catalogue does not
 * define them, so they are transcription of a public standard, not a second
 * invented rubric. They colour a card; they never emit a finding.
 */
import {
  type LighthouseReport,
  metricSaving,
  nodeSelector,
  numberField,
  numericValue,
  stringField,
  tableItems,
} from './lhr.ts';
import { THRESHOLDS } from './observations.ts';

/** Bumped only when a consumer would have to notice the nested shape change. */
export const PERF_DETAIL_SCHEMA = 'webdiag.perf/1';

export type MetricState = 'good' | 'needs-improvement' | 'poor';

export type PerfMetric = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly unit: 'ms' | 'score';
  /** At or below this value the metric is in the good bucket. */
  readonly good: number;
  /** Above this value the metric is in the poor bucket. */
  readonly poor: number;
  readonly state: MetricState;
  /** True only for the five metrics that compose the Lighthouse score. */
  readonly composesScore: boolean;
  readonly note?: string;
};

export type PerfOpportunity = {
  readonly title: string;
  readonly savingsMs?: number;
  readonly savingsKb?: number;
  readonly count?: number;
  readonly examples?: readonly string[];
};

export type PerfDiagnostic = {
  readonly title: string;
  readonly detail?: string;
  readonly count?: number;
  readonly examples?: readonly string[];
};

export type PerfDetail = {
  readonly schema: typeof PERF_DETAIL_SCHEMA;
  /** Lighthouse's 0–100 Performance score, or null when it did not run. */
  readonly score: number | null;
  readonly scoreState: MetricState | null;
  readonly metrics: readonly PerfMetric[];
  readonly opportunities: readonly PerfOpportunity[];
  readonly diagnostics: readonly PerfDiagnostic[];
};

/** How many offending resources/samples an item lists before it summarises. */
const EVIDENCE_SAMPLE = 5;

type MetricSpec = {
  readonly id: string;
  readonly label: string;
  readonly audit: string;
  readonly unit: 'ms' | 'score';
  readonly good: number;
  readonly poor: number;
  readonly note?: string;
  readonly composesScore: boolean;
};

/**
 * The order Lighthouse presents them in: the five score metrics first, then the
 * server metric, which informs but does not compose the score.
 */
const METRIC_SPECS: readonly MetricSpec[] = [
  {
    id: 'FCP',
    label: 'First Contentful Paint',
    audit: 'first-contentful-paint',
    unit: 'ms',
    good: 1800,
    poor: 3000,
    composesScore: true,
  },
  {
    id: 'LCP',
    label: 'Largest Contentful Paint',
    audit: 'largest-contentful-paint',
    unit: 'ms',
    good: THRESHOLDS.lcpMs,
    poor: 4000,
    composesScore: true,
  },
  {
    id: 'SI',
    label: 'Speed Index',
    audit: 'speed-index',
    unit: 'ms',
    good: 3400,
    poor: 5800,
    composesScore: true,
  },
  {
    id: 'TBT',
    label: 'Total Blocking Time',
    audit: 'total-blocking-time',
    unit: 'ms',
    good: THRESHOLDS.tbtMs,
    poor: 600,
    composesScore: true,
    note: 'Proxy de laboratorio para INP; no es INP.',
  },
  {
    id: 'CLS',
    label: 'Cumulative Layout Shift',
    audit: 'cumulative-layout-shift',
    unit: 'score',
    good: THRESHOLDS.cls,
    poor: 0.25,
    composesScore: true,
  },
  {
    id: 'TTFB',
    label: 'Time to First Byte',
    audit: 'server-response-time',
    unit: 'ms',
    good: THRESHOLDS.ttfbMs,
    poor: 1800,
    composesScore: false,
    note: 'No compone el score de Lighthouse.',
  },
];

type DiagnosticSpec = {
  readonly title: string;
  readonly audit: string;
};

const DIAGNOSTIC_SPECS: readonly DiagnosticSpec[] = [
  { title: 'Desglose del LCP', audit: 'lcp-breakdown-insight' },
  { title: 'Causas del layout shift', audit: 'cls-culprits-insight' },
  { title: 'Arbol de dependencias de red', audit: 'network-dependency-tree-insight' },
  { title: 'Reflujo forzado', audit: 'forced-reflow-insight' },
  { title: 'Trabajo del hilo principal', audit: 'mainthread-work-breakdown' },
  { title: 'Imagenes sin width/height', audit: 'unsized-images' },
];

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function stateOf(value: number, good: number, poor: number): MetricState {
  if (value <= good) {
    return 'good';
  }
  return value <= poor ? 'needs-improvement' : 'poor';
}

function displayOf(value: number, unit: 'ms' | 'score'): string {
  if (unit === 'score') {
    return String(Number(value.toFixed(3)));
  }

  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function metricOf(spec: MetricSpec, report: LighthouseReport): PerfMetric | undefined {
  const value = numericValue(report, spec.audit);

  if (value === undefined) {
    return undefined;
  }

  return {
    id: spec.id,
    label: spec.label,
    value: round(value, spec.unit === 'score' ? 3 : 0),
    display: displayOf(value, spec.unit),
    unit: spec.unit,
    good: spec.good,
    poor: spec.poor,
    state: stateOf(value, spec.good, spec.poor),
    composesScore: spec.composesScore,
    ...(spec.note === undefined ? {} : { note: spec.note }),
  };
}

function sumField(items: readonly Readonly<Record<string, unknown>>[], key: string): number {
  return items.reduce((total, item) => total + (numberField(item, key) ?? 0), 0);
}

function urlsOf(items: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  return items.flatMap((item) => {
    const url = stringField(item, 'url');
    return url === undefined ? [] : [url];
  });
}

/** `url` when present, otherwise the node selector Lighthouse attached. */
function labelsOf(items: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  const labels = items.flatMap((item) => {
    const url = stringField(item, 'url');
    if (url !== undefined) {
      return [url];
    }

    const selector = nodeSelector(item);
    return selector === undefined ? [] : [selector];
  });

  return [...new Set(labels)].slice(0, EVIDENCE_SAMPLE);
}

/** Lighthouse's own estimate for an audit, taking the first metric that moved. */
function saving(report: LighthouseReport, audit: string, metrics: readonly string[]): number {
  for (const metric of metrics) {
    const value = metricSaving(report, audit, metric);
    if (value > 0) {
      return value;
    }
  }

  return 0;
}

function renderBlocking(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'render-blocking-insight');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = saving(report, 'render-blocking-insight', ['FCP', 'LCP', 'TBT']);

  return {
    title: 'Eliminar recursos que bloquean el render',
    ...(savingsMs === 0 ? {} : { savingsMs: round(savingsMs) }),
    count: items.length,
    examples: labelsOf(items),
  };
}

function imageDelivery(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'image-delivery-insight');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = saving(report, 'image-delivery-insight', ['LCP', 'FCP']);
  const savingsKb = round(sumField(items, 'wastedBytes') / 1024);

  return {
    title: 'Mejorar la entrega de imagenes',
    ...(savingsMs === 0 ? {} : { savingsMs: round(savingsMs) }),
    ...(savingsKb === 0 ? {} : { savingsKb }),
    count: items.length,
    examples: labelsOf(items),
  };
}

function unusedJavaScript(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'unused-javascript');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = round(sumField(items, 'wastedMs'));
  const savingsKb = round(sumField(items, 'wastedBytes') / 1024);

  return {
    title: 'Reducir el JavaScript sin usar',
    ...(savingsMs === 0 ? {} : { savingsMs }),
    ...(savingsKb === 0 ? {} : { savingsKb }),
    count: items.length,
    examples: labelsOf(items),
  };
}

function unusedCss(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'unused-css-rules');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = saving(report, 'unused-css-rules', ['LCP', 'FCP']);
  const savingsKb = round(sumField(items, 'wastedBytes') / 1024);

  return {
    title: 'Reducir el CSS sin usar',
    ...(savingsMs === 0 ? {} : { savingsMs: round(savingsMs) }),
    ...(savingsKb === 0 ? {} : { savingsKb }),
    count: items.length,
    examples: labelsOf(items),
  };
}

function cachePolicy(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'cache-insight');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = saving(report, 'cache-insight', ['LCP', 'FCP']);

  return {
    title: 'Aumentar la vida util de la cache',
    ...(savingsMs === 0 ? {} : { savingsMs: round(savingsMs) }),
    count: items.length,
    examples: urlsOf(items).slice(0, EVIDENCE_SAMPLE),
  };
}

function documentLatency(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'document-latency-insight');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = saving(report, 'document-latency-insight', ['FCP', 'LCP']);

  return {
    title: 'Reducir la latencia del documento',
    ...(savingsMs === 0 ? {} : { savingsMs: round(savingsMs) }),
    count: items.length,
    examples: urlsOf(items).slice(0, EVIDENCE_SAMPLE),
  };
}

function thirdParties(report: LighthouseReport): PerfOpportunity | undefined {
  const items = tableItems(report, 'third-parties-insight');

  if (items.length === 0) {
    return undefined;
  }

  const savingsMs = saving(report, 'third-parties-insight', ['TBT', 'LCP']);

  return {
    title: 'Reducir el impacto de terceros',
    ...(savingsMs === 0 ? {} : { savingsMs: round(savingsMs) }),
    count: items.length,
    examples: labelsOf(items),
  };
}

function opportunities(report: LighthouseReport): readonly PerfOpportunity[] {
  const candidates: readonly (PerfOpportunity | undefined)[] = [
    renderBlocking(report),
    imageDelivery(report),
    unusedJavaScript(report),
    unusedCss(report),
    cachePolicy(report),
    documentLatency(report),
    thirdParties(report),
  ];

  return candidates.filter((item): item is PerfOpportunity => item !== undefined);
}

function tableDiagnostics(report: LighthouseReport): readonly PerfDiagnostic[] {
  return DIAGNOSTIC_SPECS.flatMap((spec) => {
    const items = tableItems(report, spec.audit);

    if (items.length === 0) {
      return [];
    }

    return [
      {
        title: spec.title,
        count: items.length,
        ...(labelsOf(items).length === 0 ? {} : { examples: labelsOf(items) }),
      },
    ];
  });
}

function numericDiagnostics(report: LighthouseReport): readonly PerfDiagnostic[] {
  const diagnostics: PerfDiagnostic[] = [];

  const bootup = tableItems(report, 'bootup-time');
  const bootupMs = round(sumField(bootup, 'total'));

  if (bootup.length > 0) {
    diagnostics.push({
      title: 'Tiempo de ejecucion de JavaScript',
      ...(bootupMs === 0 ? {} : { detail: `${bootupMs} ms` }),
      count: bootup.length,
      ...(labelsOf(bootup).length === 0 ? {} : { examples: labelsOf(bootup) }),
    });
  }

  const domSize = numericValue(report, 'dom-size');

  if (domSize !== undefined) {
    diagnostics.push({ title: 'Tamano del DOM', detail: `${Math.round(domSize)} elementos` });
  }

  return diagnostics;
}

function scoreOf(report: LighthouseReport): number | null {
  const score = report.categories?.performance?.score;
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

/** Higher is better for the score, so it cannot reuse the lower-is-better band. */
function scoreStateOf(score: number | null): MetricState | null {
  if (score === null) {
    return null;
  }
  if (score >= 90) {
    return 'good';
  }
  return score >= 50 ? 'needs-improvement' : 'poor';
}

/** Maps one Lighthouse result onto the Performance section payload. Pure and total. */
export function perfDetail(report: LighthouseReport): PerfDetail {
  const score = scoreOf(report);

  return {
    schema: PERF_DETAIL_SCHEMA,
    score,
    scoreState: scoreStateOf(score),
    metrics: METRIC_SPECS.flatMap((spec) => {
      const metric = metricOf(spec, report);
      return metric === undefined ? [] : [metric];
    }),
    opportunities: opportunities(report),
    diagnostics: [...tableDiagnostics(report), ...numericDiagnostics(report)],
  };
}

/**
 * Reads the payload back before the report renders it. `raw.ts` carries it as
 * `unknown` on purpose, so the one place that needs its shape validates it here
 * instead of trusting a cast.
 */
export function parsePerfDetail(input: unknown): PerfDetail | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as Partial<PerfDetail>;

  if (
    candidate.schema !== PERF_DETAIL_SCHEMA ||
    !Array.isArray(candidate.metrics) ||
    !Array.isArray(candidate.opportunities) ||
    !Array.isArray(candidate.diagnostics)
  ) {
    return undefined;
  }

  return candidate as PerfDetail;
}
