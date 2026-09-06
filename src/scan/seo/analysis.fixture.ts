/**
 * Builders for a literal `SeoAnalysis`.
 *
 * These exist so the twenty-odd judgement calls in `checks.ts` can be exercised
 * one at a time. A test that had to stand up a fixture web server to ask "does a
 * 503 suppress the head-tag findings?" is a test nobody writes, and the check
 * would then be the only part of the axis nobody had ever pinned down.
 *
 * Each builder returns a *healthy* value, so a test names only the one thing it
 * is about and the finding under test is the only one that can fire.
 */
import type { CanonicalTarget, SeoAnalysis } from './analysis.ts';
import type { FetchTrace } from './http.ts';
import type { LinkReport } from './links.ts';
import type { PageDocument } from './page.ts';
import type { RobotsFile } from './robots.ts';
import type { SitemapReport } from './sitemap.ts';

export const PAGE_URL = 'https://example.com/';

export function trace(overrides: Partial<FetchTrace> = {}): FetchTrace {
  return {
    requestedUrl: PAGE_URL,
    finalUrl: PAGE_URL,
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '',
    truncated: false,
    hops: [],
    loop: false,
    loopAt: undefined,
    ...overrides,
  };
}

/** A page with every head tag in place and enough prose to look server-rendered. */
export function page(overrides: Partial<PageDocument> = {}): PageDocument {
  return {
    lang: 'es',
    titles: ['Ejemplo'],
    metas: [
      { name: 'description', content: 'Una descripción suficientemente larga.' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
    canonicals: [PAGE_URL],
    hreflang: [],
    h1Count: 1,
    jsonLd: [],
    anchorsWithHref: 12,
    anchorsWithoutHref: 0,
    navAnchorsWithoutHref: 0,
    pseudoLinks: 0,
    links: ['/a', '/b'],
    resources: [],
    scriptsWithSrc: 0,
    inlineScripts: 0,
    bodyWordCount: 800,
    emptyMountRoot: undefined,
    ...overrides,
  };
}

export function robots(overrides: Partial<RobotsFile> = {}): RobotsFile {
  return {
    status: 200,
    url: 'https://example.com/robots.txt',
    present: true,
    groups: [{ agents: ['*'], rules: [{ type: 'allow', path: '/' }] }],
    sitemaps: ['https://example.com/sitemap.xml'],
    errors: [],
    ...overrides,
  };
}

export function sitemap(overrides: Partial<SitemapReport> = {}): SitemapReport {
  return {
    candidates: ['https://example.com/sitemap.xml'],
    url: 'https://example.com/sitemap.xml',
    status: 200,
    found: true,
    declaredInRobots: true,
    root: 'urlset',
    entryCount: 40,
    byteLength: 4_096,
    validation: { valid: true, schema: 'sitemap', errors: [] },
    toolError: undefined,
    ...overrides,
  };
}

export function links(overrides: Partial<LinkReport> = {}): LinkReport {
  return {
    outcome: 'ok',
    detail: undefined,
    total: 12,
    successful: 12,
    excluded: 0,
    broken: [],
    ...overrides,
  };
}

export function canonical(overrides: Partial<CanonicalTarget> = {}): CanonicalTarget {
  return {
    declared: PAGE_URL,
    resolved: PAGE_URL,
    selfReferencing: true,
    status: undefined,
    redirected: false,
    finalUrl: PAGE_URL,
    noindex: false,
    error: undefined,
    ...overrides,
  };
}

/** A run in which nothing is wrong. Every test starts here and breaks one thing. */
export function healthy(overrides: Partial<SeoAnalysis> = {}): SeoAnalysis {
  return {
    url: PAGE_URL,
    trace: trace(),
    page: page(),
    robots: robots(),
    sitemap: sitemap(),
    links: links(),
    canonical: canonical(),
    ...overrides,
  };
}
