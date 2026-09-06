/**
 * The one place in this axis that talks to the network.
 *
 * The shape of this file is a budget. Spec §5.2 gives `quick` about 40–60 s for
 * the whole run, so the SEO axis gets a slice of that and spends it in two
 * phases: fetch the page first, because every other request depends on knowing
 * where the page ended up, then fan the four independent lookups out in
 * parallel. Serially this is four round trips; in parallel it is one.
 *
 * Every timeout below is explicit and named. A probe with an unbounded fetch is
 * a probe that will one day hang a CI job on somebody else's slow server.
 */
import type { CanonicalTarget, SeoAnalysis } from './analysis.ts';
import { type Fetcher, fetchText, traceUrl } from './http.ts';
import { checkLinks, type LinkReport } from './links.ts';
import { metaContent, parsePage, resolveUrl } from './page.ts';
import { parseRobots, type RobotsFile } from './robots.ts';
import { inspectSitemap, type SitemapReport, type XmllintRunner } from './sitemap.ts';

/** Budgets, in milliseconds. They sum to well under the `quick` allowance. */
export const BUDGET = {
  page: 20_000,
  robots: 10_000,
  sitemap: 15_000,
  canonical: 10_000,
  links: 25_000,
} as const;

export type CollectOptions = {
  readonly fetchImpl?: Fetcher;
  readonly runXmllint?: XmllintRunner;
  readonly runLychee?: (url: string, timeoutMs: number) => Promise<LinkReport>;
};

function isHtml(headers: Readonly<Record<string, string>>): boolean {
  const type = headers['content-type'] ?? '';
  return /text\/html|application\/xhtml\+xml/i.test(type) || type === '';
}

async function loadRobots(
  origin: string,
  options: CollectOptions,
): Promise<RobotsFile | undefined> {
  const url = new URL('/robots.txt', origin).toString();

  try {
    const response = await fetchText(url, {
      timeoutMs: BUDGET.robots,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    return parseRobots(response.body, url, response.status);
  } catch {
    // Unreachable robots.txt is not "robots.txt says no". It is no information,
    // and the checks that read it correctly produce nothing.
    return undefined;
  }
}

/**
 * Follows the page's own canonical one step, which is what makes
 * `SEO-CANONICAL-CONFLICT` a measurement rather than a guess: the finding is
 * about the *target's* status, and there is no way to know it without asking.
 */
async function loadCanonical(
  declared: string | undefined,
  pageUrl: string,
  options: CollectOptions,
): Promise<CanonicalTarget | undefined> {
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

  const selfReferencing = resolved === pageUrl;

  if (selfReferencing) {
    return {
      declared,
      resolved,
      selfReferencing,
      status: undefined,
      redirected: false,
      finalUrl: resolved,
      noindex: false,
      error: undefined,
    };
  }

  try {
    const trace = await traceUrl(resolved, {
      timeoutMs: BUDGET.canonical,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    const page =
      isHtml(trace.headers) && trace.body !== '' ? await parsePage(trace.body) : undefined;

    const noindex =
      /noindex|(^|[\s,])none([\s,]|$)/i.test(trace.headers['x-robots-tag'] ?? '') ||
      /noindex|(^|[\s,])none([\s,]|$)/i.test(
        page === undefined ? '' : (metaContent(page, 'robots') ?? ''),
      );

    return {
      declared,
      resolved,
      selfReferencing,
      status: trace.status,
      redirected: trace.hops.length > 0,
      finalUrl: trace.finalUrl,
      noindex,
      error: undefined,
    };
  } catch (cause) {
    return {
      declared,
      resolved,
      selfReferencing,
      status: undefined,
      redirected: false,
      finalUrl: undefined,
      noindex: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function emptySitemap(): SitemapReport {
  return {
    candidates: [],
    url: undefined,
    status: undefined,
    found: false,
    declaredInRobots: false,
    root: undefined,
    entryCount: 0,
    byteLength: 0,
    validation: undefined,
    toolError: undefined,
  };
}

export async function collect(url: string, options: CollectOptions = {}): Promise<SeoAnalysis> {
  const fetchOption = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };

  const trace = await traceUrl(url, { timeoutMs: BUDGET.page, ...fetchOption });

  const page = isHtml(trace.headers) && trace.body !== '' ? await parsePage(trace.body) : undefined;

  const origin = new URL(trace.finalUrl).origin;
  const robots = await loadRobots(origin, options);

  const [sitemap, canonical, links] = await Promise.all([
    inspectSitemap(origin, robots?.sitemaps ?? [], {
      timeoutMs: BUDGET.sitemap,
      ...fetchOption,
      ...(options.runXmllint === undefined ? {} : { runXmllint: options.runXmllint }),
    }).catch(emptySitemap),
    loadCanonical(page?.canonicals[0], trace.finalUrl, options),
    checkLinks(trace.finalUrl, {
      timeoutMs: BUDGET.links,
      ...(options.runLychee === undefined ? {} : { run: options.runLychee }),
    }),
  ]);

  return { url, trace, page, robots, sitemap, links, canonical };
}
