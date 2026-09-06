/**
 * The resolved package list, and where it comes from.
 *
 * Syft is the primary source: it catalogues a checkout across ecosystems and
 * produces the SBOM the ticket asks for anyway, so parsing its CycloneDX output
 * gets the inventory for free. This file also carries a small lockfile reader
 * for the case Syft is not installed — without *some* inventory the npm,
 * Scorecard and EOL checks have no versions to ask about, and the white-box run
 * would collapse back to whatever osv-scanner alone happened to flag.
 *
 * The fallback covers `package-lock.json` and `bun.lock` and nothing else, on
 * purpose. Those are the two formats this build can parse without guessing;
 * pretending to read a `pnpm-lock.yaml` with a regex would produce a version
 * list that looks authoritative and is not, which is the one thing a white-box
 * mode may not do.
 *
 * Everything here is pure: file contents in, package references out.
 */

export type PackageRef = {
  /** Lowercase ecosystem as CycloneDX and purl spell it: `npm`, `pypi`, `golang`. */
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string;
};

export type Inventory = {
  readonly packages: readonly PackageRef[];
  /** `syft`, `lockfile` or `none`. Named in evidence so a reader can weigh it. */
  readonly source: 'syft' | 'lockfile' | 'none';
};

export const EMPTY_INVENTORY: Inventory = { packages: [], source: 'none' };

function compare(left: PackageRef, right: PackageRef): number {
  if (left.ecosystem !== right.ecosystem) {
    return left.ecosystem < right.ecosystem ? -1 : 1;
  }
  if (left.name !== right.name) {
    return left.name < right.name ? -1 : 1;
  }
  if (left.version === right.version) {
    return 0;
  }
  return left.version < right.version ? -1 : 1;
}

/** Deduplicates and orders, so the same checkout always yields the same list. */
export function normalizeInventory(packages: readonly PackageRef[]): readonly PackageRef[] {
  const seen = new Map<string, PackageRef>();

  for (const entry of packages) {
    if (entry.name !== '' && entry.version !== '') {
      seen.set(`${entry.ecosystem} ${entry.name} ${entry.version}`, entry);
    }
  }

  return [...seen.values()].sort(compare);
}

/**
 * `pkg:npm/%40scope/name@1.2.3?qualifier` becomes `{ npm, @scope/name, 1.2.3 }`.
 *
 * The purl is preferred over the component's own `name` and `version` fields
 * because it is the one place CycloneDX states the ecosystem, and a name
 * without an ecosystem cannot be looked up anywhere.
 */
export function parsePurl(purl: string): PackageRef | undefined {
  const match = /^pkg:([^/]+)\/(.+?)@([^?#]+)/.exec(purl.trim());
  const ecosystem = match?.[1];
  const path = match?.[2];
  const version = match?.[3];

  if (ecosystem === undefined || path === undefined || version === undefined) {
    return undefined;
  }

  const name = path
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');

  return { ecosystem: ecosystem.toLowerCase(), name, version: decodeURIComponent(version) };
}

/** Package refs out of a CycloneDX document, via each component's purl. */
export function inventoryFromCycloneDx(document: unknown): readonly PackageRef[] {
  if (typeof document !== 'object' || document === null) {
    return [];
  }

  const components = (document as { components?: unknown }).components;

  if (!Array.isArray(components)) {
    return [];
  }

  const refs: PackageRef[] = [];

  for (const component of components) {
    const purl = (component as { purl?: unknown }).purl;

    if (typeof purl === 'string') {
      const ref = parsePurl(purl);

      if (ref !== undefined) {
        refs.push(ref);
      }
    }
  }

  return normalizeInventory(refs);
}

/** The npm name inside a `node_modules/a/node_modules/b` lockfile key. */
function nameFromLockKey(key: string): string | undefined {
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);

  return index === -1 ? undefined : key.slice(index + marker.length);
}

/** `package-lock.json`, both the v1 dependency tree and the v2/v3 `packages` map. */
export function inventoryFromPackageLock(text: string): readonly PackageRef[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  const refs: PackageRef[] = [];
  const packages = (parsed as { packages?: unknown }).packages;

  if (typeof packages === 'object' && packages !== null) {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      const name = nameFromLockKey(key);
      const version = (value as { version?: unknown }).version;

      if (name !== undefined && typeof version === 'string') {
        refs.push({ ecosystem: 'npm', name, version });
      }
    }
  }

  const walk = (tree: unknown): void => {
    if (typeof tree !== 'object' || tree === null) {
      return;
    }

    for (const [name, value] of Object.entries(tree as Record<string, unknown>)) {
      const version = (value as { version?: unknown }).version;

      if (typeof version === 'string') {
        refs.push({ ecosystem: 'npm', name, version });
      }

      walk((value as { dependencies?: unknown }).dependencies);
    }
  };

  walk((parsed as { dependencies?: unknown }).dependencies);

  return normalizeInventory(refs);
}

/**
 * `bun.lock`, which is JSONC: Bun writes trailing commas into it.
 *
 * The commas are stripped rather than a JSONC parser being pulled in — the file
 * is machine-written, so the only tolerance it needs is the one Bun's own writer
 * produces. Anything more exotic falls through to an empty inventory, which the
 * caller reports as "no inventory" instead of as an empty project.
 */
export function inventoryFromBunLock(text: string): readonly PackageRef[] {
  const withoutTrailingCommas = text.replace(/,(\s*[}\]])/g, '$1');
  let parsed: unknown;

  try {
    parsed = JSON.parse(withoutTrailingCommas);
  } catch {
    return [];
  }

  const packages = (parsed as { packages?: unknown } | null)?.packages;

  if (typeof packages !== 'object' || packages === null) {
    return [];
  }

  const refs: PackageRef[] = [];

  for (const value of Object.values(packages as Record<string, unknown>)) {
    // Each entry is ["<name>@<version>", <url>, {...}, "<hash>"].
    const descriptor = Array.isArray(value) ? value[0] : undefined;

    if (typeof descriptor !== 'string') {
      continue;
    }

    const separator = descriptor.lastIndexOf('@');

    if (separator <= 0) {
      continue;
    }

    refs.push({
      ecosystem: 'npm',
      name: descriptor.slice(0, separator),
      version: descriptor.slice(separator + 1),
    });
  }

  return normalizeInventory(refs);
}

/** Which parser, if any, this build has for a given lockfile name. */
export function readerFor(lockfile: string): ((text: string) => readonly PackageRef[]) | undefined {
  const name = lockfile.split('/').at(-1);

  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
    return inventoryFromPackageLock;
  }

  return name === 'bun.lock' ? inventoryFromBunLock : undefined;
}
