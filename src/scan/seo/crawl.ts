/**
 * The `deep` crawl: pick 5–10 representative pages, and fetch them.
 *
 * Two things decide the shape of this file.
 *
 * **"Representative" is a real requirement, not a synonym for "the first ten".**
 * A blog's sitemap lists 400 articles and 3 section pages; taking the first ten
 * URLs samples one template ten times and reports nothing the seed page did not
 * already say. So candidates are bucketed by their first path segment and drawn
 * round-robin: `/`, `/blog/x`, `/precios`, `/docs/y`, `/blog/z` — breadth first,
 * depth only once every section has been seen.
 *
 * **The sample must not depend on the wind.** Same site, same sitemap, same ten
 * pages: `findings.json` is compared between audits, and a sampler that shuffles
 * would make every diff meaningless. Every ordering below is total and derived
 * from the URLs themselves — no clock, no `Math.random`, no `Set` iteration order
 * standing in for a decision.
 */
import type { CanonicalTarget, SeoAnalysis } from './analysis.ts';
import { type Fetcher, traceUrl } from './http.ts';
import { bodyText, metaContent, parsePage, resolveUrl } from './page.ts';
import { MIN_WORDS_FOR_SIMHASH, simhash, words } from './simhash.ts';
import type { SamplePage, SiteAnalysis } from './site.ts';

/** Spec §5.2 and issue #9: a deep run samples between 5 and 10 pages. */
export const MIN_DEEP_PAGES = 5;
export const MAX_DEEP_PAGES = 10;

export const CRAWL_BUDGET = {
  /** Per page. Shorter than the seed's 20 s: nine of these run after it. */
  page: 12_000,
  /**
   * The whole crawl. When it runs out the crawl stops with what it has and says
   * so in a note — a partial sample honestly labelled beats a run that spends
   * the operator's six-minute ceiling on one slow server.
   */
  total: 75_000,
  /** Simultaneous page fetches. Four is polite to a small origin and still fast. */
  concurrency: 4,
} as const;

/** Extensions a crawler would not read as a page. Cheap filter, big saving. */
const NON_PAGE =
  /\.(?:pdf|zip|gz|tar|rar|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|webp|avif|svg|ico|mp[34]|mov|webm|css|js|json|xml|txt|rss|atom)(?:$|\?)/i;

export type CrawlOptions = {
  readonly fetchImpl?: Fetcher;
  /** Injected so tests can freeze the deadline instead of racing a real clock. */
  readonly now?: () => number;
  /** The host the operator named; see `TraceOptions.scanHost`. */
  readonly scanHost?: string | undefined;
};

/**
 * How long one page fetch may take, given how much of the whole crawl is left.
 *
 * The per-page budget alone does not bound the crawl: a page started one
 * second before the deadline would still be allowed its full twelve, and with
 * four in flight the 75 s total could run to nearly twice that. So a fetch gets
 * the smaller of the two, and a page with no time left is not started at all.
 */
export function pageTimeoutFor(now: number, deadline: number, perPage: number): number {
  return Math.max(0, Math.min(perPage, deadline - now));
}

/** Fragment stripped, because `#top` is the same page to every crawler. */
function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** `https://a.test/blog/x?p=1` → `blog`. The empty string for the root. */
function firstSegment(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter((part) => part !== '')[0] ?? '';
  } catch {
    return '';
  }
}

function depthOf(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter((part) => part !== '').length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Same origin, http(s), and something a crawler would treat as a page. */
export function isCrawlable(url: string, origin: string): boolean {
  return url.startsWith(`${origin}/`) && !NON_PAGE.test(url);
}

/** Resolved, same-origin, deduplicated `<a href>` targets of one page. */
export function internalLinksOf(analysis: SeoAnalysis, origin: string): readonly string[] {
  const page = analysis.page;

  if (page === undefined) {
    return [];
  }

  const resolved = page.links
    .flatMap((href) => {
      const absolute = resolveUrl(href, analysis.trace.finalUrl);
      return absolute === undefined ? [] : [absolute];
    })
    .flatMap((absolute) => {
      const normalized = normalizeUrl(absolute);
      return normalized === undefined ? [] : [normalized];
    })
    .filter((url) => url.startsWith(`${origin}/`));

  return [...new Set(resolved)].sort();
}

/**
 * Chooses which pages a deep run visits.
 *
 * Sitemap URLs come first within each section: they are what the site itself
 * says matters, and visiting them is what lets `SEO-SITEMAP-DIRTY-URLS` be a
 * measurement instead of an opinion. Beyond that, shallower before deeper, then
 * alphabetical — a total order, so the sample is reproducible.
 */
export function sampleUrls(
  seedUrl: string,
  linked: readonly string[],
  sitemapUrls: readonly string[],
  budget: number,
): readonly string[] {
  const origin = new URL(seedUrl).origin;
  const seed = normalizeUrl(seedUrl);
  const fromSitemap = new Set<string>();

  const candidates = new Map<string, string>();

  for (const [source, urls] of [
    ['sitemap', sitemapUrls],
    ['linked', linked],
  ] as const) {
    for (const raw of urls) {
      const url = normalizeUrl(raw);

      if (url === undefined || url === seed || !isCrawlable(url, origin)) {
        continue;
      }

      if (source === 'sitemap') {
        fromSitemap.add(url);
      }

      if (!candidates.has(url)) {
        candidates.set(url, source);
      }
    }
  }

  const buckets = new Map<string, string[]>();

  for (const url of [...candidates.keys()].sort()) {
    const key = firstSegment(url);
    buckets.set(key, [...(buckets.get(key) ?? []), url]);
  }

  for (const [key, urls] of buckets) {
    buckets.set(
      key,
      [...urls].sort((left, right) => {
        const bySource = Number(!fromSitemap.has(left)) - Number(!fromSitemap.has(right));
        if (bySource !== 0) {
          return bySource;
        }

        const byDepth = depthOf(left) - depthOf(right);
        return byDepth !== 0 ? byDepth : left < right ? -1 : 1;
      }),
    );
  }

  // Round-robin across sections, so ten pages describe ten parts of the site.
  const keys = [...buckets.keys()].sort();
  const picked: string[] = [];

  for (let round = 0; picked.length < budget; round += 1) {
    const before = picked.length;

    for (const key of keys) {
      if (picked.length >= budget) {
        break;
      }

      const url = buckets.get(key)?.[round];

      if (url !== undefined) {
        picked.push(url);
      }
    }

    if (picked.length === before) {
      break;
    }
  }

  return picked;
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;

      const item = items[index];

      if (item === undefined) {
        return;
      }

      results[index] = await task(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

function isHtml(headers: Readonly<Record<string, string>>): boolean {
  const type = headers['content-type'] ?? '';
  return /text\/html|application\/xhtml\+xml/i.test(type) || type === '';
}

/**
 * The canonical target of a crawled page, resolved from the crawl when possible.
 *
 * A deep run already holds the target's status, redirects and robots meta for
 * every page it visited, so asking the network again would buy nothing and cost
 * a round trip per page. A canonical pointing outside the sample stays
 * unresolved rather than half-guessed: `canonicalObservations` treats an
 * unreachable target as no finding, which is the honest answer.
 */
function canonicalFromCrawl(
  declared: string | undefined,
  pageUrl: string,
  visited: ReadonlyMap<string, SeoAnalysis>,
): CanonicalTarget | undefined {
  if (declared === undefined) {
    return undefined;
  }

  const resolved = resolveUrl(declared, pageUrl);

  if (resolved === undefined) {
    return {
      declared,
      resolved: declared,
      selfReferencing: false,
      status: undefined,
      redirected: false,
      finalUrl: undefined,
      noindex: false,
      error: 'the canonical href is not a valid URL',
    };
  }

  if (resolved === pageUrl) {
    return {
      declared,
      resolved,
      selfReferencing: true,
      status: undefined,
      redirected: false,
      finalUrl: resolved,
      noindex: false,
      error: undefined,
    };
  }

  const target = visited.get(normalizeUrl(resolved) ?? resolved);

  if (target === undefined) {
    return {
      declared,
      resolved,
      selfReferencing: false,
      status: undefined,
      redirected: false,
      finalUrl: undefined,
      noindex: false,
      error: 'the canonical target was not part of the sampled pages',
    };
  }

  const metaRobots = target.page === undefined ? '' : (metaContent(target.page, 'robots') ?? '');
  const noindex =
    /noindex|(^|[\s,])none([\s,]|$)/i.test(target.trace.headers['x-robots-tag'] ?? '') ||
    /noindex|(^|[\s,])none([\s,]|$)/i.test(metaRobots);

  return {
    declared,
    resolved,
    selfReferencing: false,
    status: target.trace.status,
    redirected: target.trace.hops.length > 0,
    finalUrl: target.trace.finalUrl,
    noindex,
    error: undefined,
  };
}

/**
 * Fetches the sampled pages and assembles the `SiteAnalysis`.
 *
 * The site-level facts — robots.txt, the sitemap, the link report — are the
 * seed's, shared by reference into every page's `SeoAnalysis`. They describe the
 * site once and are checked once; copying them per page is what would turn one
 * missing sitemap into eight findings.
 */
export async function crawlSite(
  seed: SeoAnalysis,
  budget: number,
  options: CrawlOptions = {},
): Promise<SiteAnalysis> {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + CRAWL_BUDGET.total;
  const notes: string[] = [];

  const origin = new URL(seed.trace.finalUrl).origin;
  const sitemapUrls = seed.sitemap.locs.filter((url) => isCrawlable(url, origin));
  const seedLinks = internalLinksOf(seed, origin);

  const wanted = Math.max(MIN_DEEP_PAGES, Math.min(MAX_DEEP_PAGES, budget));
  const targets = sampleUrls(seed.trace.finalUrl, seedLinks, sitemapUrls, wanted - 1);

  if (targets.length < wanted - 1) {
    notes.push(
      `El sitio ofrecía ${targets.length + 1} páginas distintas para muestrear y se pidieron ${wanted}: el crawl profundo cubre menos de lo previsto.`,
    );
  }

  const traces = await pooled(targets, CRAWL_BUDGET.concurrency, async (url) => {
    const timeoutMs = pageTimeoutFor(now(), deadline, CRAWL_BUDGET.page);

    if (timeoutMs <= 0) {
      return { url, analysis: undefined, skipped: true } as const;
    }

    try {
      const trace = await traceUrl(url, {
        timeoutMs,
        scanHost: options.scanHost,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });

      const page =
        isHtml(trace.headers) && trace.body !== '' ? await parsePage(trace.body) : undefined;

      return { url, analysis: { trace, page }, skipped: false } as const;
    } catch {
      // One unreachable page narrows the sample. It is not a finding: the site
      // may simply have linked to something behind a login.
      return { url, analysis: undefined, skipped: false } as const;
    }
  });

  const skipped = traces.filter((entry) => entry.skipped).length;
  const failed = traces.filter((entry) => !entry.skipped && entry.analysis === undefined).length;

  if (skipped > 0) {
    notes.push(
      `El crawl profundo agotó su presupuesto de ${CRAWL_BUDGET.total / 1000} s y dejó ${skipped} página(s) sin visitar.`,
    );
  }

  if (failed > 0) {
    notes.push(`${failed} página(s) muestreada(s) no respondieron y quedaron fuera del análisis.`);
  }

  const visited = new Map<string, SeoAnalysis>();

  visited.set(normalizeUrl(seed.trace.finalUrl) ?? seed.trace.finalUrl, seed);

  const partial: { readonly url: string; readonly analysis: SeoAnalysis }[] = [];

  for (const entry of traces) {
    if (entry.analysis === undefined) {
      continue;
    }

    const analysis: SeoAnalysis = {
      url: entry.url,
      trace: entry.analysis.trace,
      page: entry.analysis.page,
      robots: seed.robots,
      sitemap: seed.sitemap,
      links: seed.links,
      canonical: undefined,
    };

    partial.push({ url: entry.url, analysis });
    visited.set(normalizeUrl(entry.analysis.trace.finalUrl) ?? entry.url, analysis);
  }

  const sitemapSet = new Set(sitemapUrls.map((url) => normalizeUrl(url) ?? url));

  function toSample(url: string, analysis: SeoAnalysis, canonical: CanonicalTarget | undefined) {
    const text = analysis.page === undefined ? '' : bodyText(analysis.trace.body);
    const wordCount = analysis.page?.bodyWordCount ?? 0;
    const normalized = normalizeUrl(analysis.trace.finalUrl) ?? url;

    return {
      url,
      analysis: { ...analysis, canonical },
      contentHash: wordCount >= MIN_WORDS_FOR_SIMHASH ? simhash(words(text).join(' ')) : undefined,
      wordCount,
      inSitemap: sitemapSet.has(normalized) || sitemapSet.has(normalizeUrl(url) ?? url),
      internalLinks: internalLinksOf(analysis, origin),
    } satisfies SamplePage;
  }

  const pages: readonly SamplePage[] = [
    // The seed keeps the canonical target `collect` already fetched for it:
    // that one *was* a live measurement and outranks a lookup in the sample.
    toSample(seed.url, seed, seed.canonical),
    ...partial.map(({ url, analysis }) =>
      toSample(
        url,
        analysis,
        canonicalFromCrawl(analysis.page?.canonicals[0], analysis.trace.finalUrl, visited),
      ),
    ),
  ];

  return {
    seed,
    pages,
    sitemapUrls,
    candidateCount: new Set([...sitemapUrls, ...seedLinks]).size,
    notes,
  };
}
