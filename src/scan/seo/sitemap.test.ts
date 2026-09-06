/**
 * The sitemap check.
 *
 * Discovery and the limits run against an injected fetcher and an injected
 * validator, so they are fast and deterministic. The schema itself is then
 * exercised against the *real* `xmllint`, because a hand-checked XSD that has
 * never been handed to libxml is a document nobody has validated. Those tests
 * skip themselves when the binary is absent rather than failing the suite —
 * spec §5.1 asks for xmllint, but a contributor without it still gets a green
 * run and `meta.json` still records that it was missing.
 */
import { describe, expect, test } from 'bun:test';
import type { Fetcher } from './http.ts';
import {
  inspectSitemap,
  MAX_SITEMAP_URLS,
  runXmllintValidation,
  type XmllintRunner,
  xmllintVersion,
} from './sitemap.ts';
import { SITEINDEX_XSD, SITEMAP_XSD } from './sitemap-schema.ts';

const ORIGIN = 'https://example.com';
const CONVENTIONAL = 'https://example.com/sitemap.xml';

const VALID_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-01-01</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url><loc>https://example.com/blog</loc></url>
</urlset>`;

const VALID_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc><lastmod>2026-01-01</lastmod></sitemap>
</sitemapindex>`;

/** Serves a fixed table of bodies; anything else 404s. */
function serve(bodies: Readonly<Record<string, string>>): Fetcher {
  return (url) =>
    Promise.resolve(
      bodies[url] === undefined
        ? new Response('', { status: 404 })
        : new Response(bodies[url], {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
    );
}

const ALWAYS_VALID: XmllintRunner = () => Promise.resolve({ ok: true, stderr: '' });

function options(fetchImpl: Fetcher, runXmllint: XmllintRunner = ALWAYS_VALID) {
  return { timeoutMs: 1_000, fetchImpl, runXmllint };
}

const hasXmllint = (await xmllintVersion()) !== undefined;

describe('inspectSitemap discovery', () => {
  test('finds the conventional /sitemap.xml when robots.txt declares nothing', async () => {
    const report = await inspectSitemap(
      ORIGIN,
      [],
      options(serve({ [CONVENTIONAL]: VALID_SITEMAP })),
    );

    expect(report.found).toBe(true);
    expect(report.url).toBe(CONVENTIONAL);
    expect(report.declaredInRobots).toBe(false);
    expect(report.root).toBe('urlset');
    expect(report.entryCount).toBe(2);
  });

  test('prefers what robots.txt declared and records that it was declared', async () => {
    const declared = 'https://example.com/sitemap_index.xml';
    const report = await inspectSitemap(
      ORIGIN,
      [declared],
      options(serve({ [declared]: VALID_SITEMAP, [CONVENTIONAL]: VALID_SITEMAP })),
    );

    expect(report.url).toBe(declared);
    expect(report.declaredInRobots).toBe(true);
  });

  test('falls through a declared sitemap that 404s to the conventional one', async () => {
    const report = await inspectSitemap(
      ORIGIN,
      ['https://example.com/missing.xml'],
      options(serve({ [CONVENTIONAL]: VALID_SITEMAP })),
    );

    expect(report.url).toBe(CONVENTIONAL);
    expect(report.declaredInRobots).toBe(false);
    expect(report.candidates).toEqual(['https://example.com/missing.xml', CONVENTIONAL]);
  });

  test('reports not-found when nothing answers, listing every candidate tried', async () => {
    const report = await inspectSitemap(ORIGIN, [], options(serve({})));

    expect(report.found).toBe(false);
    expect(report.url).toBeUndefined();
    expect(report.candidates).toEqual([CONVENTIONAL]);
    expect(report.validation).toBeUndefined();
  });

  test('a fetch that throws is skipped rather than ending the check', async () => {
    const fetchImpl: Fetcher = (url) =>
      url === CONVENTIONAL
        ? Promise.resolve(new Response(VALID_SITEMAP, { status: 200 }))
        : Promise.reject(new Error('ECONNREFUSED'));

    const report = await inspectSitemap(ORIGIN, ['https://offline.test/s.xml'], options(fetchImpl));

    expect(report.url).toBe(CONVENTIONAL);
  });

  test('recognises a sitemap index and counts its <sitemap> entries', async () => {
    const report = await inspectSitemap(
      ORIGIN,
      [],
      options(serve({ [CONVENTIONAL]: VALID_INDEX })),
    );

    expect(report.root).toBe('sitemapindex');
    expect(report.entryCount).toBe(1);
    expect(report.validation?.schema).toBe('siteindex');
  });

  test('handles a namespace-prefixed root and prefixed entries', async () => {
    const prefixed = `<?xml version="1.0"?>
<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sm:url><sm:loc>https://example.com/</sm:loc></sm:url>
</sm:urlset>`;

    const report = await inspectSitemap(ORIGIN, [], options(serve({ [CONVENTIONAL]: prefixed })));

    expect(report.root).toBe('urlset');
    expect(report.entryCount).toBe(1);
  });

  test('an XML document that is not a sitemap is invalid, without asking xmllint', async () => {
    const notASitemap = '<?xml version="1.0"?><rss version="2.0"><channel/></rss>';
    const report = await inspectSitemap(
      ORIGIN,
      [],
      options(serve({ [CONVENTIONAL]: notASitemap })),
    );

    expect(report.found).toBe(true);
    expect(report.root).toBe('unknown');
    expect(report.validation?.valid).toBe(false);
    expect(report.validation?.errors[0]).toContain('not <urlset> nor <sitemapindex>');
  });

  test('an HTML 200 at /sitemap.xml counts as no sitemap, not as an invalid one', async () => {
    // A catch-all SPA route answering 200 with an app shell is the common case.
    const report = await inspectSitemap(
      ORIGIN,
      [],
      options(serve({ [CONVENTIONAL]: 'not xml at all' })),
    );

    expect(report.found).toBe(false);
  });

  test('measures the byte length and the entry count for the limit check', async () => {
    const many = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${'<url><loc>https://example.com/x</loc></url>'.repeat(120)}</urlset>`;
    const report = await inspectSitemap(ORIGIN, [], options(serve({ [CONVENTIONAL]: many })));

    expect(report.entryCount).toBe(120);
    expect(report.byteLength).toBe(new TextEncoder().encode(many).length);
    expect(report.entryCount).toBeLessThan(MAX_SITEMAP_URLS);
  });

  test('a validator that throws degrades the check instead of inventing a verdict', async () => {
    const broken: XmllintRunner = () => Promise.reject(new Error('xmllint: command not found'));
    const report = await inspectSitemap(
      ORIGIN,
      [],
      options(serve({ [CONVENTIONAL]: VALID_SITEMAP }), broken),
    );

    expect(report.found).toBe(true);
    expect(report.validation).toBeUndefined();
    expect(report.toolError).toContain('command not found');
  });

  test('a failing validation carries the trimmed errors', async () => {
    const failing: XmllintRunner = () =>
      Promise.resolve({
        ok: false,
        stderr: ['xmllint: warning to drop', 's.xml:4: element loc: bad value', ''].join('\n'),
      });

    const report = await inspectSitemap(
      ORIGIN,
      [],
      options(serve({ [CONVENTIONAL]: VALID_SITEMAP }), failing),
    );

    expect(report.validation?.valid).toBe(false);
    expect(report.validation?.errors).toEqual(['s.xml:4: element loc: bad value']);
  });
});

describe('xmllint, for real', () => {
  test.skipIf(!hasXmllint)('reports a libxml version, which meta.json records', async () => {
    expect(await xmllintVersion()).toMatch(/^\d+$/);
  });

  test.skipIf(!hasXmllint)('accepts a valid urlset against the sitemaps.org schema', async () => {
    const result = await runXmllintValidation(SITEMAP_XSD, VALID_SITEMAP);

    expect(result.ok).toBe(true);
  });

  test.skipIf(!hasXmllint)('accepts a valid sitemapindex', async () => {
    const result = await runXmllintValidation(SITEINDEX_XSD, VALID_INDEX);

    expect(result.ok).toBe(true);
  });

  test.skipIf(!hasXmllint)('rejects a urlset whose <url> has no <loc>', async () => {
    const missingLoc = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><lastmod>2026-01-01</lastmod></url>
</urlset>`;

    const result = await runXmllintValidation(SITEMAP_XSD, missingLoc);

    expect(result.ok).toBe(false);
    expect(result.stderr).not.toBe('');
  });

  test.skipIf(!hasXmllint)('rejects an out-of-range <priority>', async () => {
    const badPriority = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><priority>7</priority></url>
</urlset>`;

    expect((await runXmllintValidation(SITEMAP_XSD, badPriority)).ok).toBe(false);
  });

  test.skipIf(!hasXmllint)('rejects an unknown <changefreq>', async () => {
    const badFreq = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><changefreq>sometimes</changefreq></url>
</urlset>`;

    expect((await runXmllintValidation(SITEMAP_XSD, badFreq)).ok).toBe(false);
  });

  test.skipIf(!hasXmllint)('rejects malformed XML outright', async () => {
    expect((await runXmllintValidation(SITEMAP_XSD, '<urlset><url></urlset>')).ok).toBe(false);
  });

  test.skipIf(!hasXmllint)('rejects a sitemapindex offered as a urlset', async () => {
    expect((await runXmllintValidation(SITEMAP_XSD, VALID_INDEX)).ok).toBe(false);
  });

  test.skipIf(!hasXmllint)('validates end to end through inspectSitemap', async () => {
    // No injected runner: this is the real subprocess, the real schema.
    const report = await inspectSitemap(ORIGIN, [], {
      timeoutMs: 5_000,
      fetchImpl: serve({ [CONVENTIONAL]: VALID_SITEMAP }),
    });

    expect(report.validation).toEqual({ valid: true, schema: 'sitemap', errors: [] });
    expect(report.toolError).toBeUndefined();
  });

  test.skipIf(!hasXmllint)('does not leave its temporary files behind', async () => {
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    await runXmllintValidation(SITEMAP_XSD, VALID_SITEMAP);
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith('webdiag-sitemap-'),
    );

    expect(leftovers).toEqual([]);
  });
});
