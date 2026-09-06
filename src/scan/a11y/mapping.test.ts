import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_CATALOG_IDS,
  entriesForAxis,
  isBlocking,
  requireEntry,
} from '../../catalog/index.ts';
import {
  A11Y_RULE_MAPPINGS,
  MANUAL_REVIEW_ID,
  mappedAxeRules,
  mappingForAxeRule,
} from './mapping.ts';

/** The IDs the ticket names as this probe's contract. */
const REQUIRED_IDS = [
  'A11Y-CONTRAST-INSUFFICIENT',
  'A11Y-IMG-ALT-MISSING',
  'A11Y-FORM-LABEL-MISSING',
  'A11Y-BUTTON-NAME-MISSING',
  'A11Y-LANG-MISSING',
  'A11Y-HEADING-ORDER',
  'A11Y-ARIA-INVALID',
  'A11Y-LANDMARKS-MISSING',
] as const;

describe('the axe → catalog mapping', () => {
  test('covers every ID the probe promises, plus the always-emitted one', () => {
    const mapped = A11Y_RULE_MAPPINGS.map((mapping) => mapping.catalogId);

    for (const id of REQUIRED_IDS) {
      expect(mapped).toContain(id);
    }
    expect(requireEntry(MANUAL_REVIEW_ID).alwaysEmitted).toBe(true);
  });

  test('emits only IDs a new run is still allowed to emit', () => {
    for (const mapping of A11Y_RULE_MAPPINGS) {
      expect(ACTIVE_CATALOG_IDS).toContain(mapping.catalogId);
    }
    expect(ACTIVE_CATALOG_IDS).toContain(MANUAL_REVIEW_ID);
  });

  test('never routes one axe rule to two catalog IDs', () => {
    // Two owners for one rule would count the same failing node twice and
    // inflate `count`, which the merge rule (spec §6) has no way to undo.
    const seen = new Map<string, string>();

    for (const mapping of A11Y_RULE_MAPPINGS) {
      for (const rule of mapping.axeRules) {
        const owner = seen.get(rule);
        expect(owner === undefined || owner === mapping.catalogId).toBe(true);
        seen.set(rule, mapping.catalogId);
      }
    }

    expect(seen.size).toBe(mappedAxeRules().length);
  });

  test('keeps every mapped rule inside the A11Y axis', () => {
    const a11yIds = entriesForAxis('A11Y').map((entry) => entry.id);

    for (const mapping of A11Y_RULE_MAPPINGS) {
      expect(a11yIds).toContain(mapping.catalogId);
    }
  });

  test('audits against AA, so the AAA contrast rule is not mapped', () => {
    // `A11Y-CONTRAST-INSUFFICIENT` means "por debajo de WCAG AA". Mapping
    // `color-contrast-enhanced` would fail sites that meet the standard.
    expect(mappingForAxeRule('color-contrast')?.catalogId).toBe('A11Y-CONTRAST-INSUFFICIENT');
    expect(mappingForAxeRule('color-contrast-enhanced')).toBeUndefined();
  });

  test('routes the button/link name rules to the blocking finding', () => {
    for (const rule of ['button-name', 'link-name', 'input-button-name', 'aria-command-name']) {
      expect(mappingForAxeRule(rule)?.catalogId).toBe('A11Y-BUTTON-NAME-MISSING');
    }
    expect(isBlocking('A11Y-BUTTON-NAME-MISSING')).toBe(true);
  });

  test('gives every mapping a remediation a reader can act on', () => {
    for (const mapping of A11Y_RULE_MAPPINGS) {
      expect(mapping.axeRules.length).toBeGreaterThan(0);
      expect(mapping.remediation.length).toBeGreaterThan(20);
    }
  });

  test('reports an unmapped rule as unmapped rather than guessing', () => {
    expect(mappingForAxeRule('meta-viewport')).toBeUndefined();
  });
});
