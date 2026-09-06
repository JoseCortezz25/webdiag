/**
 * `summary.json` — the only file layer 3 is allowed to read (spec §4).
 *
 * That constraint is what shapes this module. The agent never sees a Lighthouse
 * dump, so anything it needs to write a client report has to be here: evidence,
 * affected paths, remediation, and the arithmetic behind every axis score.
 *
 * What is deliberately *absent* is a single number. Spec §5.1 resolved it on
 * 2026-09-06: there is no weighted composite across the six axes. `scoring`
 * states the model explicitly rather than leaving its absence to be guessed —
 * and, worse, filled in downstream.
 */
import type { Axis, AxisScore, Deduction, Finding, Mode, Severity } from '../catalog/index.ts';
import {
  AXES,
  CATALOG_VERSION,
  coverPageFindings,
  isBlocking,
  lowConfidenceFindings,
  MAX_AXIS_SCORE,
  ownerAxisOf,
  SEVERITIES,
  scoreAxes,
} from '../catalog/index.ts';
import type { RejectedObservation } from './normalize.ts';
import type { ProbeOutcome } from './probe.ts';

export const SUMMARY_SCHEMA_VERSION = 'webdiag.summary/1';

/** Disclaimers the report must carry. Spec §9: the score is not a certificate. */
export const DISCLAIMERS: readonly string[] = [
  'Cada eje se evalua de forma independiente. No existe un puntaje unico que combine los seis.',
  'Un diagnostico automatizado no sustituye una auditoria formal: cerca del 43% de los criterios WCAG exige revision humana.',
  'Este informe no emite juicios legales de cumplimiento (EAA, ADA) ni incluye escaneo activo de seguridad.',
  'Los hallazgos con confianza baja se listan aparte y no afectan ningun puntaje.',
];

export type FindingSummary = {
  readonly id: string;
  readonly title: string | undefined;
  readonly severity: Severity;
  readonly confidence: Finding['confidence'];
  readonly count: number;
  readonly affected: readonly string[];
  readonly remediation: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly tool: string;
  /** The axis that scores it, which is not always the axis of the ID prefix. */
  readonly ownerAxis: Axis;
  readonly blocking: boolean;
  readonly docRef: string | undefined;
};

export type ProbeSummary = {
  readonly axis: Axis;
  readonly tool: string;
  readonly status: ProbeOutcome['status'];
  readonly error: string | undefined;
};

export type AxisSummary = {
  readonly axis: Axis;
  readonly score: number;
  readonly maxScore: number;
  readonly zeroed: boolean;
  /** IDs of the criticals that forced the zero, if any. */
  readonly zeroedBy: readonly string[];
  readonly probe: ProbeSummary;
  readonly counts: {
    readonly scored: number;
    readonly lowConfidence: number;
    readonly mentions: number;
    readonly bySeverity: Readonly<Record<Severity, number>>;
  };
  readonly deductions: readonly Deduction[];
  readonly findings: readonly FindingSummary[];
  readonly lowConfidence: readonly FindingSummary[];
  /** Owned by another axis; shown here for context, subtracted there. */
  readonly mentions: readonly FindingSummary[];
};

export type Summary = {
  readonly schema: typeof SUMMARY_SCHEMA_VERSION;
  readonly catalogVersion: string;
  readonly target: {
    readonly url: string;
    readonly mode: Mode;
    readonly pages: number;
    readonly repo: string | undefined;
  };
  readonly scoring: {
    readonly model: 'independent-per-axis';
    readonly maxAxisScore: number;
    /** Stated, not omitted: spec §5.1 forbids a weighted composite. */
    readonly composite: null;
  };
  readonly axesEvaluated: readonly Axis[];
  readonly axesSkipped: readonly Axis[];
  /** Blocking criticals. They open the report instead of being averaged away. */
  readonly coverPage: readonly FindingSummary[];
  readonly lowConfidence: readonly FindingSummary[];
  readonly rejected: readonly RejectedObservation[];
  readonly byAxis: readonly AxisSummary[];
  readonly disclaimers: readonly string[];
  readonly totals: {
    readonly findings: number;
    readonly scored: number;
    readonly lowConfidence: number;
  };
};

export function toFindingSummary(finding: Finding): FindingSummary {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    count: finding.count,
    affected: finding.affected,
    remediation: finding.remediation,
    evidence: finding.evidence,
    source: finding.source,
    tool: finding.tool,
    ownerAxis: ownerAxisOf(finding.id),
    blocking: isBlocking(finding.id),
    docRef: finding.doc_ref,
  };
}

function countBySeverity(findings: readonly Finding[]): Readonly<Record<Severity, number>> {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
    Severity,
    number
  >;

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return counts;
}

function probeSummary(outcome: ProbeOutcome): ProbeSummary {
  return {
    axis: outcome.axis,
    tool: `${outcome.tool.name}@${outcome.tool.version}`,
    status: outcome.status,
    error: outcome.status === 'failed' ? outcome.error : undefined,
  };
}

function axisSummary(score: AxisScore, probe: ProbeSummary): AxisSummary {
  return {
    axis: score.axis,
    score: score.score,
    maxScore: MAX_AXIS_SCORE,
    zeroed: score.zeroed,
    zeroedBy: score.zeroedBy,
    probe,
    counts: {
      scored: score.scored.length,
      lowConfidence: score.lowConfidence.length,
      mentions: score.mentions.length,
      bySeverity: countBySeverity(score.scored),
    },
    deductions: score.deductions,
    findings: score.scored.map(toFindingSummary),
    lowConfidence: score.lowConfidence.map(toFindingSummary),
    mentions: score.mentions.map(toFindingSummary),
  };
}

export type SummaryInput = {
  readonly url: string;
  readonly mode: Mode;
  readonly pages: number;
  readonly repo?: string | undefined;
  readonly requestedAxes: readonly Axis[];
  readonly outcomes: readonly ProbeOutcome[];
  readonly findings: readonly Finding[];
  readonly rejected: readonly RejectedObservation[];
};

/**
 * Builds the summary. Axes appear in catalogue order and every requested axis
 * appears even when its probe failed, so a missing axis is a visible `failed`
 * status rather than a silently shorter report.
 */
export function buildSummary(input: SummaryInput): Summary {
  const scores = scoreAxes(input.findings);
  const outcomeByAxis = new Map(input.outcomes.map((outcome) => [outcome.axis, outcome]));
  const requested = new Set(input.requestedAxes);
  const evaluated = AXES.filter((axis) => requested.has(axis));

  const byAxis = evaluated.map((axis) => {
    const outcome = outcomeByAxis.get(axis);
    const probe: ProbeSummary =
      outcome === undefined
        ? { axis, tool: 'none', status: 'failed', error: 'No probe registered for this axis.' }
        : probeSummary(outcome);

    return axisSummary(scores[axis], probe);
  });

  const low = lowConfidenceFindings(input.findings);

  return {
    schema: SUMMARY_SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    target: {
      url: input.url,
      mode: input.mode,
      pages: input.pages,
      repo: input.repo,
    },
    scoring: {
      model: 'independent-per-axis',
      maxAxisScore: MAX_AXIS_SCORE,
      composite: null,
    },
    axesEvaluated: evaluated,
    axesSkipped: AXES.filter((axis) => !requested.has(axis)),
    coverPage: coverPageFindings(input.findings).map(toFindingSummary),
    lowConfidence: low.map(toFindingSummary),
    rejected: input.rejected,
    byAxis,
    disclaimers: DISCLAIMERS,
    totals: {
      findings: input.findings.length,
      scored: input.findings.length - low.length,
      lowConfidence: low.length,
    },
  };
}
