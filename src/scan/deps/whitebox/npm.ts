/**
 * What npm knows about a package that a lockfile does not.
 *
 * Two facts are wanted, and both come from the version manifest at
 * `registry.npmjs.org/<name>/<version>`:
 *
 *  - **`deprecated`**, which is `DEPS-LIB-DEPRECATED` outright. It is the
 *    maintainer's own statement that this release should not be used, so the
 *    finding needs no heuristic behind it and carries `high` confidence.
 *  - **`repository`**, which is the only way to reach OpenSSF Scorecard. Nothing
 *    in the lockfile says where a package is developed.
 *
 * The version manifest is asked for rather than the full packument on purpose:
 * a packument for a package like `lodash` is several megabytes of every release
 * ever published, and the deprecation notice wanted here is the one attached to
 * *the version the project actually resolved*, not to the latest.
 *
 * Lookups degrade one by one. A package the registry cannot answer for is
 * absent from the result, never recorded as "not deprecated" — the difference
 * matters, and the caller reports how many answers it got.
 */

import { REGISTRY_URL } from '../enrichment.ts';
import type { Fetcher } from '../sourcemaps.ts';
import { httpFetcher } from '../sourcemaps.ts';
import type { PackageRef } from './inventory.ts';

/**
 * A cap on registry round-trips. One request per direct dependency is fine; one
 * per transitive dependency of a modern front-end would be a thousand.
 */
export const MAX_NPM_LOOKUPS = 60;

export type NpmPackageFacts = {
  readonly name: string;
  readonly version: string;
  /** The maintainer's deprecation message, when there is one. */
  readonly deprecated: string | undefined;
  /** Normalised `https://github.com/owner/repo`, when npm declares one. */
  readonly repository: string | undefined;
};

export type NpmLookup = {
  /** False when no request was answered at all. Never conflate with "clean". */
  readonly available: boolean;
  readonly facts: Readonly<Record<string, NpmPackageFacts>>;
  /** How many packages were asked about, after the cap. */
  readonly queried: number;
};

export const EMPTY_NPM_LOOKUP: NpmLookup = { available: false, facts: {}, queried: 0 };

/** `name@version`. The key both this module and its callers index facts by. */
export function packageKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function registryUrl(name: string, version: string): string {
  const path = name.split('/').map(encodeURIComponent).join('/');
  return `${REGISTRY_URL}/${path}/${encodeURIComponent(version)}`;
}

/**
 * `git+https://github.com/owner/repo.git` becomes `https://github.com/owner/repo`.
 *
 * Only GitHub is normalised, because Scorecard's public API is only reliably
 * populated for GitHub projects. A GitLab or self-hosted URL returns
 * `undefined` rather than a guess, and the package simply gets no maintenance
 * verdict.
 */
export function normalizeRepository(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : typeof (value as { url?: unknown } | null)?.url === 'string'
        ? (value as { url: string }).url
        : undefined;

  if (raw === undefined) {
    return undefined;
  }

  const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(raw);
  const owner = match?.[1];
  const repository = match?.[2];

  return owner === undefined || repository === undefined
    ? undefined
    : `https://github.com/${owner}/${repository}`;
}

function factsFrom(name: string, version: string, body: string): NpmPackageFacts | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const manifest = parsed as { deprecated?: unknown; repository?: unknown };

  return {
    name,
    version,
    deprecated:
      typeof manifest.deprecated === 'string' && manifest.deprecated.trim() !== ''
        ? manifest.deprecated.trim()
        : // npm also accepts `deprecated: true` with no message.
          manifest.deprecated === true
          ? 'El paquete está marcado como deprecated en npm.'
          : undefined,
    repository: normalizeRepository(manifest.repository),
  };
}

/**
 * Asks npm about each package, in a stable order, up to the cap.
 *
 * The order matters more than it looks: which packages get asked about when the
 * list is longer than the cap must not depend on lockfile iteration order, or
 * two runs of the same repo would produce different findings.
 */
export async function fetchNpmFacts(
  packages: readonly PackageRef[],
  fetcher: Fetcher = httpFetcher,
): Promise<NpmLookup> {
  const wanted = [
    ...new Map(packages.map((entry) => [packageKey(entry.name, entry.version), entry])).values(),
  ]
    .filter((entry) => entry.ecosystem === 'npm')
    .sort((left, right) =>
      packageKey(left.name, left.version) < packageKey(right.name, right.version) ? -1 : 1,
    )
    .slice(0, MAX_NPM_LOOKUPS);

  if (wanted.length === 0) {
    return { available: true, facts: {}, queried: 0 };
  }

  const facts: Record<string, NpmPackageFacts> = {};
  let available = false;

  for (const entry of wanted) {
    const response = await fetcher(registryUrl(entry.name, entry.version)).catch(() => undefined);

    if (response === undefined) {
      continue;
    }

    // A 404 is an answer: the exact version is not published under that name.
    available = true;

    if (response.status !== 200) {
      continue;
    }

    const parsed = factsFrom(entry.name, entry.version, response.body);

    if (parsed !== undefined) {
      facts[packageKey(entry.name, entry.version)] = parsed;
    }
  }

  return { available, facts, queried: wanted.length };
}
