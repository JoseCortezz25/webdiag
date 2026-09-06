import { describe, expect, test } from 'bun:test';
import { AI_USER_AGENTS, analyzeRobots, parseGroups, unavailableRobots } from './robots.ts';

describe('parseGroups', () => {
  test('consecutive user-agent lines share the rules that follow', () => {
    const groups = parseGroups('User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.agents).toEqual(['gptbot', 'ccbot']);
  });

  test('comments and unknown fields are ignored', () => {
    const groups = parseGroups('# nota\nUser-agent: *\nCrawl-delay: 5\nDisallow: /admin # interno');

    expect(groups[0]?.disallow).toEqual(['/admin']);
  });

  test('a file with no user-agent line produces no groups', () => {
    expect(parseGroups('Sitemap: https://example.com/sitemap.xml')).toEqual([]);
  });
});

describe('analyzeRobots', () => {
  test('reports the AI crawlers a named group disallows at the root', () => {
    const analysis = analyzeRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:');

    expect(analysis.blocked).toEqual(['GPTBot']);
    expect(analysis.wildcardBlocksRoot).toBe(false);
  });

  test('a wildcard block at the root reaches every AI crawler without its own group', () => {
    const analysis = analyzeRobots('User-agent: *\nDisallow: /');

    expect(analysis.wildcardBlocksRoot).toBe(true);
    expect(analysis.blocked).toEqual([...AI_USER_AGENTS]);
  });

  test('a named group overrides the wildcard instead of adding to it', () => {
    const analysis = analyzeRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow:',
    );

    expect(analysis.blocked).not.toContain('ClaudeBot');
    expect(analysis.blocked).toContain('GPTBot');
  });

  test('Allow: / re-opens a root the same group disallowed', () => {
    const analysis = analyzeRobots('User-agent: GPTBot\nDisallow: /\nAllow: /');

    expect(analysis.blocked).toEqual([]);
  });

  test('a partial disallow is not a block at the root', () => {
    const analysis = analyzeRobots('User-agent: GPTBot\nDisallow: /admin');

    expect(analysis.blocked).toEqual([]);
  });

  test('agent matching is case-insensitive', () => {
    expect(analyzeRobots('user-agent: gptbot\ndisallow: /').blocked).toEqual(['GPTBot']);
  });

  test('an empty robots.txt blocks nobody', () => {
    const analysis = analyzeRobots('');

    expect(analysis.available).toBe(true);
    expect(analysis.blocked).toEqual([]);
  });
});

describe('unavailableRobots', () => {
  test('claims nothing when the file could not be read', () => {
    expect(unavailableRobots()).toEqual({
      available: false,
      blocked: [],
      wildcardBlocksRoot: false,
      groups: 0,
    });
  });
});
