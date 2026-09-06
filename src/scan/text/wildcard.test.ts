import { describe, expect, test } from 'bun:test';
import { matchesRobotsPattern } from './wildcard.ts';

describe('matchesRobotsPattern', () => {
  test.each([
    ['/', '/anything', true],
    ['/admin/', '/admin/panel', true],
    ['/admin/', '/administrator', false],
    ['/*.pdf$', '/docs/a.pdf', true],
    ['/*.pdf$', '/docs/a.pdf?x=1', false],
    ['/*.pdf', '/docs/a.pdf?x=1', true],
    ['/a+b', '/a+b', true],
    ['/a+b', '/aaab', false],
    ['/a.b', '/axb', false],
    ['/*/x', '/1/2/x', true],
    ['/**/x$', '/1/x', true],
    ['/x$', '/x', true],
    ['/x$', '/xy', false],
    ['/pri*/pa*', '/private/pages/1', true],
  ])('%s against %s → %s', (pattern, path, expected) => {
    expect(matchesRobotsPattern(pattern, path)).toBe(expected);
  });

  test('a pattern with many stars against a long path finishes immediately', () => {
    // Regression: as a regex this is `^/.*a.*a.*a.*a.*a$`, which backtracks
    // polynomially on a long path that does not end in `a`.
    const path = `/${'a'.repeat(50_000)}b`;
    const started = performance.now();

    expect(matchesRobotsPattern('/*a*a*a*a*a$', path)).toBe(false);
    expect(matchesRobotsPattern('/*a*a*a*a*a', `${path}a`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
