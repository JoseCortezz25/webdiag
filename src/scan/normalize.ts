/**
 * Layer 2 (spec §4): raw documents in, `findings.json` out. No IA, no network,
 * no clock — the same input must always produce the same bytes, because the
 * whole "¿mejoró desde la última auditoría?" promise rests on it.
 *
 * Three things happen here and nowhere else:
 *
 *  1. **Catalogue admission.** An observation is a claim; only the catalogue can
 *     turn it into a finding. Unknown, deprecated or malformed observations are
 *     rejected and reported — never thrown, because a drifting probe must not
 *     take down a run that six other probes completed (spec §7).
 *  2. **Merge.** "Un hallazgo repetido en N páginas es uno con `count: N`"
 *     (spec §6). Two observations of the same ID become one finding.
 *  3. **Order.** The output is sorted by a total order over (owning axis,
 *     severity, id), so the file does not depend on which probe finished first.
 */
import type { Axis, Confidence, Finding, Severity } from '../catalog/index.ts';
import {
  AXES,
  CONFIDENCE_LEVELS,
  createFinding,
  isCatalogId,
  isDeprecated,
  ownerAxisOf,
  SEVERITIES,
} from '../catalog/index.ts';
import type { RawDocument, RawObservation } from './raw.ts';

export type RejectionReason = 'unknown-id' | 'deprecated-id' | 'invalid-observation';

export type RejectedObservation = {
  readonly id: string;
  readonly axis: Axis;
  readonly reason: RejectionReason;
  readonly detail: string;
};

export type NormalizedRun = {
  readonly findings: readonly Finding[];
  /**
   * Observations the catalogue refused. Surfaced in `summary.json` so a probe
   * that drifted is visible instead of silently producing a shorter report.
   */
  readonly rejected: readonly RejectedObservation[];
};

const AXIS_ORDER = new Map(AXES.map((axis, index) => [axis, index]));
const SEVERITY_ORDER = new Map(SEVERITIES.map((severity, index) => [severity, index]));
const CONFIDENCE_ORDER = new Map(CONFIDENCE_LEVELS.map((level, index) => [level, index]));

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.get(severity) ?? SEVERITIES.length;
}

function axisRank(axis: Axis): number {
  return AXIS_ORDER.get(axis) ?? AXES.length;
}

/** Lower is more certain: `CONFIDENCE_LEVELS` runs high → low. */
function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_ORDER.get(confidence) ?? CONFIDENCE_LEVELS.length;
}

/** Byte order, not locale order: `localeCompare` would make output machine-dependent. */
function compareIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** `probe:seo`, `probe:a11y`. Records which layer-1 unit produced the finding. */
function sourceFor(axis: Axis): string {
  return `probe:${axis.toLowerCase()}`;
}

function toFinding(document: RawDocument, observation: RawObservation): Finding {
  return createFinding({
    id: observation.id,
    confidence: observation.confidence,
    count: observation.count,
    affected: observation.affected,
    evidence: observation.evidence,
    source: sourceFor(document.axis),
    tool: `${document.tool.name}@${document.tool.version}`,
    mode: document.target.mode,
    remediation: observation.remediation,
    ...(observation.severity === undefined ? {} : { severity: observation.severity }),
    ...(observation.doc_ref === undefined ? {} : { doc_ref: observation.doc_ref }),
    ...(observation.title === undefined ? {} : { title: observation.title }),
  });
}

/**
 * Folds a second occurrence of the same ID into the first.
 *
 * The merge is intentionally conservative: the finding ends up as severe as its
 * worst occurrence and as certain as its most certain one, because a probe that
 * was sure once has already established the finding is real. Evidence keys from
 * the first occurrence win, so the result does not depend on document order for
 * anything except which extra keys survive.
 */
function merge(base: Finding, next: Finding): Finding {
  const affected = [...new Set([...base.affected, ...next.affected])].sort();

  const severity =
    severityRank(next.severity) < severityRank(base.severity) ? next.severity : base.severity;
  const confidence =
    confidenceRank(next.confidence) < confidenceRank(base.confidence)
      ? next.confidence
      : base.confidence;

  return {
    ...base,
    severity,
    confidence,
    count: base.count + next.count,
    affected,
    evidence: { ...next.evidence, ...base.evidence },
    ...(base.title === undefined && next.title !== undefined ? { title: next.title } : {}),
  };
}

/** Total order over findings. Independent of probe completion order. */
function compare(left: Finding, right: Finding): number {
  const byAxis = axisRank(ownerAxisOf(left.id)) - axisRank(ownerAxisOf(right.id));
  if (byAxis !== 0) {
    return byAxis;
  }

  const bySeverity = severityRank(left.severity) - severityRank(right.severity);
  if (bySeverity !== 0) {
    return bySeverity;
  }

  return compareIds(left.id, right.id);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function normalize(documents: readonly RawDocument[]): NormalizedRun {
  const merged = new Map<string, Finding>();
  const rejected: RejectedObservation[] = [];

  for (const document of documents) {
    for (const observation of document.observations) {
      if (!isCatalogId(observation.id)) {
        rejected.push({
          id: observation.id,
          axis: document.axis,
          reason: 'unknown-id',
          detail: 'The ID is not published in this catalog version.',
        });
        continue;
      }

      if (isDeprecated(observation.id)) {
        rejected.push({
          id: observation.id,
          axis: document.axis,
          reason: 'deprecated-id',
          detail: 'The ID is retired; a new run must not emit it.',
        });
        continue;
      }

      let finding: Finding;

      try {
        finding = toFinding(document, observation);
      } catch (cause) {
        rejected.push({
          id: observation.id,
          axis: document.axis,
          reason: 'invalid-observation',
          detail: messageOf(cause),
        });
        continue;
      }

      const existing = merged.get(finding.id);
      merged.set(finding.id, existing === undefined ? finding : merge(existing, finding));
    }
  }

  return {
    findings: [...merged.values()].sort(compare),
    rejected: rejected.sort(
      (left, right) => axisRank(left.axis) - axisRank(right.axis) || compareIds(left.id, right.id),
    ),
  };
}
