/**
 * Builders for a literal `SiteAnalysis`.
 *
 * The same argument as `analysis.fixture.ts`, one level up: eight cross-page
 * catalogue IDs each turn on a relationship between two pages, and a test that
 * needed a live multi-page website to ask "is a two-hop canonical a chain?" is a
 * test nobody writes. Each builder returns a healthy value, so a test names only
 * the relationship it is about.
 */

import { page as healthyPage, links, robots, sitemap, trace } from './analysis.fixture.ts';
import type { SeoAnalysis } from './analysis.ts';
import type { PageDocument } from './page.ts';
import { simhash, words } from './simhash.ts';
import type { SamplePage, SiteAnalysis } from './site.ts';

export const ORIGIN = 'https://example.com';

/** One sampled page at `path`, healthy unless the test breaks something. */
export function samplePage(
  path: string,
  overrides: {
    readonly page?: Partial<PageDocument>;
    readonly analysis?: Partial<SeoAnalysis>;
    readonly sample?: Partial<SamplePage>;
    readonly text?: string;
  } = {},
): SamplePage {
  const url = `${ORIGIN}${path}`;

  const document = healthyPage({
    titles: [`Página ${path}`],
    metas: [
      { name: 'description', content: `Descripción de ${path}.` },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
    canonicals: [url],
    ...overrides.page,
  });

  const analysis: SeoAnalysis = {
    url,
    trace: trace({ requestedUrl: url, finalUrl: url }),
    page: document,
    robots: robots(),
    sitemap: sitemap(),
    links: links(),
    canonical: undefined,
    ...overrides.analysis,
  };

  return {
    url,
    analysis,
    contentHash:
      overrides.text === undefined ? undefined : simhash(words(overrides.text).join(' ')),
    wordCount: document.bodyWordCount,
    inSitemap: true,
    internalLinks: [],
    ...overrides.sample,
  };
}

/** A deep run in which nothing cross-page is wrong. */
export function site(overrides: Partial<SiteAnalysis> = {}): SiteAnalysis {
  const pages = overrides.pages ?? [samplePage('/'), samplePage('/precios'), samplePage('/blog')];
  const seed = pages[0]?.analysis;

  if (seed === undefined) {
    throw new Error('a SiteAnalysis fixture needs at least one page');
  }

  return {
    seed,
    pages,
    sitemapUrls: pages.map((page) => page.url),
    candidateCount: pages.length,
    notes: [],
    ...overrides,
  };
}
