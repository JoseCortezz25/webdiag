import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_CATALOG_IDS,
  ACTIVE_ENTRIES,
  ALWAYS_EMITTED_IDS,
  BLOCKING_IDS,
  CATALOG_ENTRIES,
  CATALOG_IDS,
  CATALOG_VERSION,
  countByAxis,
  entriesMentionedIn,
  entriesOwnedBy,
  findEntry,
  isBlocking,
  isDeprecated,
  ownerAxisOf,
  requireEntry,
} from './catalog.ts';
import { defineEntry } from './entry.ts';
import { AXES, PHASES, SEVERITIES } from './taxonomy.ts';

describe('catalog data', () => {
  test('is published as version 1.0.0', () => {
    expect(CATALOG_VERSION).toBe('1.0.0');
  });

  test('IDs are unique', () => {
    expect(new Set(CATALOG_IDS).size).toBe(CATALOG_IDS.length);
  });

  test('holds every ID transcribed from the normative catalog', () => {
    expect(CATALOG_ENTRIES.length).toBe(83);
  });

  test('distributes IDs across the axes as the source tables do', () => {
    expect(countByAxis()).toEqual({
      PERF: 11,
      A11Y: 13,
      SEO: 31,
      DEPS: 12,
      SEC: 10,
      AGENT: 6,
    });
  });

  test('every ID follows <AXIS>-<OBJECT>-<PROBLEM> in uppercase', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.id).toMatch(/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/);
      expect(entry.id.startsWith(`${entry.axis}-`)).toBe(true);
    }
  });

  test('every entry carries a known phase and base severity', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(PHASES).toContain(entry.phase);
      expect(SEVERITIES).toContain(entry.baseSeverity);
      expect(entry.detects.length).toBeGreaterThan(0);
    }
  });

  test('every owner axis and mentioning axis is a real axis', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(AXES).toContain(entry.ownerAxis);

      for (const axis of entry.mentionedIn) {
        expect(AXES).toContain(axis);
        expect(axis).not.toBe(entry.ownerAxis);
      }
    }
  });

  test('requireEntry throws on an unknown ID', () => {
    expect(() => requireEntry('SEO-NOT-A-REAL-ID')).toThrow(/Unknown catalog ID/);
    expect(findEntry('SEO-NOT-A-REAL-ID')).toBeUndefined();
  });
});

describe('blocking findings', () => {
  test('are exactly the ones marked with the blocking flag in the catalog', () => {
    expect([...BLOCKING_IDS].sort()).toEqual([
      'A11Y-BUTTON-NAME-MISSING',
      'A11Y-KEYBOARD-TRAP',
      'DEPS-VULN-KEV',
      'SEC-TLS-EXPIRED',
      'SEO-CANONICAL-CONFLICT',
      'SEO-NOINDEX-UNINTENDED',
      'SEO-REDIRECT-LOOP',
      'SEO-ROBOTS-BLOCKS-ALL',
      'SEO-STATUS-ERROR',
    ]);
  });

  test('are always critical', () => {
    for (const id of BLOCKING_IDS) {
      expect(requireEntry(id).baseSeverity).toBe('critical');
    }
  });

  test('A11Y-FORM-LABEL-MISSING is high and not blocking', () => {
    const entry = requireEntry('A11Y-FORM-LABEL-MISSING');

    expect(entry.baseSeverity).toBe('high');
    expect(entry.blocking).toBe(false);
    expect(isBlocking('A11Y-FORM-LABEL-MISSING')).toBe(false);
  });
});

describe('mandatory findings', () => {
  test('are the three that keep the report from overclaiming', () => {
    expect([...ALWAYS_EMITTED_IDS].sort()).toEqual([
      'A11Y-MANUAL-REVIEW-PENDING',
      'DEPS-VERSION-UNDETERMINED',
      'PERF-FIELD-UNAVAILABLE',
    ]);
  });

  test('are all info severity, so emitting them never costs points', () => {
    for (const id of ALWAYS_EMITTED_IDS) {
      expect(requireEntry(id).baseSeverity).toBe('info');
    }
  });
});

describe('owner axis for findings that surface twice', () => {
  test('DEPS-SOURCEMAP-EXPOSED belongs to DEPS and is only mentioned in SEC', () => {
    const entry = requireEntry('DEPS-SOURCEMAP-EXPOSED');

    expect(entry.ownerAxis).toBe('DEPS');
    expect(entry.mentionedIn).toEqual(['SEC']);
    expect(entriesOwnedBy('SEC')).not.toContain(entry);
    expect(entriesMentionedIn('SEC')).toContain(entry);
  });

  test('A11Y-LANDMARKS-MISSING belongs to A11Y and is only mentioned in AGENT', () => {
    const entry = requireEntry('A11Y-LANDMARKS-MISSING');

    expect(entry.ownerAxis).toBe('A11Y');
    expect(entry.mentionedIn).toEqual(['AGENT']);
    expect(entriesMentionedIn('AGENT')).toContain(entry);
  });

  test('every other entry is owned by its own axis', () => {
    for (const entry of CATALOG_ENTRIES) {
      if (entry.mentionedIn.length === 0) {
        expect(ownerAxisOf(entry.id)).toBe(entry.axis);
      }
    }
  });

  test('each entry has exactly one owner axis', () => {
    for (const entry of CATALOG_ENTRIES) {
      const owners = AXES.filter((axis) => entriesOwnedBy(axis).includes(entry));

      expect(owners).toEqual([entry.ownerAxis]);
    }
  });
});

describe('deprecation lifecycle', () => {
  test('nothing is retired yet, so every ID is emittable', () => {
    expect(ACTIVE_CATALOG_IDS).toEqual(CATALOG_IDS);
    expect(ACTIVE_ENTRIES.length).toBe(CATALOG_ENTRIES.length);
  });

  test('no entry claims a replacement without being deprecated', () => {
    for (const entry of CATALOG_ENTRIES) {
      if (entry.supersededBy !== undefined) {
        expect(entry.deprecated).toBe(true);
      }
    }
  });

  test('a replacement ID, when named, is itself in the catalog', () => {
    for (const entry of CATALOG_ENTRIES) {
      if (entry.supersededBy !== undefined) {
        expect(CATALOG_IDS).toContain(entry.supersededBy);
      }
    }
  });

  test('retiring an ID removes it from the active set but not from the catalog', () => {
    const retired = defineEntry({
      id: 'SEO-TITLE-MISSING',
      phase: 'M',
      baseSeverity: 'high',
      detects: 'Sin title',
      deprecated: true,
      supersededBy: 'SEO-TITLE-ABSENT',
    });

    expect(retired.deprecated).toBe(true);
    expect(retired.supersededBy).toBe('SEO-TITLE-ABSENT');
    expect(isDeprecated('SEO-TITLE-MISSING')).toBe(false);
  });
});
