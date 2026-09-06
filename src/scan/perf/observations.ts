/**
 * Lighthouse result → catalogue observations.
 *
 * This is the adapter `raw.ts` describes: Lighthouse keeps producing whatever
 * Lighthouse produces, and exactly one module knows how to read it. The
 * normalizer never learns a second vocabulary, and when Lighthouse renames its
 * audits again — 13 already moved most opportunities behind `*-insight` IDs —
 * this file is the only one that changes.
 *
 * Two rules shape every mapping below.
 *
 * **Thresholds come from the catalogue, not from Lighthouse's scores.** A
 * Lighthouse audit score of 0.42 means nothing to a client, and it bakes in
 * Google's own curve. `PERF-LCP-POOR` is published as "LCP por encima de 2.5s",
 * so the check is `lcp > 2500` and the evidence carries both numbers.
 *
 * **Confidence is not a second severity.** It answers "how sure are we this is
 * real", which for a single throttled lab load is: sure when the metric is well
 * past the threshold, less sure when it is sitting on it — one more run could
 * land on the other side. Field data, when we have it, settles the question,
 * because real users are not a simulation. `PERF-TBT-HIGH` is capped at medium
 * whatever the numbers say: the catalogue itself notes TBT is a proxy for INP
 * and "no es INP, hay que decirlo en el reporte".
 */
import type { Confidence } from '../../catalog/index.ts';
import type { RawObservation } from '../raw.ts';
import { FIELD_POOR, type FieldData } from './crux.ts';
import {
  type LighthouseReport,
  metricSaving,
  nodeSelector,
  numberField,
  numericValue,
  stringField,
  tableItems,
} from './lhr.ts';

/** Catalogue thresholds, transcribed from `docs/inbox/findings-catalog.md` §4. */
export const THRESHOLDS = {
  lcpMs: 2500,
  cls: 0.1,
  tbtMs: 200,
  ttfbMs: 800,
} as const;

/** Past this multiple of the threshold, one noisy run cannot explain the result. */
const DECISIVE = 1.2;

/** How many offending resources the evidence lists before it summarises. */
const EVIDENCE_SAMPLE = 5;

export type ObservationInput = {
  readonly report: LighthouseReport;
  /** Path the finding is attributed to, e.g. `/` or `/servicios`. */
  readonly path: string;
  readonly field: FieldData;
};

function fieldMetric(field: FieldData, key: 'lcp' | 'cls' | 'inp' | 'ttfb'): number | undefined {
  return field.available ? field.metrics[key] : undefined;
}

/**
 * How sure we are the metric is genuinely over the line. Field data outranks the
 * lab: if real users are in the poor bucket, no amount of lab variance matters.
 */
function labConfidence(
  value: number,
  threshold: number,
  field: number | undefined,
  poor: number,
): Confidence {
  if (field !== undefined && field >= poor) {
    return 'high';
  }

  return value >= threshold * DECISIVE ? 'high' : 'medium';
}

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sample(urls: readonly string[]): readonly string[] {
  return urls.slice(0, EVIDENCE_SAMPLE);
}

function urlsOf(items: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  return items.flatMap((item) => {
    const url = stringField(item, 'url');
    return url === undefined ? [] : [url];
  });
}

function withField(
  evidence: Record<string, unknown>,
  field: FieldData,
  key: 'lcp' | 'cls' | 'inp' | 'ttfb',
): Record<string, unknown> {
  const value = fieldMetric(field, key);
  return value === undefined ? evidence : { ...evidence, [`field_${key}_p75`]: value };
}

function lcp(input: ObservationInput): RawObservation | undefined {
  const value = numericValue(input.report, 'largest-contentful-paint');

  if (value === undefined || value <= THRESHOLDS.lcpMs) {
    return undefined;
  }

  const [element] = tableItems(input.report, 'lcp-breakdown-insight').flatMap((item) => {
    const selector = nodeSelector(item);
    return selector === undefined ? [] : [selector];
  });

  return {
    id: 'PERF-LCP-POOR',
    confidence: labConfidence(
      value,
      THRESHOLDS.lcpMs,
      fieldMetric(input.field, 'lcp'),
      FIELD_POOR.lcp,
    ),
    count: 1,
    affected: [input.path],
    evidence: withField(
      {
        lcp_ms: round(value),
        threshold_ms: THRESHOLDS.lcpMs,
        ...(element === undefined ? {} : { element }),
      },
      input.field,
      'lcp',
    ),
    remediation:
      'Precargar el recurso LCP, servir la imagen en AVIF/WebP dimensionada al viewport y eliminar lo que retrase su descubrimiento.',
    title: `El contenido principal tarda ${round(value / 1000, 1)}s en aparecer`,
  };
}

function cls(input: ObservationInput): RawObservation | undefined {
  const value = numericValue(input.report, 'cumulative-layout-shift');

  if (value === undefined || value <= THRESHOLDS.cls) {
    return undefined;
  }

  const culprits = sample(urlsOf(tableItems(input.report, 'cls-culprits-insight')));

  return {
    id: 'PERF-CLS-POOR',
    confidence: labConfidence(
      value,
      THRESHOLDS.cls,
      fieldMetric(input.field, 'cls'),
      FIELD_POOR.cls,
    ),
    count: 1,
    affected: [input.path],
    evidence: withField(
      {
        cls: round(value, 3),
        threshold: THRESHOLDS.cls,
        ...(culprits.length === 0 ? {} : { culprits }),
      },
      input.field,
      'cls',
    ),
    remediation:
      'Reservar espacio para imagenes, anuncios y fuentes: declarar width/height o aspect-ratio y evitar insertar contenido por encima de lo ya pintado.',
  };
}

function tbt(input: ObservationInput): RawObservation | undefined {
  const value = numericValue(input.report, 'total-blocking-time');

  if (value === undefined || value <= THRESHOLDS.tbtMs) {
    return undefined;
  }

  return {
    id: 'PERF-TBT-HIGH',
    // Capped on purpose: TBT is the lab proxy for INP, never INP itself.
    confidence: 'medium',
    count: 1,
    affected: [input.path],
    evidence: withField(
      {
        tbt_ms: round(value),
        threshold_ms: THRESHOLDS.tbtMs,
        note: 'TBT es un proxy de laboratorio para INP; no es INP.',
      },
      input.field,
      'inp',
    ),
    remediation:
      'Dividir el bundle principal, diferir el JS de terceros y romper las tareas largas del hilo principal.',
  };
}

function ttfb(input: ObservationInput): RawObservation | undefined {
  const value = numericValue(input.report, 'server-response-time');

  if (value === undefined || value <= THRESHOLDS.ttfbMs) {
    return undefined;
  }

  return {
    id: 'PERF-TTFB-SLOW',
    confidence: labConfidence(
      value,
      THRESHOLDS.ttfbMs,
      fieldMetric(input.field, 'ttfb'),
      FIELD_POOR.ttfb,
    ),
    count: 1,
    affected: [input.path],
    evidence: withField(
      { ttfb_ms: round(value), threshold_ms: THRESHOLDS.ttfbMs },
      input.field,
      'ttfb',
    ),
    remediation:
      'Cachear la respuesta HTML en el borde, revisar consultas lentas del backend y activar compresion en el documento.',
  };
}

/**
 * Images. Two audits feed one finding because the client's question is "are my
 * images a problem", not "which of Lighthouse's four image audits fired".
 *
 * The byte savings are measured, so they carry high confidence. An unsized image
 * is inferred from markup and a CSS `aspect-ratio` can make it a false positive,
 * so on its own it only earns medium.
 */
function images(input: ObservationInput): RawObservation | undefined {
  const delivery = tableItems(input.report, 'image-delivery-insight');
  const unsized = tableItems(input.report, 'unsized-images');

  if (delivery.length === 0 && unsized.length === 0) {
    return undefined;
  }

  const wastedBytes = delivery.reduce(
    (total, item) => total + (numberField(item, 'wastedBytes') ?? 0),
    0,
  );

  const affectedImages = new Set([...urlsOf(delivery), ...urlsOf(unsized)]);
  const count = Math.max(affectedImages.size, delivery.length + unsized.length, 1);

  return {
    id: 'PERF-IMG-UNOPTIMIZED',
    confidence: wastedBytes > 0 ? 'high' : 'medium',
    count,
    affected: [input.path],
    evidence: {
      images_with_savings: delivery.length,
      images_without_dimensions: unsized.length,
      wasted_kb: round(wastedBytes / 1024),
      examples: sample([...affectedImages]),
    },
    remediation:
      'Servir las imagenes en AVIF/WebP a la resolucion que realmente se muestra y declarar width/height en cada una.',
  };
}

function renderBlocking(input: ObservationInput): RawObservation | undefined {
  const items = tableItems(input.report, 'render-blocking-insight');

  if (items.length === 0) {
    return undefined;
  }

  const savedMs = metricSaving(input.report, 'render-blocking-insight', 'FCP');

  return {
    id: 'PERF-RENDER-BLOCKING',
    confidence: 'high',
    count: items.length,
    affected: [input.path],
    evidence: {
      resources: items.length,
      estimated_fcp_savings_ms: round(savedMs),
      examples: sample(urlsOf(items)),
    },
    remediation:
      'Inlinear el CSS critico y cargar el resto con media/print o defer; mover el JS que no pinta a defer o type="module".',
  };
}

function cachePolicy(input: ObservationInput): RawObservation | undefined {
  const items = tableItems(input.report, 'cache-insight');

  if (items.length === 0) {
    return undefined;
  }

  const worst = [...items]
    .sort(
      (left, right) =>
        (numberField(left, 'cacheLifetimeMs') ?? 0) - (numberField(right, 'cacheLifetimeMs') ?? 0),
    )
    .slice(0, EVIDENCE_SAMPLE)
    .map((item) => ({
      url: stringField(item, 'url') ?? 'desconocido',
      cache_lifetime_ms: numberField(item, 'cacheLifetimeMs') ?? 0,
    }));

  return {
    id: 'PERF-NO-CACHE-POLICY',
    confidence: 'high',
    count: items.length,
    affected: [input.path],
    evidence: { resources: items.length, shortest_ttl: worst },
    remediation:
      'Servir los estaticos con nombre versionado y Cache-Control: public, max-age=31536000, immutable.',
  };
}

/**
 * Always emitted when there is no field data. Spec §6 puts this finding in the
 * same class as `A11Y-MANUAL-REVIEW-PENDING`: it exists so nobody reads a page
 * of lab numbers as a description of what real users experience.
 */
function fieldUnavailable(input: ObservationInput): RawObservation | undefined {
  if (input.field.available) {
    return undefined;
  }

  return {
    id: 'PERF-FIELD-UNAVAILABLE',
    confidence: 'high',
    count: 1,
    affected: [input.path],
    evidence: { source: 'CrUX', reason: input.field.reason },
    remediation:
      'Ninguna: es una limitacion de la medicion, no un defecto del sitio. Los numeros de este eje son de laboratorio y no describen a los usuarios reales.',
  };
}

const RULES: readonly ((input: ObservationInput) => RawObservation | undefined)[] = [
  lcp,
  cls,
  tbt,
  ttfb,
  images,
  renderBlocking,
  cachePolicy,
  fieldUnavailable,
];

/** Maps one Lighthouse result onto catalogue observations. Pure and total. */
export function perfObservations(input: ObservationInput): readonly RawObservation[] {
  return RULES.flatMap((rule) => {
    const observation = rule(input);
    return observation === undefined ? [] : [observation];
  });
}
