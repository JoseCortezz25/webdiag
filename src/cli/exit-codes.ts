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
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
