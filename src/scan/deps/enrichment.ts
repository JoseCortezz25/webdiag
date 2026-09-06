/**
 * The three public facts retire.js does not carry, and the catalogue needs.
 *
 *  - **CISA KEV** turns `DEPS-VULN-KEV` on. The catalogue marks it 🚫 blocking:
 *    it is the one dependency finding that opens the report, because "known
 *    exploited" is a different claim from "critical".
 *  - **EPSS** turns `DEPS-VULN-HIGH-EPSS` on — a moderate CVSS that the world is
 *    actually exploiting outranks a critical nobody has ever weaponised.
 *  - **The npm registry** answers `DEPS-LIB-OUTDATED`: "una version mayor de
 *    retraso" is only decidable against what the latest major actually is.
 *
 * Every lookup degrades instead of failing. An air-gapped run still reports the
 * vulnerabilities retire.js found; it just cannot say which are exploited, and
 * the evidence says so rather than implying none are. That asymmetry is the
 * point: a missing feed must never read as a clean result.
 */
import type { Fetcher } from './sourcemaps.ts';
import { httpFetcher } from './sourcemaps.ts';

export const KEV_FEED_URL =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
export const EPSS_API_URL = 'https://api.first.org/data/v1/epss';
export const REGISTRY_URL = 'https://registry.npmjs.org';

/** EPSS is queried in batches; the API takes a comma-separated list. */
const EPSS_BATCH = 50;

/** A cap on registry round-trips, since one runs per distinct component. */
const MAX_REGISTRY_LOOKUPS = 40;

export type KevLookup = {
  /** False when the feed could not be read. Never conflate with "no matches". */
  readonly available: boolean;
  /** Which of the queried CVEs CISA lists as exploited. Sorted. */
  readonly listed: readonly string[];
  readonly catalogVersion: string | undefined;
};

export type EpssLookup = {
  readonly available: boolean;
  /** CVE → probability of exploitation in the next 30 days, 0..1. */
  readonly scores: Readonly<Record<string, number>>;
};

export type RegistryLookup = {
  readonly available: boolean;
  /** npm package name → latest published version. */
  readonly latest: Readonly<Record<string, string>>;
};

export type Enrichment = {
  readonly kev: KevLookup;
  readonly epss: EpssLookup;
  readonly registry: RegistryLookup;
};

/** What a run with no network, or no CVEs to ask about, is allowed to claim. */
export const EMPTY_ENRICHMENT: Enrichment = {
  kev: { available: false, listed: [], catalogVersion: undefined },
  epss: { available: false, scores: {} },
  registry: { available: false, latest: {} },
};

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function fetchKev(
  cves: readonly string[],
  fetcher: Fetcher = httpFetcher,
): Promise<KevLookup> {
  if (cves.length === 0) {
    return { available: true, listed: [], catalogVersion: undefined };
  }

  const response = await fetcher(KEV_FEED_URL).catch(() => undefined);

  if (response === undefined || response.status !== 200) {
    return EMPTY_ENRICHMENT.kev;
  }

  const parsed = parseJson(response.body) as
    | { catalogVersion?: unknown; vulnerabilities?: unknown }
    | undefined;

  if (parsed === undefined || !Array.isArray(parsed.vulnerabilities)) {
    return EMPTY_ENRICHMENT.kev;
  }

  const exploited = new Set(
    parsed.vulnerabilities
      .map((entry) => (entry as { cveID?: unknown }).cveID)
      .filter((id): id is string => typeof id === 'string'),
  );

  return {
    available: true,
    listed: [...new Set(cves)].filter((cve) => exploited.has(cve)).sort(),
    catalogVersion: typeof parsed.catalogVersion === 'string' ? parsed.catalogVersion : undefined,
  };
}

function batches<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }

  return out;
}

export async function fetchEpss(
  cves: readonly string[],
  fetcher: Fetcher = httpFetcher,
): Promise<EpssLookup> {
  const unique = [...new Set(cves)].sort();

  if (unique.length === 0) {
    return { available: true, scores: {} };
  }

  const scores: Record<string, number> = {};
  let available = false;

  for (const batch of batches(unique, EPSS_BATCH)) {
    const url = `${EPSS_API_URL}?cve=${batch.join(',')}`;
    const response = await fetcher(url).catch(() => undefined);

    if (response === undefined || response.status !== 200) {
      continue;
    }

    const parsed = parseJson(response.body) as { data?: unknown } | undefined;

    if (parsed === undefined || !Array.isArray(parsed.data)) {
      continue;
    }

    available = true;

    for (const row of parsed.data) {
      const entry = row as { cve?: unknown; epss?: unknown };
      const score = Number(entry.epss);

      if (typeof entry.cve === 'string' && Number.isFinite(score)) {
        scores[entry.cve] = score;
      }
    }
  }

  return { available, scores };
}

export async function fetchLatestVersions(
  packages: readonly string[],
  fetcher: Fetcher = httpFetcher,
): Promise<RegistryLookup> {
  const unique = [...new Set(packages)].sort().slice(0, MAX_REGISTRY_LOOKUPS);

  if (unique.length === 0) {
    return { available: true, latest: {} };
  }

  const latest: Record<string, string> = {};
  let available = false;

  for (const name of unique) {
    const response = await fetcher(
      `${REGISTRY_URL}/${name.split('/').map(encodeURIComponent).join('/')}/latest`,
    ).catch(() => undefined);

    if (response === undefined) {
      continue;
    }

    // A 404 is an answer: the component is not published under that name, so
    // there is nothing to be outdated against.
    available = true;

    if (response.status !== 200) {
      continue;
    }

    const parsed = parseJson(response.body) as { version?: unknown } | undefined;

    if (typeof parsed?.version === 'string') {
      latest[name] = parsed.version;
    }
  }

  return { available, latest };
}
