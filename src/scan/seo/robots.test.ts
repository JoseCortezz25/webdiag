/**
 * The robots.txt parser and the RFC 9309 matcher.
 *
 * The matcher gets the most attention here because it is the one place in the
 * axis where being approximately right files a blocking critical against a site
 * that is fine. `Disallow: /` plus `Allow: /$` is a real pattern, and a
 * "does the path start with the rule" reading calls it a total block.
 */
import { describe, expect, test } from 'bun:test';
import { groupFor, parseRobots, pathOf, verdictFor } from './robots.ts';

const URL_ROBOTS = 'https://example.com/robots.txt';

function parse(body: string, status = 200) {
  return parseRobots(body, URL_ROBOTS, status);
}

describe('parseRobots', () => {
  test('reads a group, its rules and the sitemap line', () => {
    const robots = parse(
      [
        '# comentario',
        'User-agent: *',
        'Disallow: /admin/',
        'Allow: /admin/public',
        '',
        'Sitemap: https://example.com/sitemap.xml',
      ].join('\n'),
    );

    expect(robots.present).toBe(true);
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['*']);
    expect(robots.groups[0]?.rules).toEqual([
      { type: 'disallow', path: '/admin/' },
      { type: 'allow', path: '/admin/public' },
    ]);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(robots.errors).toEqual([]);
  });

  test('a run of consecutive User-agent lines is one group', () => {
    const robots = parse(
      ['User-agent: googlebot', 'User-agent: bingbot', 'Disallow: /x'].join('\n'),
    );

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['googlebot', 'bingbot']);
  });

  test('a User-agent after a rule starts a new group', () => {
    const robots = parse(
      ['User-agent: *', 'Disallow: /a', 'User-agent: googlebot', 'Disallow: /b'].join('\n'),
    );

    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[1]?.agents).toEqual(['googlebot']);
    expect(robots.groups[1]?.rules).toEqual([{ type: 'disallow', path: '/b' }]);
  });

  test('strips comments, including trailing ones', () => {
    const robots = parse(['User-agent: *', 'Disallow: /a # por ahora'].join('\n'));

    expect(robots.groups[0]?.rules).toEqual([{ type: 'disallow', path: '/a' }]);
  });

  test('ignores blank lines and CRLF endings', () => {
    const robots = parse('User-agent: *\r\n\r\nDisallow: /a\r\n');

    expect(robots.errors).toEqual([]);
    expect(robots.groups[0]?.rules).toEqual([{ type: 'disallow', path: '/a' }]);
  });

  test('reports a line with no separator, with its line number', () => {
    const robots = parse(['User-agent: *', 'esto no es una directiva'].join('\n'));

    expect(robots.errors).toEqual([
      { line: 2, text: 'esto no es una directiva', reason: 'line has no "field: value" separator' },
    ]);
  });

  test('reports an unknown directive, which is how typos surface', () => {
    const robots = parse(['User-agent: *', 'Dissalow: /admin'].join('\n'));

    expect(robots.errors[0]?.reason).toBe("unknown directive 'dissalow'");
  });

  test('reports a rule that appears before any User-agent', () => {
    const robots = parse('Disallow: /admin');

    expect(robots.errors[0]?.reason).toBe('disallow before any User-agent line');
    expect(robots.groups).toEqual([]);
  });

  test('reports a Sitemap without a URL and a User-agent without a value', () => {
    const robots = parse(['Sitemap:', 'User-agent:'].join('\n'));

    expect(robots.errors.map((error) => error.reason)).toEqual([
      'Sitemap without a URL',
      'User-agent without a value',
    ]);
    expect(robots.sitemaps).toEqual([]);
  });

  test('accepts the recognised-but-meaningless directives without complaining', () => {
    const robots = parse(['User-agent: *', 'Crawl-delay: 10', 'Host: example.com'].join('\n'));

    expect(robots.errors).toEqual([]);
  });

  test('a non-2xx robots.txt is not present, whatever its body said', () => {
    const robots = parse('User-agent: *\nDisallow: /', 404);

    expect(robots.present).toBe(false);
  });

  test('an empty file is present and permits everything', () => {
    const robots = parse('');

    expect(robots.present).toBe(true);
    expect(robots.groups).toEqual([]);
    expect(verdictFor(robots, 'googlebot', '/').allowed).toBe(true);
  });
});

describe('groupFor', () => {
  test('prefers the most specific agent name over the wildcard', () => {
    const robots = parse(
      ['User-agent: *', 'Disallow: /', 'User-agent: googlebot', 'Allow: /'].join('\n'),
    );

    expect(groupFor(robots, 'googlebot')?.rules).toEqual([{ type: 'allow', path: '/' }]);
  });

  test('falls back to the wildcard for an agent nobody named', () => {
    const robots = parse(
      ['User-agent: *', 'Disallow: /a', 'User-agent: bingbot', 'Disallow: /'].join('\n'),
    );

    expect(groupFor(robots, 'googlebot')?.rules).toEqual([{ type: 'disallow', path: '/a' }]);
  });

  test('returns nothing when no group applies', () => {
    const robots = parse(['User-agent: bingbot', 'Disallow: /'].join('\n'));

    expect(groupFor(robots, 'googlebot')).toBeUndefined();
  });
});

describe('verdictFor', () => {
  test('an unmatched path is allowed', () => {
    const robots = parse(['User-agent: *', 'Disallow: /admin/'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/blog/').allowed).toBe(true);
  });

  test('a matched Disallow blocks and names the deciding rule', () => {
    const robots = parse(['User-agent: *', 'Disallow: /admin/'].join('\n'));
    const verdict = verdictFor(robots, 'googlebot', '/admin/users');

    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toEqual({ type: 'disallow', path: '/admin/' });
  });

  test('the longest matching rule wins', () => {
    const robots = parse(
      ['User-agent: *', 'Disallow: /admin/', 'Allow: /admin/public/'].join('\n'),
    );

    expect(verdictFor(robots, 'googlebot', '/admin/public/x').allowed).toBe(true);
    expect(verdictFor(robots, 'googlebot', '/admin/secret').allowed).toBe(false);
  });

  test('an equal-length tie goes to Allow', () => {
    const robots = parse(['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/x').allowed).toBe(true);
  });

  test('`Disallow: /` blocks everything', () => {
    const robots = parse(['User-agent: *', 'Disallow: /'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/').allowed).toBe(false);
    expect(verdictFor(robots, 'googlebot', '/cualquier/cosa').allowed).toBe(false);
  });

  test('`Disallow: /` with `Allow: /$` leaves only the home page crawlable', () => {
    const robots = parse(['User-agent: *', 'Disallow: /', 'Allow: /$'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/').allowed).toBe(true);
    expect(verdictFor(robots, 'googlebot', '/blog').allowed).toBe(false);
  });

  test('an empty Disallow value disallows nothing', () => {
    const robots = parse(['User-agent: *', 'Disallow:'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/').allowed).toBe(true);
  });

  test('`*` inside a pattern is a wildcard', () => {
    const robots = parse(['User-agent: *', 'Disallow: /*.pdf'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/docs/manual.pdf').allowed).toBe(false);
    expect(verdictFor(robots, 'googlebot', '/docs/manual.html').allowed).toBe(true);
  });

  test('a trailing `$` anchors the pattern to the end of the path', () => {
    const robots = parse(['User-agent: *', 'Disallow: /x$'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/x').allowed).toBe(false);
    expect(verdictFor(robots, 'googlebot', '/xyz').allowed).toBe(true);
  });

  test('regex metacharacters in a pattern are matched literally', () => {
    const robots = parse(['User-agent: *', 'Disallow: /a+b(c)'].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/a+b(c)').allowed).toBe(false);
    expect(verdictFor(robots, 'googlebot', '/aab').allowed).toBe(true);
  });

  test('patterns are matched against the query string too', () => {
    const robots = parse(['User-agent: *', 'Disallow: /*?session='].join('\n'));

    expect(verdictFor(robots, 'googlebot', '/p?session=1').allowed).toBe(false);
    expect(verdictFor(robots, 'googlebot', '/p?page=1').allowed).toBe(true);
  });
});

describe('pathOf', () => {
  test('keeps the path and the query, which is what patterns match', () => {
    expect(pathOf('https://example.com/a/b?c=1#frag')).toBe('/a/b?c=1');
  });

  test('a bare origin is the root path', () => {
    expect(pathOf('https://example.com')).toBe('/');
  });
});
