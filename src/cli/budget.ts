/**
 * The `--fail-on` CI gate: decides whether a run's findings should fail the
 * build. This is a CLI-level policy, not a measurement concern — `runScan`
 * always exits clean, and a budget only exists once the caller names one
 * (spec: measurement stays usable in CI without opinions baked in).
 */
import { coverPageFindings, type Finding, SEVERITIES, type Severity } from '../catalog/index.ts';

export type BudgetReason = 'blocking' | 'severity';

export type BudgetViolation = {
  readonly id: string;
  readonly severity: Severity;
  readonly reason: BudgetReason;
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.fromEntries(
  SEVERITIES.map((severity, index) => [severity, index]),
) as Record<Severity, number>;

/** `critical` is worst (rank 0); a finding "meets" a threshold at or past it. */
function atOrAbove(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

/**
 * Findings that should fail a build under `failOn`.
 *
 * Blocking findings (spec: a `critical` marked 🚫 in the catalogue) always
 * count once a budget is set, regardless of where `failOn` is drawn. Every
 * other finding only counts at or above the chosen severity. Low-confidence
 * findings never count here either — same valve as the score itself, so the
 * gate cannot fail a build on a guess.
 */
export function evaluateBudget(
  findings: readonly Finding[],
  failOn: Severity,
): readonly BudgetViolation[] {
  const blocking = coverPageFindings(findings);
  const blockingIds = new Set(blocking.map((finding) => finding.id));

  const overThreshold = findings.filter(
    (finding) =>
      finding.confidence !== 'low' &&
      !blockingIds.has(finding.id) &&
      atOrAbove(finding.severity, failOn),
  );

  return [
    ...blocking.map(
      (finding): BudgetViolation => ({
        id: finding.id,
        severity: finding.severity,
        reason: 'blocking',
      }),
    ),
    ...overThreshold.map(
      (finding): BudgetViolation => ({
        id: finding.id,
        severity: finding.severity,
        reason: 'severity',
      }),
    ),
  ];
}
