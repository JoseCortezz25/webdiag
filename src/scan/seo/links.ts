/**
 * Link checking, delegated to lychee.
 *
 * Two decisions are worth the ink.
 *
 * **`--accept` includes 401, 403, 429 and 999.** The first three are a server
 * declining to be crawled by a stranger, not a broken link. `999` joins them
 * for the same reason plus one more (issue #12): it is not a registered HTTP
 * status at all — LinkedIn returns it to every unauthenticated client on every
 * profile URL, browser or bot, as an anti-scraping response. The calibration
 * run against `alfonso-portafolio.vercel.app` reported the author's own,
 * working LinkedIn profile as a broken link on this status alone, reproduced
 * identically in both `quick` and `deep` mode. A false "your links are broken"
 * is more expensive than a missed genuinely-dead link, because it costs the
 * reader their trust in the whole document.
 *
 * **A lychee that does not finish produces no finding, not a failed axis.** The
 * probe still has twenty other checks and a budget to keep (spec §5.2: quick is
 * 40–60 s). `outcome` records what happened so the caller can say so instead of
 * quietly reporting a clean bill of health.
 */

export type BrokenLink = {
  readonly url: string;
  readonly status: string;
  readonly code: number | undefined;
};

export type LinkReport = {
  readonly outcome: 'ok' | 'unavailable' | 'timeout' | 'failed';
  readonly detail: string | undefined;
  readonly total: number;
  readonly successful: number;
  readonly excluded: number;
  readonly broken: readonly BrokenLink[];
};

type LycheeEntry = {
  readonly url?: unknown;
  readonly status?: { readonly text?: unknown; readonly code?: unknown };
};

type LycheeOutput = {
  readonly total?: unknown;
  readonly successful?: unknown;
  readonly excludes?: unknown;
  readonly error_map?: Readonly<Record<string, readonly LycheeEntry[]>>;
  readonly timeout_map?: Readonly<Record<string, readonly LycheeEntry[]>>;
};

/** Reported per link, so a page with 200 dead links does not produce a 200-row table. */
const MAX_REPORTED_LINKS = 25;

export type LinkCheckOptions = {
  readonly timeoutMs: number;
  /** Injected so the unit tests never spawn a process or touch the network. */
  readonly run?: (urls: readonly string[], timeoutMs: number) => Promise<LinkReport>;
};

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toBrokenLinks(
  map: Readonly<Record<string, readonly LycheeEntry[]>> | undefined,
): BrokenLink[] {
  return Object.values(map ?? {})
    .flat()
    .flatMap((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : undefined;
      if (url === undefined) {
        return [];
      }

      const text = typeof entry.status?.text === 'string' ? entry.status.text : 'unknown';
      const code = typeof entry.status?.code === 'number' ? entry.status.code : undefined;

      return [{ url, status: text, code }];
    });
}

/**
 * One row per target URL, not one per page that happened to link it.
 *
 * `error_map`/`timeout_map` are keyed by *source* page, so a footer link
 * broken on every crawled page arrives once per page — and, in `deep` mode,
 * a second time from lychee's own cache. The calibration run against
 * `alfonso-portafolio.vercel.app` (issue #12) counted two real broken targets
 * as five, inflating the deduction 2.5x. First occurrence wins because lychee
 * emits the live check before the cached echo.
 */
function dedupeByUrl(links: readonly BrokenLink[]): readonly BrokenLink[] {
  const seen = new Map<string, BrokenLink>();

  for (const link of links) {
    if (!seen.has(link.url)) {
      seen.set(link.url, link);
    }
  }

  return [...seen.values()];
}

export function parseLycheeOutput(stdout: string): LinkReport {
  const parsed = JSON.parse(stdout) as LycheeOutput;

  const broken = dedupeByUrl(
    [...toBrokenLinks(parsed.error_map), ...toBrokenLinks(parsed.timeout_map)].sort(
      (left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0),
    ),
  );

  return {
    outcome: 'ok',
    detail: undefined,
    total: numberOf(parsed.total),
    successful: numberOf(parsed.successful),
    excluded: numberOf(parsed.excludes),
    broken: broken.slice(0, MAX_REPORTED_LINKS),
  };
}

function unavailable(outcome: LinkReport['outcome'], detail: string): LinkReport {
  return { outcome, detail, total: 0, successful: 0, excluded: 0, broken: [] };
}

/** `lychee 0.24.2` → `0.24.2`. */
export async function lycheeVersion(): Promise<string | undefined> {
  try {
    const process = Bun.spawn(['lychee', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);

    if (exitCode !== 0) {
      return undefined;
    }
    return stdout.trim().split(/\s+/).at(-1);
  } catch {
    return undefined;
  }
}

/**
 * Checks every link on every page it is given, in one lychee run.
 *
 * One invocation rather than one per page because lychee deduplicates targets
 * across its inputs: ten pages that all link the same broken footer URL cost one
 * request and produce one broken link, not ten. That is what makes the `deep`
 * crawl affordable here at all.
 */
export async function checkLinks(
  urls: readonly string[],
  options: LinkCheckOptions,
): Promise<LinkReport> {
  if (options.run !== undefined) {
    return options.run(urls, options.timeoutMs);
  }

  if (urls.length === 0) {
    return unavailable('failed', 'no page URLs to check');
  }

  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

  try {
    child = Bun.spawn(
      [
        'lychee',
        '--format',
        'json',
        '--no-progress',
        '--max-concurrency',
        '16',
        '--timeout',
        '10',
        '--max-retries',
        '0',
        '--accept',
        '200..=299,401,403,429,999',
        '--',
        ...urls,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  } catch (cause) {
    return unavailable('unavailable', cause instanceof Error ? cause.message : String(cause));
  }

  const timer = setTimeout(() => child.kill(), options.timeoutMs);

  try {
    const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    if (child.killed && stdout.trim() === '') {
      return unavailable('timeout', `lychee exceeded ${options.timeoutMs} ms`);
    }

    // lychee exits non-zero *because* it found broken links, so the exit code is
    // not the signal — the presence of a JSON report is.
    if (stdout.trim() === '') {
      return unavailable('failed', 'lychee produced no JSON report');
    }

    return parseLycheeOutput(stdout);
  } catch (cause) {
    return unavailable('failed', cause instanceof Error ? cause.message : String(cause));
  } finally {
    clearTimeout(timer);
  }
}
