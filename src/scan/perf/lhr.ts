/**
 * A narrow, structural view of the Lighthouse result.
 *
 * Lighthouse's own `Result` type describes every audit Lighthouse has ever
 * shipped. Depending on it would couple the mapper to a surface it does not use
 * and make a fixture in a test impossible to write by hand. What the mapper
 * actually needs is four fields per audit, so that is what this declares.
 *
 * The reads below are deliberately defensive. Lighthouse 13 moved most
 * opportunity audits behind `*-insight` IDs, and it will move them again; an
 * audit that disappeared must produce "we saw nothing", never a crash that costs
 * the run its whole Performance axis.
 */

/** Audits that could not run report `scoreDisplayMode: 'error'` and no value. */
export type LighthouseAudit = {
  readonly score?: number | null;
  readonly scoreDisplayMode?: string;
  readonly numericValue?: number;
  readonly errorMessage?: string;
  readonly metricSavings?: Readonly<Record<string, number | undefined>>;
  readonly details?: unknown;
};

export type LighthouseReport = {
  readonly lighthouseVersion: string;
  readonly requestedUrl?: string;
  readonly finalDisplayedUrl?: string;
  /** Set when the page never loaded. The whole report is unusable then. */
  readonly runtimeError?: { readonly code: string; readonly message: string };
  readonly categories?: Readonly<Record<string, { readonly score?: number | null } | undefined>>;
  readonly audits?: Readonly<Record<string, LighthouseAudit | undefined>>;
};

export type TableItem = Readonly<Record<string, unknown>>;

export function auditOf(report: LighthouseReport, id: string): LighthouseAudit | undefined {
  return report.audits?.[id];
}

/** The audit's number, or `undefined` when the audit errored or is missing. */
export function numericValue(report: LighthouseReport, id: string): number | undefined {
  const audit = auditOf(report, id);

  if (audit === undefined || audit.scoreDisplayMode === 'error') {
    return undefined;
  }

  return typeof audit.numericValue === 'number' ? audit.numericValue : undefined;
}

/** Rows of a `table` or `opportunity` details block. Empty when absent. */
export function tableItems(report: LighthouseReport, id: string): readonly TableItem[] {
  const details = auditOf(report, id)?.details;

  if (typeof details !== 'object' || details === null) {
    return [];
  }

  const items = (details as { items?: unknown }).items;

  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter((item): item is TableItem => typeof item === 'object' && item !== null);
}

/** Lighthouse's own estimate of the milliseconds a fix would return. */
export function metricSaving(report: LighthouseReport, id: string, metric: string): number {
  const saving = auditOf(report, id)?.metricSavings?.[metric];
  return typeof saving === 'number' ? saving : 0;
}

export function stringField(item: TableItem, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(item: TableItem, key: string): number | undefined {
  const value = item[key];
  return typeof value === 'number' ? value : undefined;
}

/** The `node` sub-object Lighthouse attaches to element-level findings. */
export function nodeSelector(item: TableItem, key = 'node'): string | undefined {
  const node = item[key];

  if (typeof node !== 'object' || node === null) {
    return undefined;
  }

  const selector = (node as { selector?: unknown }).selector;
  return typeof selector === 'string' ? selector : undefined;
}
