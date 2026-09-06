/**
 * endoflife.date, for `DEPS-RUNTIME-EOL`.
 *
 * The API publishes one entry per release cycle with the date support ends. A
 * declared version is matched to the longest cycle that prefixes it, so
 * `20.11.1` finds cycle `20` and `3.11.4` finds cycle `3.11`, and the cycle's
 * `eol` field decides.
 *
 * **This is the one DEPS check that depends on the clock**, and it is worth
 * being explicit about why that is allowed here when `testssl.ts` refused it for
 * certificate expiry. There the tool published a verdict and recomputing it from
 * our own clock would have been a choice; here endoflife.date publishes a date
 * and nothing else, so a comparison is the only way to reach a verdict at all.
 * The evaluation date is deliberately kept *out* of the evidence: the finding
 * then only changes on the day a cycle actually goes out of support, which is
 * exactly when a diff between two runs should show something.
 */
import type { Fetcher } from '../sourcemaps.ts';
import { httpFetcher } from '../sourcemaps.ts';

export const EOL_API_URL = 'https://endoflife.date/api';

export type EolCycle = {
  readonly cycle: string;
  /** ISO date, or `true`/`false` for "already ended" / "no date announced". */
  readonly eol: string | boolean;
  readonly latest: string | undefined;
};

export type EolProduct = {
  readonly product: string;
  readonly cycles: readonly EolCycle[];
};

export type EolLookup = {
  /** False when no request was answered. Never conflate with "all supported". */
  readonly available: boolean;
  readonly products: Readonly<Record<string, EolProduct>>;
};

export const EMPTY_EOL: EolLookup = { available: false, products: {} };

/**
 * The numeric core of a declared version or range.
 *
 * `>=18.0.0`, `^20.11`, `16.x`, `~3.11.4` and `v22` all reduce to their leading
 * numbers. A range with no leading number (`*`, `latest`, `workspace:*`) yields
 * `undefined` and the runtime is skipped rather than guessed at.
 */
export function normalizeVersion(declared: string): string | undefined {
  const match = /(\d+(?:\.\d+)*)/.exec(declared.trim());
  return match?.[1];
}

/** The longest cycle that prefixes the version: `20.11.1` matches `20.11` over `20`. */
export function cycleFor(version: string, cycles: readonly EolCycle[]): EolCycle | undefined {
  const candidates = cycles.filter(
    (entry) => version === entry.cycle || version.startsWith(`${entry.cycle}.`),
  );

  return candidates.sort((left, right) => right.cycle.length - left.cycle.length)[0];
}

/** True when the cycle's support window has closed as of `now`. */
export function isEndOfLife(cycle: EolCycle, now: Date): boolean {
  if (typeof cycle.eol === 'boolean') {
    return cycle.eol;
  }

  const ends = Date.parse(cycle.eol);

  return Number.isFinite(ends) && ends <= now.getTime();
}

function cyclesFrom(body: string): readonly EolCycle[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const cycles: EolCycle[] = [];

  for (const entry of parsed) {
    const row = entry as { cycle?: unknown; eol?: unknown; latest?: unknown };

    if (typeof row.cycle !== 'string') {
      continue;
    }

    cycles.push({
      cycle: row.cycle,
      eol: typeof row.eol === 'string' || typeof row.eol === 'boolean' ? row.eol : false,
      latest: typeof row.latest === 'string' ? row.latest : undefined,
    });
  }

  return cycles;
}

export async function fetchEolProducts(
  products: readonly string[],
  fetcher: Fetcher = httpFetcher,
): Promise<EolLookup> {
  const wanted = [...new Set(products)].sort();

  if (wanted.length === 0) {
    return { available: true, products: {} };
  }

  const found: Record<string, EolProduct> = {};
  let available = false;

  for (const product of wanted) {
    const response = await fetcher(`${EOL_API_URL}/${encodeURIComponent(product)}.json`).catch(
      () => undefined,
    );

    if (response === undefined) {
      continue;
    }

    // A 404 is an answer: endoflife.date does not track that product.
    available = true;

    if (response.status !== 200) {
      continue;
    }

    const cycles = cyclesFrom(response.body);

    if (cycles !== undefined) {
      found[product] = { product, cycles };
    }
  }

  return { available, products: found };
}
