/**
 * The deep crawl's budget arithmetic. The crawl itself is exercised through the
 * probe; this file pins the one rule that keeps the whole-run deadline real.
 */
import { describe, expect, test } from 'bun:test';
import { CRAWL_BUDGET, pageTimeoutFor } from './crawl.ts';

describe('pageTimeoutFor', () => {
  test('a page started early gets the full per-page budget', () => {
    expect(pageTimeoutFor(0, CRAWL_BUDGET.total, CRAWL_BUDGET.page)).toBe(CRAWL_BUDGET.page);
  });

  test('a page started near the deadline only gets what is left', () => {
    const deadline = 75_000;
    // Regression: the deadline used to be checked only before starting a page,
    // so one started at 74 s could still run its full 12 s and the 75 s total
    // was exceeded by up to a page per worker.
    expect(pageTimeoutFor(74_000, deadline, CRAWL_BUDGET.page)).toBe(1_000);
  });

  test('a page started at or after the deadline gets nothing and is skipped', () => {
    expect(pageTimeoutFor(75_000, 75_000, CRAWL_BUDGET.page)).toBe(0);
    expect(pageTimeoutFor(80_000, 75_000, CRAWL_BUDGET.page)).toBe(0);
  });
});
