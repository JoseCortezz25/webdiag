/**
 * Read access to the catalogue.
 *
 * Everything here is derived from `CATALOG_ENTRIES` at module load, so the data
 * file stays the single place a finding kind is declared.
 */
import { CATALOG_ENTRIES } from './entries.ts';
import type { CatalogEntry } from './entry.ts';
import { AXES, type Axis, type Phase } from './taxonomy.ts';

/**
 * Version of the published contract. Every run records it in `meta.json` so a
 * later comparison can tell whether it is still comparing like with like.
 */
export const CATALOG_VERSION = '1.0.0';

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG_ENTRIES.map((entry) => [entry.id, entry]),
);

/** Every catalogue ID, in declaration order, including retired ones. */
export const CATALOG_IDS: readonly string[] = CATALOG_ENTRIES.map((entry) => entry.id);

/**
 * Entries a new run may emit. Deprecated IDs stay in the catalogue so old
 * `findings.json` files keep resolving, but probes must select from these.
 */
export const ACTIVE_ENTRIES: readonly CatalogEntry[] = CATALOG_ENTRIES.filter(
  (entry) => !entry.deprecated,
);

export const ACTIVE_CATALOG_IDS: readonly string[] = ACTIVE_ENTRIES.map((entry) => entry.id);

export function isDeprecated(id: string): boolean {
  return findEntry(id)?.deprecated ?? false;
}

export function isCatalogId(id: string): boolean {
  return BY_ID.has(id);
}

export function findEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Same as `findEntry`, but refuses to continue on an unknown ID. Use it where an
 * unknown ID means a probe is out of sync with the catalogue — a bug, not input.
 */
export function requireEntry(id: string): CatalogEntry {
  const entry = BY_ID.get(id);

  if (entry === undefined) {
    throw new Error(`Unknown catalog ID '${id}' (catalog ${CATALOG_VERSION}).`);
  }

  return entry;
}

/** Entries whose ID belongs to `axis`, regardless of which axis scores them. */
export function entriesForAxis(axis: Axis): readonly CatalogEntry[] {
  return CATALOG_ENTRIES.filter((entry) => entry.axis === axis);
}

/** Entries `axis` is responsible for scoring. */
export function entriesOwnedBy(axis: Axis): readonly CatalogEntry[] {
  return CATALOG_ENTRIES.filter((entry) => entry.ownerAxis === axis);
}

/**
 * Entries `axis` mentions without deducting, because another axis owns them.
 * The report still shows them there; they just do not move the score.
 */
export function entriesMentionedIn(axis: Axis): readonly CatalogEntry[] {
  return CATALOG_ENTRIES.filter((entry) => entry.mentionedIn.includes(axis));
}

export function entriesForPhase(phase: Phase): readonly CatalogEntry[] {
  return CATALOG_ENTRIES.filter((entry) => entry.phase === phase);
}

/**
 * IDs marked 🚫: a `critical` occurrence of one of these is promoted to the
 * report cover on top of zeroing its axis.
 */
export const BLOCKING_IDS: readonly string[] = CATALOG_ENTRIES.filter(
  (entry) => entry.blocking,
).map((entry) => entry.id);

/**
 * The findings that exist so the report cannot claim more than it measured.
 * They are emitted on every run in which they apply, even when nothing is wrong.
 */
export const ALWAYS_EMITTED_IDS: readonly string[] = CATALOG_ENTRIES.filter(
  (entry) => entry.alwaysEmitted,
).map((entry) => entry.id);

export function isBlocking(id: string): boolean {
  return findEntry(id)?.blocking ?? false;
}

export function isAlwaysEmitted(id: string): boolean {
  return findEntry(id)?.alwaysEmitted ?? false;
}

/** Which axis scores a given ID. Differs from the ID prefix for shared findings. */
export function ownerAxisOf(id: string): Axis {
  return requireEntry(id).ownerAxis;
}

/** Count of entries per axis, keyed by the axis the ID belongs to. */
export function countByAxis(): Readonly<Record<Axis, number>> {
  const counts = Object.fromEntries(AXES.map((axis) => [axis, 0])) as Record<Axis, number>;

  for (const entry of CATALOG_ENTRIES) {
    counts[entry.axis] += 1;
  }

  return counts;
}

export type { CatalogEntry };
export { CATALOG_ENTRIES };
