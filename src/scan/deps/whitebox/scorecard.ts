/**
 * OpenSSF Scorecard, for the one question a lockfile cannot answer: is anybody
 * still looking after this package?
 *
 * Scorecard runs a fixed set of checks against a public repository and publishes
 * the results. Only one of them is read here — `Maintained` — because it is the
 * only one the catalogue has an ID for. Scorecard's own definition of the check
 * is what `DEPS-LIB-UNMAINTAINED` means in this build: commit and issue activity
 * over the last 90 days, with 0 reserved for a repository that is archived or
 * has had no activity in a year.
 *
 * The rest of the Scorecard report is deliberately ignored. A low `Token-Permissions`
 * or `Pinned-Dependencies` score is a real finding about somebody else's project
 * and not about the client's site, and the catalogue is the contract: this file
 * may only answer IDs that already exist.
 */
import type { Fetcher } from '../sourcemaps.ts';
import { httpFetcher } from '../sourcemaps.ts';

export const SCORECARD_API_URL = 'https://api.scorecard.dev/projects';

/**
 * At or below this, `Maintained` means "not maintained".
 *
 * Scorecard scores the check 0 for an archived repository or one with no
 * activity in the last year, and 1-2 for a handful of commits across 90 days.
 * From 3 upward the project is merely quiet, which is not the same claim and
 * would turn a stable, finished library into a finding.
 */
export const UNMAINTAINED_MAX_SCORE = 2;

/** Scorecard reports -1 for a check it could not evaluate. Not a low score. */
const NOT_EVALUATED = -1;

export type MaintenanceVerdict = {
  /** `https://github.com/owner/repo`, as asked about. */
  readonly repository: string;
  /** The `Maintained` check score, 0..10. */
  readonly score: number;
  /** The aggregate Scorecard score, for context only. */
  readonly overall: number | undefined;
  /** The date Scorecard last evaluated the project. */
  readonly evaluatedAt: string | undefined;
  readonly reason: string | undefined;
};

export type ScorecardLookup = {
  /** False when no request was answered. Never conflate with "all maintained". */
  readonly available: boolean;
  /** Repository URL to its `Maintained` verdict. Only evaluated ones appear. */
  readonly verdicts: Readonly<Record<string, MaintenanceVerdict>>;
  readonly queried: number;
};

export const EMPTY_SCORECARD: ScorecardLookup = { available: false, verdicts: {}, queried: 0 };

/**
 * A cap on Scorecard round-trips. Lower than the npm one: the API answers per
 * repository and is noticeably slower, and this check only ever runs over direct
 * dependencies.
 */
export const MAX_SCORECARD_LOOKUPS = 25;

/** `https://github.com/owner/repo` becomes `github.com/owner/repo`. */
function projectPath(repository: string): string | undefined {
  const match = /^https?:\/\/(github\.com\/[^/]+\/[^/]+)$/i.exec(repository.trim());
  return match?.[1];
}

function verdictFrom(repository: string, body: string): MaintenanceVerdict | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  const report = parsed as {
    score?: unknown;
    date?: unknown;
    checks?: unknown;
  } | null;

  if (report === null || !Array.isArray(report.checks)) {
    return undefined;
  }

  const maintained = report.checks.find(
    (check) => (check as { name?: unknown }).name === 'Maintained',
  ) as { score?: unknown; reason?: unknown } | undefined;

  const score = Number(maintained?.score);

  if (!Number.isFinite(score) || score === NOT_EVALUATED) {
    return undefined;
  }

  return {
    repository,
    score,
    overall: Number.isFinite(Number(report.score)) ? Number(report.score) : undefined,
    evaluatedAt: typeof report.date === 'string' ? report.date : undefined,
    reason: typeof maintained?.reason === 'string' ? maintained.reason.slice(0, 240) : undefined,
  };
}

export async function fetchScorecards(
  repositories: readonly string[],
  fetcher: Fetcher = httpFetcher,
): Promise<ScorecardLookup> {
  const wanted = [...new Set(repositories)].sort().slice(0, MAX_SCORECARD_LOOKUPS);

  if (wanted.length === 0) {
    return { available: true, verdicts: {}, queried: 0 };
  }

  const verdicts: Record<string, MaintenanceVerdict> = {};
  let available = false;

  for (const repository of wanted) {
    const path = projectPath(repository);

    if (path === undefined) {
      continue;
    }

    const response = await fetcher(`${SCORECARD_API_URL}/${path}`).catch(() => undefined);

    if (response === undefined) {
      continue;
    }

    // A 404 is an answer: Scorecard has never evaluated that project.
    available = true;

    if (response.status !== 200) {
      continue;
    }

    const verdict = verdictFrom(repository, response.body);

    if (verdict !== undefined) {
      verdicts[repository] = verdict;
    }
  }

  return { available, verdicts, queried: wanted.length };
}

export function isUnmaintained(verdict: MaintenanceVerdict): boolean {
  return verdict.score <= UNMAINTAINED_MAX_SCORE;
}
