/**
 * Field data from the Chrome UX Report, and the finding for when there is none.
 *
 * Spec §5.1 lists CrUX as optional for the Performance axis, and it has to be:
 * the API needs a key, and most of the sites this tool is pointed at do not have
 * enough traffic to appear in the dataset at all. That is precisely why
 * `PERF-FIELD-UNAVAILABLE` exists — spec §6 names it as one of the three
 * findings that "existen solo para que el reporte no mienta". Without it a
 * report full of lab numbers reads as if it described real users.
 *
 * Nothing here throws. A missing key, a rate limit and an origin with no traffic
 * are all the same outcome to the reader — the field column is empty — and none
 * of them is a reason to lose the lab measurements we did get.
 */

export type FieldMetrics = {
  /** p75 across the origin's real users, in ms (`cls` is unitless). */
  readonly lcp?: number;
  readonly cls?: number;
  readonly inp?: number;
  readonly ttfb?: number;
};

export type FieldData =
  | { readonly available: false; readonly reason: string }
  | { readonly available: true; readonly source: 'CrUX'; readonly metrics: FieldMetrics };

const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

/** Values above these are "poor" in CrUX terms; they escalate lab confidence. */
export const FIELD_POOR = { lcp: 4000, cls: 0.25, inp: 500, ttfb: 1800 } as const;

/**
 * Just the call this module makes. Narrower than `typeof fetch` on purpose: the
 * runtime's own type carries extras (Bun adds `preconnect`) that a test double
 * would have to stub for no reason.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CruxOptions = {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: FetchLike;
};

function percentile(record: unknown, metric: string): number | undefined {
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }

  const entry = (record as Record<string, unknown>)[metric];

  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }

  const p75 = (entry as { percentiles?: { p75?: unknown } }).percentiles?.p75;

  if (typeof p75 === 'number') {
    return p75;
  }

  // CrUX returns CLS percentiles as strings ("0.08"); everything else as numbers.
  return typeof p75 === 'string' && p75.trim() !== '' ? Number(p75) : undefined;
}

function metricsOf(payload: unknown): FieldMetrics {
  const metrics =
    typeof payload === 'object' && payload !== null
      ? (payload as { record?: { metrics?: unknown } }).record?.metrics
      : undefined;

  return {
    ...defined('lcp', percentile(metrics, 'largest_contentful_paint')),
    ...defined('cls', percentile(metrics, 'cumulative_layout_shift')),
    ...defined('inp', percentile(metrics, 'interaction_to_next_paint')),
    ...defined('ttfb', percentile(metrics, 'experimental_time_to_first_byte')),
  };
}

function defined(key: keyof FieldMetrics, value: number | undefined): Partial<FieldMetrics> {
  return value === undefined || Number.isNaN(value) ? {} : { [key]: value };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Asks CrUX for the origin's field data. Returns why it could not, rather than
 * failing, so the caller always has something to put in the report.
 */
export async function fetchFieldData(options: CruxOptions): Promise<FieldData> {
  const apiKey = options.apiKey;

  if (apiKey === undefined || apiKey === '') {
    return {
      available: false,
      reason:
        'No se consulto CrUX: falta la API key (WEBDIAG_CRUX_API_KEY). Los numeros de este eje son de laboratorio.',
    };
  }

  const request = options.fetchImpl ?? fetch;

  try {
    const origin = new URL(options.url).origin;
    const response = await request(`${CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin, formFactor: 'PHONE' }),
    });

    if (response.status === 404) {
      return {
        available: false,
        reason: `CrUX no tiene datos para ${origin}: el origen no acumula trafico suficiente.`,
      };
    }

    if (!response.ok) {
      return {
        available: false,
        reason: `CrUX respondio ${response.status}: no se pudieron obtener datos de campo.`,
      };
    }

    const metrics = metricsOf(await response.json());

    if (Object.keys(metrics).length === 0) {
      return {
        available: false,
        reason: `CrUX respondio sin metricas utilizables para ${origin}.`,
      };
    }

    return { available: true, source: 'CrUX', metrics };
  } catch (cause) {
    return {
      available: false,
      reason: `No se pudo consultar CrUX: ${messageOf(cause)}`,
    };
  }
}
