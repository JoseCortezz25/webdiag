/**
 * Which catalogue ID a vulnerability becomes. Pure, and deliberately small.
 *
 * The golden rule (spec §6) is that IDs are the contract, so this file may only
 * *choose* among published DEPS IDs — never invent one, and never redefine what
 * one means. Everything here is therefore a decision table, not a heuristic:
 *
 *   exploited in the wild        → DEPS-VULN-KEV       (blocking, opens the report)
 *   CVSS critical                → DEPS-VULN-CRITICAL  (zeroes the axis)
 *   CVSS high                    → DEPS-VULN-HIGH
 *   moderate CVSS, high EPSS     → DEPS-VULN-HIGH-EPSS
 *   CVSS medium                  → DEPS-VULN-MEDIUM
 *
 * The order is the point. KEV outranks CVSS because "someone is exploiting this
 * today" is a stronger statement than any score, and EPSS is checked *after*
 * high/critical because the catalogue defines `DEPS-VULN-HIGH-EPSS` as the case
 * where the CVSS alone would have understated the risk.
 */
import type { Confidence, Severity } from '../../catalog/index.ts';
import type { RetireDetection, RetireSeverity, RetireVulnerability } from './retire.ts';

/**
 * EPSS above 10% is the threshold FIRST's own guidance uses for "act on this
 * now" prioritisation. It is a probability of exploitation in the next 30 days,
 * so 0.1 is already two orders of magnitude above the median CVE.
 */
export const EPSS_HIGH_THRESHOLD = 0.1;

export type VulnerabilityReason =
  | 'kev'
  | 'cvss-critical'
  | 'cvss-high'
  | 'epss-high'
  | 'cvss-medium'
  | 'cvss-low';

export type Classification = {
  readonly id: string;
  readonly reason: VulnerabilityReason;
  /**
   * Set only when the run justifies deviating from the catalogue base severity
   * (`raw.ts`). Used for the one case the catalogue has no ID for.
   */
  readonly severity?: Severity;
};

/** Every CVE the advisory names, deduplicated and ordered. */
export function cvesOf(vulnerability: RetireVulnerability): readonly string[] {
  return [...new Set(vulnerability.identifiers.CVE ?? [])].sort();
}

/** The advisory's stable name, for evidence: a CVE if there is one, else GHSA. */
export function advisoryId(vulnerability: RetireVulnerability): string {
  return cvesOf(vulnerability)[0] ?? vulnerability.identifiers.githubID ?? 'sin identificador';
}

export type Signals = {
  readonly severity: RetireSeverity;
  readonly kev: boolean;
  readonly epss: number | undefined;
};

/**
 * The decision table.
 *
 * `low` and `none` have no published ID of their own. They are reported as
 * `DEPS-VULN-MEDIUM` with an explicit `low` severity rather than dropped:
 * silently discarding a real advisory would make "no medium findings" mean two
 * different things. The ID stays truthful about which check ran; the severity
 * stays truthful about how bad it is, and deducts 1 point instead of 5.
 */
export function classify(signals: Signals): Classification {
  if (signals.kev) {
    return { id: 'DEPS-VULN-KEV', reason: 'kev' };
  }

  if (signals.severity === 'critical') {
    return { id: 'DEPS-VULN-CRITICAL', reason: 'cvss-critical' };
  }

  if (signals.severity === 'high') {
    return { id: 'DEPS-VULN-HIGH', reason: 'cvss-high' };
  }

  if (signals.epss !== undefined && signals.epss >= EPSS_HIGH_THRESHOLD) {
    return { id: 'DEPS-VULN-HIGH-EPSS', reason: 'epss-high' };
  }

  if (signals.severity === 'medium') {
    return { id: 'DEPS-VULN-MEDIUM', reason: 'cvss-medium' };
  }

  return { id: 'DEPS-VULN-MEDIUM', reason: 'cvss-low', severity: 'low' };
}

/**
 * How sure we are the vulnerable code is really running.
 *
 * Black-box detection reads a file, not a lockfile. A byte-exact hash match is
 * a released artefact and nothing else, so it is `high`. A content or filename
 * match identifies the library and its declared version, but cannot see a
 * backported patch in a vendored copy — the classic false positive of this
 * check — so it stays `medium`, and `DEPS-VERSION-UNDETERMINED` tells the
 * reader why a white-box run would settle it.
 */
export function confidenceFor(detection: RetireDetection): Confidence {
  return detection === 'hash' ? 'high' : 'medium';
}

/** Leading integer of a semver-ish string. `undefined` when there is none. */
export function majorOf(version: string): number | undefined {
  const match = /^\D*(\d+)/.exec(version.trim());
  const major = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);

  return Number.isFinite(major) ? major : undefined;
}

/** The catalogue's `DEPS-LIB-OUTDATED` test: at least one major behind. */
export function isMajorBehind(detected: string, latest: string): boolean {
  const current = majorOf(detected);
  const newest = majorOf(latest);

  return current !== undefined && newest !== undefined && newest > current;
}

/** npm name for a retire.js component, when one can be stated without guessing. */
export function npmNameFor(result: {
  readonly component: string;
  readonly npmname?: string | undefined;
}): string {
  return result.npmname ?? result.component;
}
