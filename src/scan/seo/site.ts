/**
 * What a `deep` run observed across several pages, before anyone decides what
 * it means.
 *
 * This is the same seam `analysis.ts` draws for one page, one level up.
 * Everything that produces a `SiteAnalysis` does I/O — a sampler, a crawl pool,
 * a redirect chain per page — and everything that consumes one (`deep-checks.ts`)
 * is a pure function of this record. Eight cross-page catalogue IDs then become
 * testable from a literal, which is the only way anyone will ever be confident
 * changing what "near-duplicate" means.
 */
import type { SeoAnalysis } from './analysis.ts';

/** One sampled page, plus the few facts only a cross-page check needs. */
export type SamplePage = {
  /** The URL the crawler asked for. `analysis.trace.finalUrl` is where it landed. */
  readonly url: string;
  readonly analysis: SeoAnalysis;
  /**
   * 64-bit simhash of the server-rendered prose, hex. `undefined` when the page
   * had too little text for the comparison to mean anything.
   */
  readonly contentHash: string | undefined;
  readonly wordCount: number;
  /** True when the sitemap declares this URL. Drives the dirty-URL check. */
  readonly inSitemap: boolean;
  /** Same-origin `<a href>` targets, resolved absolute and deduplicated. */
  readonly internalLinks: readonly string[];
};

export type SiteAnalysis = {
  /** The page the operator asked for. Always `pages[0]`. */
  readonly seed: SeoAnalysis;
  /** Every sampled page, seed first, then in the order the sampler chose. */
  readonly pages: readonly SamplePage[];
  /** Page URLs the sitemap declared, bounded. Empty when there is no sitemap. */
  readonly sitemapUrls: readonly string[];
  /** How many URLs the sampler had to choose from, before the budget applied. */
  readonly candidateCount: number;
  /** What the crawl could not do, in plain language. Rides into `raw.notes`. */
  readonly notes: readonly string[];
};
