/**
 * The judgement calls of the SEO axis, one catalogue ID at a time.
 *
 * Two properties are asserted throughout, and they are the reason this file is
 * long rather than clever:
 *
 *  - **A healthy run is silent.** Every test starts from `healthy()` and breaks
 *    exactly one thing, so a finding that fires is a finding caused by that one
 *    thing. Without this, a check that reports on every page in existence would
 *    pass its own test.
 *  - **No observation invents a severity.** Severity is the catalogue's word;
 *    the probe only says what it saw and how sure it is.
 */
import { describe, expect, test } from 'bun:test';
import { ACTIVE_CATALOG_IDS } from '../../catalog/index.ts';
import { parseRawDocument, RAW_SCHEMA_VERSION } from '../raw.ts';
import {
  canonical,
  healthy,
  links,
  PAGE_URL,
  page,
  robots,
  sitemap,
  trace,
} from './analysis.fixture.ts';
import { coverageNotes, isValidLanguageTag, toObservations } from './checks.ts';

function idsOf(analysis: Parameters<typeof toObservations>[0]): readonly string[] {
  return toObservations(analysis).map((observation) => observation.id);
}

function find(analysis: Parameters<typeof toObservations>[0], id: string) {
  return toObservations(analysis).find((observation) => observation.id === id);
}

describe('a healthy page', () => {
  test('produces no findings at all', () => {
    expect(idsOf(healthy())).toEqual([]);
  });
});

describe('transport', () => {
  test('SEO-STATUS-ERROR fires on a 4xx and quotes the status', () => {
    const observation = find(
      healthy({ trace: trace({ status: 404 }), page: undefined }),
      'SEO-STATUS-ERROR',
    );

    expect(observation?.confidence).toBe('high');
    expect(observation?.evidence.status).toBe(404);
    expect(observation?.title).toContain('404');
  });

  test('SEO-STATUS-ERROR fires on a 5xx with a server-side remediation', () => {
    const observation = find(
      healthy({ trace: trace({ status: 503 }), page: undefined }),
      'SEO-STATUS-ERROR',
    );

    expect(observation?.remediation).toContain('servidor');
  });

  test('a 2xx and a 3xx-free chain report no status error', () => {
    expect(idsOf(healthy({ trace: trace({ status: 200 }) }))).not.toContain('SEO-STATUS-ERROR');
  });

  test('SEO-REDIRECT-CHAIN needs more than one hop, per the catalogue', () => {
    const oneHop = trace({
      requestedUrl: 'https://example.com',
      hops: [{ url: 'https://example.com', status: 301, location: PAGE_URL }],
    });

    expect(idsOf(healthy({ trace: oneHop }))).not.toContain('SEO-REDIRECT-CHAIN');
  });

  test('SEO-REDIRECT-CHAIN fires at two hops and records the whole chain', () => {
    const twoHops = trace({
      requestedUrl: 'http://example.com',
      hops: [
        { url: 'http://example.com', status: 301, location: 'https://example.com' },
        { url: 'https://example.com', status: 301, location: PAGE_URL },
      ],
    });

    const observation = find(healthy({ trace: twoHops }), 'SEO-REDIRECT-CHAIN');

    expect(observation?.count).toBe(2);
    expect(observation?.evidence.hops).toBe(2);
    expect(observation?.evidence.chain).toHaveLength(2);
  });

  test('SEO-REDIRECT-LOOP replaces the chain finding rather than joining it', () => {
    const looping = trace({
      status: 301,
      loop: true,
      loopAt: PAGE_URL,
      hops: [
        { url: PAGE_URL, status: 301, location: 'https://example.com/x' },
        { url: 'https://example.com/x', status: 301, location: PAGE_URL },
      ],
    });

    const ids = idsOf(healthy({ trace: looping, page: undefined }));

    expect(ids).toContain('SEO-REDIRECT-LOOP');
    expect(ids).not.toContain('SEO-REDIRECT-CHAIN');
    expect(
      find(healthy({ trace: looping, page: undefined }), 'SEO-REDIRECT-LOOP')?.evidence
        .repeated_url,
    ).toBe(PAGE_URL);
  });

  test('a loop does not also report a status error for its 3xx', () => {
    const looping = trace({ status: 508, loop: true, loopAt: PAGE_URL });

    expect(idsOf(healthy({ trace: looping, page: undefined }))).not.toContain('SEO-STATUS-ERROR');
  });
});

describe('indexability', () => {
  test('SEO-NOINDEX-UNINTENDED fires on meta robots', () => {
    const analysis = healthy({
      page: page({ metas: [...page().metas, { name: 'robots', content: 'noindex, nofollow' }] }),
    });

    expect(find(analysis, 'SEO-NOINDEX-UNINTENDED')?.evidence['meta[name=robots]']).toBe(
      'noindex, nofollow',
    );
  });

  test('SEO-NOINDEX-UNINTENDED fires on the X-Robots-Tag header', () => {
    const analysis = healthy({
      trace: trace({ headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } }),
    });

    expect(idsOf(analysis)).toContain('SEO-NOINDEX-UNINTENDED');
  });

  test('`none` is noindex spelled differently', () => {
    const analysis = healthy({
      page: page({ metas: [...page().metas, { name: 'googlebot', content: 'none' }] }),
    });

    expect(idsOf(analysis)).toContain('SEO-NOINDEX-UNINTENDED');
  });

  test('nofollow alone is not noindex', () => {
    const analysis = healthy({
      page: page({ metas: [...page().metas, { name: 'robots', content: 'nofollow' }] }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-NOINDEX-UNINTENDED');
  });

  test('`noindexing` in a value is not the noindex token', () => {
    const analysis = healthy({
      page: page({ metas: [...page().metas, { name: 'robots', content: 'noindexing' }] }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-NOINDEX-UNINTENDED');
  });
});

describe('robots.txt', () => {
  test('SEO-ROBOTS-BLOCKS-ALL fires on a total disallow', () => {
    const analysis = healthy({
      robots: robots({ groups: [{ agents: ['*'], rules: [{ type: 'disallow', path: '/' }] }] }),
    });

    const observation = find(analysis, 'SEO-ROBOTS-BLOCKS-ALL');

    expect(observation?.confidence).toBe('high');
    expect(observation?.evidence.rule).toBe('disallow: /');
  });

  test('`Disallow: /` with `Allow: /$` is not a total block', () => {
    const analysis = healthy({
      robots: robots({
        groups: [
          {
            agents: ['*'],
            rules: [
              { type: 'disallow', path: '/' },
              { type: 'allow', path: '/$' },
            ],
          },
        ],
      }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-ROBOTS-BLOCKS-ALL');
  });

  test('SEO-ROBOTS-INVALID counts the offending lines', () => {
    const analysis = healthy({
      robots: robots({
        errors: [
          { line: 3, text: 'Dissalow: /x', reason: "unknown directive 'dissalow'" },
          { line: 7, text: 'nonsense', reason: 'line has no "field: value" separator' },
        ],
      }),
    });

    const observation = find(analysis, 'SEO-ROBOTS-INVALID');

    expect(observation?.count).toBe(2);
    expect(observation?.evidence.total_errors).toBe(2);
  });

  test('SEO-ROBOTS-BLOCKS-ASSETS reports blocked same-origin CSS and JS', () => {
    const analysis = healthy({
      page: page({
        resources: [
          { kind: 'script', url: '/assets/app.js' },
          { kind: 'link', url: '/assets/app.css' },
          { kind: 'img', url: '/assets/hero.png' },
        ],
      }),
      robots: robots({
        groups: [{ agents: ['*'], rules: [{ type: 'disallow', path: '/assets/' }] }],
      }),
    });

    const observation = find(analysis, 'SEO-ROBOTS-BLOCKS-ASSETS');

    expect(observation?.count).toBe(2);
    expect(observation?.evidence.blocked).toEqual([
      'https://example.com/assets/app.css',
      'https://example.com/assets/app.js',
    ]);
  });

  test('a blocked third-party asset is not this site’s robots.txt problem', () => {
    const analysis = healthy({
      page: page({ resources: [{ kind: 'script', url: 'https://cdn.other.test/assets/x.js' }] }),
      robots: robots({
        groups: [{ agents: ['*'], rules: [{ type: 'disallow', path: '/assets/' }] }],
      }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-ROBOTS-BLOCKS-ASSETS');
  });

  test('an absent robots.txt is not a finding', () => {
    expect(
      idsOf(healthy({ robots: undefined, sitemap: sitemap({ declaredInRobots: true }) })),
    ).toEqual([]);
  });

  test('a 404 robots.txt is treated as absent, not as invalid', () => {
    const analysis = healthy({ robots: robots({ status: 404, present: false }) });

    expect(idsOf(analysis)).not.toContain('SEO-ROBOTS-INVALID');
    expect(idsOf(analysis)).not.toContain('SEO-ROBOTS-BLOCKS-ALL');
  });
});

describe('sitemap', () => {
  test('SEO-SITEMAP-MISSING fires when nothing answered, listing what was tried', () => {
    const analysis = healthy({
      sitemap: sitemap({
        found: false,
        url: undefined,
        candidates: ['https://example.com/sitemap.xml'],
      }),
    });

    const observation = find(analysis, 'SEO-SITEMAP-MISSING');

    expect(observation?.evidence.reason).toBe('not-found');
    expect(observation?.evidence.tried).toEqual(['https://example.com/sitemap.xml']);
  });

  test('SEO-SITEMAP-MISSING also covers a sitemap robots.txt never declares', () => {
    const analysis = healthy({ sitemap: sitemap({ declaredInRobots: false }) });

    expect(find(analysis, 'SEO-SITEMAP-MISSING')?.evidence.reason).toBe('not-declared-in-robots');
  });

  test('SEO-SITEMAP-INVALID quotes the validator and the schema', () => {
    const analysis = healthy({
      sitemap: sitemap({
        validation: {
          valid: false,
          schema: 'sitemap',
          errors: ["element 'lastmod': invalid date"],
        },
      }),
    });

    const observation = find(analysis, 'SEO-SITEMAP-INVALID');

    expect(observation?.evidence.validator).toBe('xmllint --schema');
    expect(observation?.evidence.errors).toEqual(["element 'lastmod': invalid date"]);
  });

  test('SEO-SITEMAP-LIMITS-EXCEEDED fires past 50,000 URLs', () => {
    const analysis = healthy({ sitemap: sitemap({ entryCount: 50_001 }) });

    expect(find(analysis, 'SEO-SITEMAP-LIMITS-EXCEEDED')?.evidence.urls).toBe(50_001);
  });

  test('SEO-SITEMAP-LIMITS-EXCEEDED fires on a declared size past 50 MB even when the read was cut', () => {
    const analysis = healthy({
      sitemap: sitemap({ byteLength: 60 * 1024 * 1024, truncated: true, validation: undefined }),
    });

    expect(idsOf(analysis)).toContain('SEO-SITEMAP-LIMITS-EXCEEDED');
    // Only a prefix was read, so no schema verdict exists and none is invented.
    expect(idsOf(analysis)).not.toContain('SEO-SITEMAP-INVALID');
  });

  test('a truncated sitemap and a refused Sitemap: line are stated in the coverage notes', () => {
    const notes = coverageNotes(
      healthy({
        sitemap: sitemap({
          truncated: true,
          validation: undefined,
          refused: ['http://169.254.169.254/latest/'],
        }),
      }),
    );

    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('prefijo');
    expect(notes[1]).toContain('169.254.169.254');
    expect(coverageNotes(healthy())).toEqual([]);
  });

  test('SEO-SITEMAP-LIMITS-EXCEEDED fires past 50 MB', () => {
    const analysis = healthy({ sitemap: sitemap({ byteLength: 51 * 1024 * 1024 }) });

    expect(idsOf(analysis)).toContain('SEO-SITEMAP-LIMITS-EXCEEDED');
  });

  test('a sitemap index is not measured against the per-file URL limit', () => {
    const analysis = healthy({
      sitemap: sitemap({ root: 'sitemapindex', entryCount: 60_000 }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-SITEMAP-LIMITS-EXCEEDED');
  });

  test('a sitemap xmllint could not validate produces no verdict', () => {
    const analysis = healthy({
      sitemap: sitemap({ validation: undefined, toolError: 'xmllint not found' }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-SITEMAP-INVALID');
  });
});

describe('head tags', () => {
  test('SEO-TITLE-MISSING fires on a page with no title', () => {
    expect(idsOf(healthy({ page: page({ titles: [] }) }))).toContain('SEO-TITLE-MISSING');
  });

  test('SEO-META-DESC-MISSING fires when the description is absent', () => {
    const analysis = healthy({
      page: page({ metas: [{ name: 'viewport', content: 'width=device-width' }] }),
    });

    expect(idsOf(analysis)).toContain('SEO-META-DESC-MISSING');
  });

  test('SEO-META-DESC-MISSING fires when the description is empty', () => {
    const analysis = healthy({
      page: page({
        metas: [
          { name: 'description', content: '' },
          { name: 'viewport', content: 'width=device-width' },
        ],
      }),
    });

    expect(idsOf(analysis)).toContain('SEO-META-DESC-MISSING');
  });

  test('SEO-H1-MISSING fires on zero h1', () => {
    const observation = find(healthy({ page: page({ h1Count: 0 }) }), 'SEO-H1-MISSING');

    expect(observation?.evidence.h1_count).toBe(0);
    expect(observation?.remediation).toContain('único');
  });

  test('SEO-H1-MISSING also fires on several h1, with the other fix', () => {
    const observation = find(healthy({ page: page({ h1Count: 3 }) }), 'SEO-H1-MISSING');

    expect(observation?.evidence.h1_count).toBe(3);
    expect(observation?.remediation).toContain('<h2>');
  });

  test('SEO-VIEWPORT-MISSING fires without a viewport meta', () => {
    const analysis = healthy({
      page: page({ metas: [{ name: 'description', content: 'algo' }] }),
    });

    expect(idsOf(analysis)).toContain('SEO-VIEWPORT-MISSING');
  });

  test('an unreachable page reports no head findings', () => {
    const ids = idsOf(healthy({ trace: trace({ status: 503 }), page: undefined }));

    expect(ids).toContain('SEO-STATUS-ERROR');
    expect(ids).not.toContain('SEO-TITLE-MISSING');
    expect(ids).not.toContain('SEO-VIEWPORT-MISSING');
    expect(ids).not.toContain('SEO-CANONICAL-MISSING');
  });
});

describe('canonical', () => {
  test('SEO-CANONICAL-MISSING fires with no canonical anywhere', () => {
    const analysis = healthy({ page: page({ canonicals: [] }), canonical: undefined });

    expect(idsOf(analysis)).toContain('SEO-CANONICAL-MISSING');
  });

  test('a canonical in the Link header counts as declared', () => {
    const analysis = healthy({
      page: page({ canonicals: [] }),
      canonical: undefined,
      trace: trace({
        headers: {
          'content-type': 'text/html',
          link: `<${PAGE_URL}>; rel="canonical"`,
        },
      }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-CANONICAL-MISSING');
  });

  test('SEO-CANONICAL-CONFLICT fires on two different canonicals', () => {
    const analysis = healthy({
      page: page({ canonicals: [PAGE_URL, 'https://example.com/other'] }),
    });

    const observation = find(analysis, 'SEO-CANONICAL-CONFLICT');

    expect(observation?.evidence.reason).toBe('multiple-canonicals');
    expect(observation?.count).toBe(2);
  });

  test('the same canonical declared twice is not a conflict', () => {
    const analysis = healthy({ page: page({ canonicals: [PAGE_URL, PAGE_URL] }) });

    expect(idsOf(analysis)).not.toContain('SEO-CANONICAL-CONFLICT');
  });

  test('SEO-CANONICAL-CONFLICT fires when the target 404s', () => {
    const analysis = healthy({
      page: page({ canonicals: ['https://example.com/gone'] }),
      canonical: canonical({
        declared: 'https://example.com/gone',
        resolved: 'https://example.com/gone',
        selfReferencing: false,
        status: 404,
      }),
    });

    expect(find(analysis, 'SEO-CANONICAL-CONFLICT')?.evidence.reason).toBe('target-error');
  });

  test('SEO-CANONICAL-CONFLICT fires when the target is noindex', () => {
    const analysis = healthy({
      page: page({ canonicals: ['https://example.com/hidden'] }),
      canonical: canonical({
        declared: 'https://example.com/hidden',
        resolved: 'https://example.com/hidden',
        selfReferencing: false,
        status: 200,
        noindex: true,
      }),
    });

    expect(find(analysis, 'SEO-CANONICAL-CONFLICT')?.evidence.reason).toBe('target-noindex');
  });

  test('SEO-CANONICAL-CONFLICT fires when the target redirects', () => {
    const analysis = healthy({
      page: page({ canonicals: ['https://example.com/moved'] }),
      canonical: canonical({
        declared: 'https://example.com/moved',
        resolved: 'https://example.com/moved',
        selfReferencing: false,
        status: 200,
        redirected: true,
        finalUrl: 'https://example.com/final',
      }),
    });

    expect(find(analysis, 'SEO-CANONICAL-CONFLICT')?.evidence.reason).toBe('target-redirects');
  });

  test('a canonical we could not reach is reported as nothing, not as broken', () => {
    const analysis = healthy({
      page: page({ canonicals: ['https://offline.test/'] }),
      canonical: canonical({
        declared: 'https://offline.test/',
        resolved: 'https://offline.test/',
        selfReferencing: false,
        error: 'connect ECONNREFUSED',
      }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-CANONICAL-CONFLICT');
  });

  test('a self-referencing canonical is the healthy case', () => {
    expect(idsOf(healthy())).not.toContain('SEO-CANONICAL-CONFLICT');
  });
});

describe('hreflang', () => {
  test('a page with no hreflang is not judged on it', () => {
    expect(idsOf(healthy({ page: page({ hreflang: [] }) }))).not.toContain('SEO-HREFLANG-INVALID');
  });

  test('SEO-HREFLANG-INVALID fires on a malformed tag', () => {
    const analysis = healthy({
      page: page({
        hreflang: [
          { hreflang: 'es_CO', href: PAGE_URL },
          { hreflang: 'x-default', href: PAGE_URL },
        ],
      }),
    });

    expect(find(analysis, 'SEO-HREFLANG-INVALID')?.evidence.invalid_tags).toEqual(['es_CO']);
  });

  test('SEO-HREFLANG-INVALID also covers a missing x-default, per the catalogue', () => {
    const analysis = healthy({
      page: page({ hreflang: [{ hreflang: 'es-CO', href: PAGE_URL }] }),
    });

    const observation = find(analysis, 'SEO-HREFLANG-INVALID');

    expect(observation?.evidence.x_default_present).toBe(false);
    expect(observation?.remediation).toContain('x-default');
  });

  test('a valid set with x-default reports nothing', () => {
    const analysis = healthy({
      page: page({
        hreflang: [
          { hreflang: 'es-CO', href: PAGE_URL },
          { hreflang: 'x-default', href: PAGE_URL },
        ],
      }),
    });

    expect(idsOf(analysis)).toEqual([]);
  });

  test('SEO-HREFLANG-CANONICAL-CONFLICT fires when the canonical is outside the set', () => {
    const analysis = healthy({
      page: page({
        canonicals: ['https://example.com/en/'],
        hreflang: [
          { hreflang: 'es-CO', href: PAGE_URL },
          { hreflang: 'x-default', href: PAGE_URL },
        ],
      }),
    });

    const observation = find(analysis, 'SEO-HREFLANG-CANONICAL-CONFLICT');

    // It reads two tags rather than fetching, so it infers rather than measures.
    expect(observation?.confidence).toBe('medium');
    expect(observation?.evidence.canonical).toBe('https://example.com/en/');
  });

  test('isValidLanguageTag accepts well-formed BCP 47 and x-default', () => {
    expect(isValidLanguageTag('es')).toBe(true);
    expect(isValidLanguageTag('es-CO')).toBe(true);
    expect(isValidLanguageTag('pt-BR')).toBe(true);
    expect(isValidLanguageTag('es-419')).toBe(true);
    expect(isValidLanguageTag('x-default')).toBe(true);
  });

  test('isValidLanguageTag rejects the malformed codes sites actually ship', () => {
    expect(isValidLanguageTag('es_CO')).toBe(false);
    expect(isValidLanguageTag('')).toBe(false);
    expect(isValidLanguageTag('123')).toBe(false);
    expect(isValidLanguageTag('a')).toBe(false);
    expect(isValidLanguageTag('toolongsubtagvalue')).toBe(false);
  });

  test('well-formedness is the limit: an unregistered-but-legal subtag passes', () => {
    // Documented blind spot, not an oversight. Catching these needs the IANA
    // subtag registry, and the catalogue ID is about malformed codes.
    expect(isValidLanguageTag('english')).toBe(true);
    expect(isValidLanguageTag('zz')).toBe(true);
  });
});

describe('JSON-LD', () => {
  test('a page with no JSON-LD is not judged on it', () => {
    expect(idsOf(healthy({ page: page({ jsonLd: [] }) }))).not.toContain('SEO-JSONLD-INVALID');
  });

  test('SEO-JSONLD-INVALID fires on a block that does not parse', () => {
    const analysis = healthy({ page: page({ jsonLd: ['{ "@type": broken }'] }) });

    expect(idsOf(analysis)).toContain('SEO-JSONLD-INVALID');
  });

  test('SEO-JSONLD-INVALID fires on a block with no @context', () => {
    const analysis = healthy({
      page: page({ jsonLd: ['{"@type":"Person","name":"Ada"}'] }),
    });

    expect(find(analysis, 'SEO-JSONLD-INVALID')?.evidence.problems).toEqual([
      'block 1: missing @context',
    ]);
  });

  test('SEO-JSONLD-INCOMPLETE names the properties a rich result needs', () => {
    const analysis = healthy({
      page: page({
        jsonLd: ['{"@context":"https://schema.org","@type":"Article","headline":"Hola"}'],
      }),
    });

    const observation = find(analysis, 'SEO-JSONLD-INCOMPLETE');

    expect(observation?.confidence).toBe('medium');
    expect(observation?.evidence.missing).toEqual(['article: falta datePublished, author']);
  });

  test('a complete Article reports nothing', () => {
    const analysis = healthy({
      page: page({
        jsonLd: [
          JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: 'Hola',
            datePublished: '2026-01-01',
            author: { '@type': 'Person', name: 'Ada' },
          }),
        ],
      }),
    });

    expect(idsOf(analysis)).toEqual([]);
  });

  test('@graph nodes are read the way a crawler reads them', () => {
    const analysis = healthy({
      page: page({
        jsonLd: [
          JSON.stringify({
            '@context': 'https://schema.org',
            '@graph': [{ '@type': 'Product', name: 'Cosa' }],
          }),
        ],
      }),
    });

    expect(find(analysis, 'SEO-JSONLD-INCOMPLETE')?.evidence.missing).toEqual([
      'product: falta offers',
    ]);
  });

  test('an unlisted @type is not judged on properties it may not need', () => {
    const analysis = healthy({
      page: page({
        jsonLd: ['{"@context":"https://schema.org","@type":"SomethingExotic","x":1}'],
      }),
    });

    expect(idsOf(analysis)).toEqual([]);
  });
});

describe('rendering and links', () => {
  test('SEO-CSR-CONTENT-INVISIBLE infers on a thin JS page', () => {
    const analysis = healthy({
      page: page({ bodyWordCount: 60, scriptsWithSrc: 3 }),
    });

    const observation = find(analysis, 'SEO-CSR-CONTENT-INVISIBLE');

    expect(observation?.confidence).toBe('medium');
    expect(observation?.evidence.server_rendered_words).toBe(60);
  });

  test('SEO-CSR-CONTENT-INVISIBLE is certain when the body is essentially empty', () => {
    const analysis = healthy({
      page: page({ bodyWordCount: 4, scriptsWithSrc: 1, emptyMountRoot: 'root' }),
    });

    expect(find(analysis, 'SEO-CSR-CONTENT-INVISIBLE')?.confidence).toBe('high');
  });

  test('a thin page that ships no JavaScript is just a short page', () => {
    const analysis = healthy({
      page: page({ bodyWordCount: 30, scriptsWithSrc: 0, inlineScripts: 0 }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-CSR-CONTENT-INVISIBLE');
  });

  test('a server-rendered page that also ships JS is not flagged', () => {
    const analysis = healthy({ page: page({ bodyWordCount: 900, scriptsWithSrc: 5 }) });

    expect(idsOf(analysis)).not.toContain('SEO-CSR-CONTENT-INVISIBLE');
  });

  test('SEO-LINKS-NOT-CRAWLABLE is certain when there is no real link at all', () => {
    const analysis = healthy({ page: page({ anchorsWithHref: 0, links: [] }) });

    expect(find(analysis, 'SEO-LINKS-NOT-CRAWLABLE')?.confidence).toBe('high');
  });

  test('SEO-LINKS-NOT-CRAWLABLE infers from nav anchors and pseudo-links', () => {
    const analysis = healthy({ page: page({ navAnchorsWithoutHref: 4, pseudoLinks: 2 }) });

    const observation = find(analysis, 'SEO-LINKS-NOT-CRAWLABLE');

    expect(observation?.confidence).toBe('medium');
    expect(observation?.count).toBe(6);
  });

  test('SEO-MIXED-CONTENT lists the insecure subresources of an https page', () => {
    const analysis = healthy({
      page: page({
        resources: [
          { kind: 'img', url: 'http://cdn.test/a.png' },
          { kind: 'script', url: 'https://cdn.test/b.js' },
        ],
      }),
    });

    const observation = find(analysis, 'SEO-MIXED-CONTENT');

    expect(observation?.count).toBe(1);
    expect(observation?.evidence.resources).toEqual(['http://cdn.test/a.png']);
  });

  test('an http page has no mixed content to report', () => {
    const analysis = healthy({
      trace: trace({ requestedUrl: 'http://example.com/', finalUrl: 'http://example.com/' }),
      page: page({ resources: [{ kind: 'img', url: 'http://cdn.test/a.png' }] }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-MIXED-CONTENT');
  });
});

describe('lychee', () => {
  test('SEO-LINKS-BROKEN reports what lychee found', () => {
    const analysis = healthy({
      links: links({
        total: 20,
        successful: 18,
        broken: [{ url: 'https://dead.test/', status: 'Not Found', code: 404 }],
      }),
    });

    const observation = find(analysis, 'SEO-LINKS-BROKEN');

    expect(observation?.count).toBe(1);
    expect(observation?.evidence.broken).toEqual(['404 https://dead.test/ (Not Found)']);
  });

  test('a lychee that never ran produces no finding, not a clean bill of health', () => {
    const analysis = healthy({
      links: links({ outcome: 'unavailable', detail: 'lychee not on PATH', total: 0 }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-LINKS-BROKEN');
  });

  test('a lychee that timed out produces no finding either', () => {
    const analysis = healthy({
      links: links({ outcome: 'timeout', detail: 'exceeded 25000 ms' }),
    });

    expect(idsOf(analysis)).not.toContain('SEO-LINKS-BROKEN');
  });
});

describe('the contract every observation keeps', () => {
  /** One badly broken page, so most checks fire at once. */
  const broken = healthy({
    trace: trace({
      status: 404,
      headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
      hops: [
        { url: 'http://example.com', status: 301, location: 'https://example.com' },
        { url: 'https://example.com', status: 301, location: PAGE_URL },
      ],
    }),
    page: page({
      titles: [],
      metas: [],
      canonicals: [],
      h1Count: 0,
      hreflang: [{ hreflang: 'es_CO', href: PAGE_URL }],
      jsonLd: ['nope'],
      anchorsWithHref: 0,
      bodyWordCount: 3,
      scriptsWithSrc: 2,
      resources: [{ kind: 'img', url: 'http://cdn.test/a.png' }],
    }),
    canonical: undefined,
    robots: robots({
      groups: [{ agents: ['*'], rules: [{ type: 'disallow', path: '/' }] }],
      errors: [{ line: 1, text: 'oops', reason: 'no separator' }],
      sitemaps: [],
    }),
    sitemap: sitemap({ found: false, url: undefined, declaredInRobots: false }),
    links: links({ broken: [{ url: 'https://dead.test/', status: 'Not Found', code: 404 }] }),
  });

  test('only claims IDs the catalogue knows and a run is allowed to emit', () => {
    const active = new Set(ACTIVE_CATALOG_IDS);

    for (const observation of toObservations(broken)) {
      expect(active.has(observation.id)).toBe(true);
    }
  });

  test('never sets a severity of its own — that is the catalogue’s word', () => {
    for (const observation of toObservations(broken)) {
      expect(observation.severity).toBeUndefined();
    }
  });

  test('gives every observation a count, an affected path and a remediation', () => {
    const observations = toObservations(broken);

    expect(observations.length).toBeGreaterThan(10);

    for (const observation of observations) {
      expect(observation.count).toBeGreaterThanOrEqual(1);
      expect(observation.affected.length).toBeGreaterThanOrEqual(1);
      expect(observation.remediation.length).toBeGreaterThan(20);
    }
  });

  test('never reports the same ID twice in one run', () => {
    const ids = toObservations(broken).map((observation) => observation.id);

    expect(ids).toEqual([...new Set(ids)]);
  });

  test('produces a document the raw schema accepts', () => {
    expect(() =>
      parseRawDocument({
        schema: RAW_SCHEMA_VERSION,
        axis: 'SEO',
        tool: { name: 'webdiag-seo', version: '0.1.0' },
        target: { url: PAGE_URL, mode: 'quick' },
        observations: toObservations(broken),
      }),
    ).not.toThrow();
  });
});
