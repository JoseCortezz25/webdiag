/**
 * Test-only builders for an axe report.
 *
 * They exist so the interesting rules — merge, always-emitted, catalogue
 * severity — can be asserted from a handful of lines instead of from a 600 KB
 * captured payload, and so a test can construct a case the live web does not
 * currently offer (a page with zero violations, a rule outside the catalogue).
 */
import type { AxeImpact, AxeNode, AxeReport, AxeRuleResult } from './axe.ts';

export function axeNode(selector: string, overrides: Partial<AxeNode> = {}): AxeNode {
  return {
    target: [selector],
    html: `<span>${selector}</span>`,
    impact: 'serious',
    failureSummary: `Fix any of the following: ${selector}`,
    ...overrides,
  };
}

export function axeRule(
  id: string,
  selectors: readonly string[],
  overrides: Partial<AxeRuleResult> = {},
): AxeRuleResult {
  return {
    id,
    impact: 'serious' as AxeImpact,
    help: `${id} help`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
    tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
    nodes: selectors.map((selector) => axeNode(selector)),
    ...overrides,
  };
}

export function axeReport(overrides: Partial<AxeReport> = {}): AxeReport {
  return {
    testEngine: { name: 'axe-core', version: '4.13.0' },
    url: 'https://example.test/',
    violations: [],
    incomplete: [],
    passes: [],
    ...overrides,
  };
}
