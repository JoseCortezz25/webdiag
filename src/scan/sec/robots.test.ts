import { describe, expect, test } from 'bun:test';
import type { TextResponse } from './curl.ts';
import {
  checkRobots,
  isAllowed,
  parseRobots,
  requestPath,
  robotsUrl,
  selectGroup,
} from './robots.ts';

function rules(body: string) {
  return selectGroup(parseRobots(body))?.group.rules ?? [];
}

function responder(response: TextResponse | Error) {
  return (): Promise<TextResponse> =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
}

describe('parseRobots', () => {
  test('groups consecutive user-agent lines under one rule set', () => {
    const groups = parseRobots(['User-agent: a', 'User-agent: b', 'Disallow: /x'].join('\n'));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.agents).toEqual(['a', 'b']);
  });

  test('a user-agent after a rule opens a new group', () => {
    const groups = parseRobots(
      ['User-agent: a', 'Disallow: /x', 'User-agent: b', 'Disallow: /y'].join('\n'),
    );

    expect(groups).toHaveLength(2);
  });

  test('ignores comments and rules that precede any user-agent', () => {
    const groups = parseRobots(['Disallow: /orphan', '# comment', 'User-agent: *'].join('\n'));

    expect(groups).toEqual([{ agents: ['*'], rules: [] }]);
  });
});

describe('selectGroup', () => {
  test('prefers a group that names us over the wildcard group', () => {
    const groups = parseRobots(
      ['User-agent: *', 'Disallow: /', 'User-agent: FlareDiagnostics', 'Disallow:'].join('\n'),
    );

    expect(selectGroup(groups)?.agent).toBe('flarediagnostics');
  });

  test('falls back to the wildcard group when nobody names us', () => {
    const groups = parseRobots(
      ['User-agent: Googlebot', 'Disallow: /', 'User-agent: *', 'Disallow: /x'].join('\n'),
    );

    expect(selectGroup(groups)?.agent).toBe('*');
  });

  test('returns nothing when no group applies to us', () => {
    expect(selectGroup(parseRobots('User-agent: Googlebot\nDisallow: /'))).toBeUndefined();
  });
});

describe('isAllowed', () => {
  test('an empty Disallow forbids nothing', () => {
    expect(isAllowed(rules('User-agent: *\nDisallow:'), '/anything')).toBe(true);
  });

  test('the longest matching pattern wins, so Allow can carve out of Disallow: /', () => {
    const parsed = rules('User-agent: *\nDisallow: /\nAllow: /public/');

    expect(isAllowed(parsed, '/public/page')).toBe(true);
    expect(isAllowed(parsed, '/private/page')).toBe(false);
  });

  test('Allow wins a tie against a Disallow of the same length', () => {
    const parsed = rules('User-agent: *\nDisallow: /x\nAllow: /x');

    expect(isAllowed(parsed, '/x')).toBe(true);
  });

  test('supports * as a wildcard and $ as an end anchor', () => {
    expect(isAllowed(rules('User-agent: *\nDisallow: /*.pdf$'), '/docs/a.pdf')).toBe(false);
    expect(isAllowed(rules('User-agent: *\nDisallow: /*.pdf$'), '/docs/a.pdf?x=1')).toBe(true);
  });

  test('treats pattern characters as literals, not as regex', () => {
    expect(isAllowed(rules('User-agent: *\nDisallow: /a+b'), '/aaab')).toBe(true);
    expect(isAllowed(rules('User-agent: *\nDisallow: /a+b'), '/a+b')).toBe(false);
  });
});

describe('requestPath and robotsUrl', () => {
  test('the query string is part of what a rule matches', () => {
    expect(requestPath('https://example.com/a?b=1')).toBe('/a?b=1');
  });

  test('robots.txt is looked up at the origin, whatever the path was', () => {
    expect(robotsUrl('https://example.com:8443/deep/page')).toBe(
      'https://example.com:8443/robots.txt',
    );
  });
});

describe('checkRobots', () => {
  test('a 404 means no rules, so nothing is disallowed', async () => {
    const decision = await checkRobots('https://example.com/', {
      fetch: responder({ status: 404, body: '' }),
    });

    expect(decision.allowed).toBe(true);
  });

  test('a 503 is a full disallow: an outage is not permission', async () => {
    const decision = await checkRobots('https://example.com/', {
      fetch: responder({ status: 503, body: '' }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('RFC 9309');
  });

  test('an unreachable robots.txt is a full disallow too', async () => {
    const decision = await checkRobots('https://example.com/', {
      fetch: responder(new Error('curl: (6) Could not resolve host')),
    });

    expect(decision.allowed).toBe(false);
  });

  test('honours a group written for this user-agent', async () => {
    const decision = await checkRobots('https://example.com/private', {
      fetch: responder({
        status: 200,
        body: 'User-agent: FlareDiagnostics\nDisallow: /private',
      }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.matchedAgent).toBe('flarediagnostics');
  });

  test('reports the path it decided about', async () => {
    const decision = await checkRobots('https://example.com/ok', {
      fetch: responder({ status: 200, body: 'User-agent: *\nDisallow: /private' }),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('/ok');
  });
});
