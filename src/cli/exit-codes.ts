/**
 * Process exit codes. Stable contract: scripts and CI branch on these numbers.
 */
export const EXIT = {
  /** The requested work completed. */
  OK: 0,
  /** The invocation itself was wrong (unknown command, missing argument). */
  USAGE: 1,
  /** The command exists in the interface but has no implementation yet. */
  NOT_IMPLEMENTED: 2,
  /** The invocation was valid but the run could not produce its artifacts. */
  FAILED: 3,
  /** The run produced artifacts, but a `--fail-on` budget was exceeded. */
  BUDGET_EXCEEDED: 4,
  /**
   * The run produced artifacts, but at least one requested axis could not be
   * measured (its probe failed). Distinct from `OK` so a CI job whose browser
   * never started cannot pass the gate looking identical to a clean site.
   */
  PROBE_FAILED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
