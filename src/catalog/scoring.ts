/**
 * Per-axis scoring.
 *
 * There is deliberately no aggregate score in this module. The spec resolved it
 * on 2026-09-06 (§5.1): each axis is scored and reported on its own, and no
 * weighted number combines the six. Anything that wants "the score of the site"
 * has to name an axis.
 *
 * Two rules shape the arithmetic:
 *
 *  - **Override.** A `critical` finding zeroes its owning axis instead of
 *    subtracting from it, because a weighted average would return 71 and bury
 *    the one finding that mattered. Entries marked `blocking` in the catalogue
 *    are additionally promoted to the report cover.
 *  - **Low confidence never penalises.** A `confidence: low` finding is listed
 *    separately and never moves a score — not even a blocking critical one. It
 *    is the valve against false positives, so it must not be able to zero an
 *    axis on a guess. It is never hidden either.
 */
import { findEntry, isBlocking, ownerAxisOf } from './catalog.ts';
import type { Finding } from './finding.ts';
import { AXES, type Axis, MAX_AXIS_SCORE, SEVERITY_DEDUCTION, type Severity } from './taxonomy.ts';

/** Points a severity subtracts. `critical` subtracts nothing: it zeroes instead. */
function deductionFor(severity: Severity): number {
  return severity === 'critical' ? 0 : SEVERITY_DEDUCTION[severity];
}

export type Deduction = {
  readonly id: string;
  readonly points: number;
};

export type AxisScore = {
  readonly axis: Axis;
  /** 0–100. Zero when the override rule fired. */
  readonly score: number;
  /** True when at least one `critical` finding forced the axis to zero. */
  readonly zeroed: boolean;
  /** IDs of the criticals that forced the zero. */
  readonly zeroedBy: readonly string[];
  /** Blocking criticals, which also go to the report cover. */
  readonly coverPage: readonly string[];
  /** Findings this axis owns and that participate in the score. */
  readonly scored: readonly Finding[];
  /** Owned findings held back from the score because confidence is `low`. */
  readonly lowConfidence: readonly Finding[];
  /** Findings another axis owns that this axis shows without deducting. */
  readonly mentions: readonly Finding[];
  /** What was subtracted and why, so a report can show the arithmetic. */
  readonly deductions: readonly Deduction[];
};

function emptyScore(axis: Axis): AxisScore {
  return {
    axis,
    score: MAX_AXIS_SCORE,
    zeroed: false,
    zeroedBy: [],
    coverPage: [],
    scored: [],
    lowConfidence: [],
    mentions: [],
    deductions: [],
  };
}

/** Score a single axis from the full finding set of a run. */
export function scoreAxis(axis: Axis, findings: readonly Finding[]): AxisScore {
  const owned = findings.filter((finding) => ownerAxisOf(finding.id) === axis);
  const mentions = findings.filter((finding) =>
    (findEntry(finding.id)?.mentionedIn ?? []).includes(axis),
  );

  const lowConfidence = owned.filter((finding) => finding.confidence === 'low');
  const scored = owned.filter((finding) => finding.confidence !== 'low');

  const zeroedBy = scored
    .filter((finding) => finding.severity === 'critical')
    .map((finding) => finding.id);

  if (zeroedBy.length > 0) {
    return {
      axis,
      score: 0,
      zeroed: true,
      zeroedBy,
      coverPage: zeroedBy.filter(isBlocking),
      scored,
      lowConfidence,
      mentions,
      deductions: [],
    };
  }

  const deductions = scored
    .map((finding) => ({
      id: finding.id,
      points: deductionFor(finding.severity),
    }))
    .filter((deduction) => deduction.points > 0);

  const total = deductions.reduce((sum, deduction) => sum + deduction.points, 0);

  return {
    ...emptyScore(axis),
    score: Math.max(0, MAX_AXIS_SCORE - total),
    scored,
    lowConfidence,
    mentions,
    deductions,
  };
}

/**
 * Score every axis independently. The result is a map, not a number: there is no
 * composite, by design.
 */
export function scoreAxes(findings: readonly Finding[]): Readonly<Record<Axis, AxisScore>> {
  return Object.fromEntries(AXES.map((axis) => [axis, scoreAxis(axis, findings)])) as Record<
    Axis,
    AxisScore
  >;
}

/**
 * Findings the client report must list in its own low-confidence section.
 * Never filtered out of the report — only out of the arithmetic.
 */
export function lowConfidenceFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => finding.confidence === 'low');
}

/** Blocking criticals across the run, in the order they were reported. */
export function coverPageFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter(
    (finding) =>
      finding.severity === 'critical' && finding.confidence !== 'low' && isBlocking(finding.id),
  );
}
