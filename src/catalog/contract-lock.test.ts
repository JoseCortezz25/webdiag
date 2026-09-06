import { describe, expect, test } from 'bun:test';
import { CONTRACT_LOCK } from './contract-lock.ts';
import { CATALOG_ENTRIES } from './entries.ts';
import { fingerprint } from './fingerprint.ts';

/**
 * The point of this file: an existing ID must never come to mean something else.
 * Historical comparability is the asset the whole product is built on, and it
 * dies silently — nothing throws, the reports just stop being comparable.
 */
describe('catalog ID contract', () => {
  test('no published ID has changed meaning', () => {
    const changed = CATALOG_ENTRIES.filter(
      (entry) => entry.id in CONTRACT_LOCK && CONTRACT_LOCK[entry.id] !== fingerprint(entry),
    ).map((entry) => entry.id);

    expect({
      changed,
      hint:
        changed.length === 0
          ? ''
          : 'These IDs are published. Do not update contract-lock.ts to make this pass: ' +
            'publish a new ID and mark the old one deprecated.',
    }).toEqual({ changed: [], hint: '' });
  });

  test('every published ID is still in the catalog', () => {
    const present = new Set(CATALOG_ENTRIES.map((entry) => entry.id));
    const removed = Object.keys(CONTRACT_LOCK).filter((id) => !present.has(id));

    expect(removed).toEqual([]);
  });

  test('every catalog entry is locked', () => {
    const unlocked = CATALOG_ENTRIES.filter((entry) => !(entry.id in CONTRACT_LOCK)).map(
      (entry) => entry.id,
    );

    expect(unlocked).toEqual([]);
  });

  test('rejects a redefinition of an existing ID', () => {
    const original = CATALOG_ENTRIES[0];

    if (original === undefined) {
      throw new Error('catalog is empty');
    }

    const redefined = { ...original, detects: 'algo completamente distinto' };

    expect(fingerprint(redefined)).not.toBe(CONTRACT_LOCK[original.id]);
  });

  test('rejects silently downgrading a blocking finding', () => {
    const blocking = CATALOG_ENTRIES.find((entry) => entry.blocking);

    if (blocking === undefined) {
      throw new Error('expected at least one blocking entry');
    }

    const softened = { ...blocking, blocking: false, baseSeverity: 'high' as const };

    expect(fingerprint(softened)).not.toBe(CONTRACT_LOCK[blocking.id]);
  });

  test('rejects moving a finding to a different owner axis', () => {
    const shared = CATALOG_ENTRIES.find((entry) => entry.mentionedIn.length > 0);

    if (shared === undefined) {
      throw new Error('expected at least one shared entry');
    }

    const moved = { ...shared, ownerAxis: shared.mentionedIn[0] ?? shared.ownerAxis };

    expect(fingerprint(moved)).not.toBe(CONTRACT_LOCK[shared.id]);
  });

  test('retiring an ID does not change what it meant while it was live', () => {
    const entry = CATALOG_ENTRIES[0];

    if (entry === undefined) {
      throw new Error('catalog is empty');
    }

    const retired = { ...entry, deprecated: true, supersededBy: 'SEO-SOMETHING-ELSE' };

    expect(fingerprint(retired)).toBe(fingerprint(entry));
    expect(CONTRACT_LOCK[entry.id]).toBe(fingerprint(retired));
  });

  test('a note is editorial, not meaning, and does not break the lock', () => {
    const entry = CATALOG_ENTRIES.find((candidate) => candidate.note !== undefined);

    if (entry === undefined) {
      throw new Error('expected at least one annotated entry');
    }

    const reworded = { ...entry, note: 'redacción distinta para el reporte' };

    expect(fingerprint(reworded)).toBe(fingerprint(entry));
    expect(CONTRACT_LOCK[entry.id]).toBe(fingerprint(reworded));
  });
});
