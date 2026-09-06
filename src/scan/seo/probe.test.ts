/**
 * The probe seam and the collector.
 *
 * `seoProbe` takes its collector as a parameter, which is what lets these tests
 * assert the raw document's shape without a socket. `collect` is then driven
 * through an injected fetcher and injected tool runners, so the parallel fan-out
 * and the degradation paths are exercised without a network or a subprocess.
 */
import { describe, expect, test } from 'bun:test';
import { ACTIVE_CATALOG_IDS, scoreAxes } from '../../catalog/index.ts';
import { VERSION } from '../../version.ts';
import { normalize } from '../normalize.ts';
import { type ProbeContext, runProbe } from '../probe.ts';
import { parseRawDocument, RAW_SCHEMA_VERSION } from '../raw.ts';
import { healthy, PAGE_URL, page, trace } from './analysis.fixture.ts';
import { BUDGET, collect } from './collect.ts';
import type { Fetcher } from './http.ts';
import type { LinkReport } from './links.ts';
import { resolveToolVersion, SEO_TOOL, seoProbe } from './probe.ts';
import type { XmllintRunner } from './sitemap.ts';

const CONTEXT: ProbeContext = { url: PAGE_URL, mode: 'quick', pages: 1 };

const HTML = `<!doctype html><html lang="es"><head>
  <title>Ejemplo</title>
  <meta name="description" content="Una descripción de la página.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="${PAGE_URL}">
</head><body><h1>Hola</h1><a href="/otra">Otra</a>
${'palabra '.repeat(300)}</body></html>`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
</urlset>`;

const ROBOTS = ['User-agent: *', 'Allow: /', 'Sitemap: https://example.com/sitemap.xml'].join('\n');

const NO_LINKS: LinkReport = {
  outcome: 'ok',
  detail: undefined,
  total: 1,
  successful: 1,
  excluded: 0,
  broken: [],
};

const VALID_XML: XmllintRunner = () => Promise.resolve({ ok: true, stderr: '' });

/** What one URL answers. Plain data, so a route is declared rather than built. */
type Route = {
  readonly body?: string;
  readonly status?: number;
  readonly type?: string;
  readonly location?: string;
};

const HEALTHY_SITE: Readonly<Record<string, Route>> = {
  [PAGE_URL]: { body: HTML, type: 'text/html; charset=utf-8' },
  'https://example.com/robots.txt': { body: ROBOTS, type: 'text/plain' },
  'https://example.com/sitemap.xml': { body: SITEMAP, type: 'application/xml' },
};

/** A whole healthy site in one table, so the fan-out has something to fan out to. */
function site(overrides: Readonly<Record<string, Route>> = {}): {
  fetch: Fetcher;
  calls: string[];
} {
  const calls: string[] = [];
  const routes = { ...HEALTHY_SITE, ...overrides };

  const fetch: Fetcher = (url) => {
    calls.push(url);

    const route = routes[url];

    if (route === undefined) {
      return Promise.resolve(new Response('', { status: 404 }));
    }

    const headers: Record<string, string> = { 'content-type': route.type ?? 'text/html' };
    if (route.location !== undefined) {
      headers.location = route.location;
    }

    return Promise.resolve(
      new Response(route.body ?? '', { status: route.status ?? 200, headers }),
    );
  };

  return { fetch, calls };
}

function collectOptions(fetchImpl: Fetcher) {
  return { fetchImpl, runXmllint: VALID_XML, runLychee: () => Promise.resolve(NO_LINKS) };
}

describe('seoProbe', () => {
  test('emits a raw document the schema accepts', async () => {
    const document = await seoProbe(() => Promise.resolve(healthy())).run(CONTEXT);

    expect(() => parseRawDocument(document)).not.toThrow();
    expect(document.schema).toBe(RAW_SCHEMA_VERSION);
    expect(document.axis).toBe('SEO');
    expect(document.target).toEqual({ url: PAGE_URL, mode: 'quick' });
  });

  test('a healthy site produces no SEO observations', async () => {
    const document = await seoProbe(() => Promise.resolve(healthy())).run(CONTEXT);

    expect(document.observations).toEqual([]);
  });

  test('passes the context URL to the collector rather than a hard-coded one', async () => {
    const seen: string[] = [];
    await seoProbe((context) => {
      seen.push(context.url);
      return Promise.resolve(healthy());
    }).run({ ...CONTEXT, url: 'https://otra.test/x' });

    expect(seen).toEqual(['https://otra.test/x']);
  });

  test('declares the SEO axis and its own tool identity', () => {
    const probe = seoProbe(() => Promise.resolve(healthy()));

    expect(probe.axis).toBe('SEO');
    expect(probe.tool).toEqual(SEO_TOOL);
    expect(SEO_TOOL.name).toBe('webdiag-seo');
  });

  test('a collector that rejects lets the orchestrator narrow the run', async () => {
    const probe = seoProbe(() => Promise.reject(new Error('ENOTFOUND example.invalid')));

    expect(probe.run(CONTEXT)).rejects.toThrow('ENOTFOUND');
  });

  test('its findings survive normalization into catalogue findings', async () => {
    const broken = healthy({
      trace: trace({ headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } }),
      page: page({ titles: [] }),
    });

    const document = await seoProbe(() => Promise.resolve(broken)).run(CONTEXT);
    const { findings } = normalize([document]);
    const ids = findings.map((finding) => finding.id);

    expect(ids).toContain('SEO-NOINDEX-UNINTENDED');
    expect(ids).toContain('SEO-TITLE-MISSING');

    // The catalogue, not the probe, decides what a finding is worth. The probe
    // sent no severity at all; this one comes from the entry.
    const noindex = findings.find((finding) => finding.id === 'SEO-NOINDEX-UNINTENDED');
    expect(noindex?.severity).toBe('critical');
    expect(noindex?.confidence).toBe('high');
    expect(noindex?.mode).toBe('quick');

    // Traceable back to this probe and this tool, per spec §6.
    expect(noindex?.tool).toContain('webdiag-seo');
    expect(noindex?.source).toContain('seo');
  });

  test('a blocking SEO finding fixes the SEO axis at 0 and touches no other', async () => {
    const noindexed = healthy({
      trace: trace({ headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } }),
    });

    const document = await seoProbe(() => Promise.resolve(noindexed)).run(CONTEXT);
    const scores = scoreAxes(normalize([document]).findings);

    expect(scores.SEO.score).toBe(0);
    expect(scores.SEO.zeroed).toBe(true);
    expect(scores.SEO.zeroedBy).toEqual(['SEO-NOINDEX-UNINTENDED']);

    // The axes this run never measured keep their full score.
    expect(scores.PERF.zeroed).toBe(false);
    expect(scores.PERF.score).toBe(100);
    expect(scores.A11Y.score).toBe(100);
  });

  test('a non-blocking SEO finding deducts instead of zeroing the axis', async () => {
    const untitled = healthy({ page: page({ titles: [] }) });

    const document = await seoProbe(() => Promise.resolve(untitled)).run(CONTEXT);
    const scores = scoreAxes(normalize([document]).findings);

    expect(scores.SEO.zeroed).toBe(false);
    expect(scores.SEO.score).toBeGreaterThan(0);
    expect(scores.SEO.score).toBeLessThan(100);
  });

  test('only claims IDs the catalogue knows', async () => {
    const active = new Set(ACTIVE_CATALOG_IDS);
    const document = await seoProbe(() => Promise.resolve(healthy())).run(CONTEXT);

    for (const observation of document.observations) {
      expect(active.has(observation.id)).toBe(true);
    }
  });
});

describe('the tool identity meta.json records', () => {
  test('runProbe records the version the run resolved, not the declared one', async () => {
    const probe = seoProbe(() => Promise.resolve(healthy()));
    const outcome = await runProbe(probe, CONTEXT);

    expect(outcome.status).toBe('ok');
    // The declared identity carries no helper versions; the resolved one does,
    // and spec §6 wants every tool's version in `meta.json`.
    expect(probe.tool.version).not.toContain('lychee');
    expect(outcome.tool.version).toContain('lychee-');
    expect(outcome.tool.version).toContain('libxml-');
  });

  test('a failed probe keeps its declared identity, because no tool contributed', async () => {
    const probe = seoProbe(() => Promise.reject(new Error('ENOTFOUND')));
    const outcome = await runProbe(probe, CONTEXT);

    expect(outcome.status).toBe('failed');
    expect(outcome.tool).toEqual(SEO_TOOL);
  });
});

describe('resolveToolVersion', () => {
  test('records both helpers, naming an absent one rather than omitting it', async () => {
    const tool = await resolveToolVersion();

    expect(tool.name).toBe('webdiag-seo');
    expect(tool.version).toStartWith(`${VERSION}+lychee-`);
    expect(tool.version).toContain('+libxml-');
    // "we did not check your links" and "your links are fine" must not look alike.
    expect(tool.version).toMatch(/\+lychee-(absent|[\d.]+)\+libxml-(absent|\d+)$/);
  });
});

describe('collect', () => {
  test('reads the page, robots.txt and the sitemap in one pass', async () => {
    const { fetch, calls } = site();
    const analysis = await collect(PAGE_URL, collectOptions(fetch));

    expect(analysis.url).toBe(PAGE_URL);
    expect(analysis.trace.status).toBe(200);
    expect(analysis.page?.titles).toEqual(['Ejemplo']);
    expect(analysis.robots?.present).toBe(true);
    expect(analysis.sitemap.found).toBe(true);
    expect(calls).toContain('https://example.com/robots.txt');
    expect(calls).toContain('https://example.com/sitemap.xml');
  });

  test('a healthy site collected end to end produces no findings', async () => {
    const { fetch } = site();
    const analysis = await collect(PAGE_URL, collectOptions(fetch));
    const document = await seoProbe(() => Promise.resolve(analysis)).run(CONTEXT);

    expect(document.observations).toEqual([]);
  });

  test('an unreachable robots.txt is no information, not a finding', async () => {
    const { fetch } = site({ 'https://example.com/robots.txt': { status: 500 } });
    const analysis = await collect(PAGE_URL, collectOptions(fetch));

    expect(analysis.robots?.present).toBe(false);
  });

  test('a non-HTML response leaves the page unparsed instead of guessing', async () => {
    const { fetch } = site({
      [PAGE_URL]: { body: '{"ok":true}', type: 'application/json' },
    });

    const analysis = await collect(PAGE_URL, collectOptions(fetch));

    expect(analysis.page).toBeUndefined();
  });

  test('follows the redirect chain and collects against where it landed', async () => {
    const { fetch } = site({
      'https://example.com/old': { status: 301, location: PAGE_URL },
    });

    const analysis = await collect('https://example.com/old', collectOptions(fetch));

    expect(analysis.trace.finalUrl).toBe(PAGE_URL);
    expect(analysis.trace.hops).toHaveLength(1);
    expect(analysis.page?.titles).toEqual(['Ejemplo']);
  });

  test('a self-referencing canonical is resolved without a second request', async () => {
    const { fetch, calls } = site();
    const analysis = await collect(PAGE_URL, collectOptions(fetch));

    expect(analysis.canonical?.selfReferencing).toBe(true);
    expect(calls.filter((url) => url === PAGE_URL)).toHaveLength(1);
  });

  test('follows a foreign canonical one step and reports what it found', async () => {
    const target = 'https://example.com/canon';
    const withCanonical = HTML.replace(PAGE_URL, target);
    const { fetch } = site({
      [PAGE_URL]: { body: withCanonical },
      [target]: { status: 404 },
    });

    const analysis = await collect(PAGE_URL, collectOptions(fetch));

    expect(analysis.canonical?.selfReferencing).toBe(false);
    expect(analysis.canonical?.status).toBe(404);
  });

  test('a canonical that cannot be reached is recorded as an error, not as broken', async () => {
    const withCanonical = HTML.replace(PAGE_URL, 'https://offline.test/');
    const { fetch } = site({ [PAGE_URL]: { body: withCanonical } });
    const fetchImpl: Fetcher = (url, init) =>
      url === 'https://offline.test/'
        ? Promise.reject(new Error('ECONNREFUSED'))
        : fetch(url, init);

    const analysis = await collect(PAGE_URL, collectOptions(fetchImpl));

    expect(analysis.canonical?.error).toContain('ECONNREFUSED');
    expect(analysis.canonical?.status).toBeUndefined();
  });

  test('a canonical href that is not a URL is reported without a request', async () => {
    const withCanonical = HTML.replace(PAGE_URL, 'http://');
    const { fetch } = site({ [PAGE_URL]: { body: withCanonical } });

    const analysis = await collect(PAGE_URL, collectOptions(fetch));

    expect(analysis.canonical?.error).toContain('not a valid URL');
  });

  test('a lychee that never ran does not fail the collection', async () => {
    const { fetch } = site();
    const analysis = await collect(PAGE_URL, {
      fetchImpl: fetch,
      runXmllint: VALID_XML,
      runLychee: () =>
        Promise.resolve({
          outcome: 'unavailable' as const,
          detail: 'lychee not on PATH',
          total: 0,
          successful: 0,
          excluded: 0,
          broken: [],
        }),
    });

    expect(analysis.links.outcome).toBe('unavailable');
    expect(analysis.page?.titles).toEqual(['Ejemplo']);
  });

  test('an xmllint that is missing degrades the sitemap check only', async () => {
    const { fetch } = site();
    const analysis = await collect(PAGE_URL, {
      fetchImpl: fetch,
      runXmllint: () => Promise.reject(new Error('xmllint: command not found')),
      runLychee: () => Promise.resolve(NO_LINKS),
    });

    expect(analysis.sitemap.found).toBe(true);
    expect(analysis.sitemap.toolError).toContain('command not found');
    expect(analysis.sitemap.validation).toBeUndefined();
  });

  test('a sitemap lookup that throws leaves an empty report, not a rejection', async () => {
    const { fetch } = site();
    const fetchImpl: Fetcher = (url, init) =>
      url.endsWith('/sitemap.xml') ? Promise.reject(new Error('ETIMEDOUT')) : fetch(url, init);

    const analysis = await collect(PAGE_URL, collectOptions(fetchImpl));

    expect(analysis.sitemap.found).toBe(false);
    expect(analysis.page?.titles).toEqual(['Ejemplo']);
  });

  test('an unreachable page rejects, because there is nothing to report on', async () => {
    const fetchImpl: Fetcher = () => Promise.reject(new Error('ENOTFOUND'));

    expect(collect(PAGE_URL, collectOptions(fetchImpl))).rejects.toThrow('ENOTFOUND');
  });
});

describe('the quick budget', () => {
  test('every phase is bounded, so no run hangs on somebody else’s server', () => {
    for (const value of Object.values(BUDGET)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(25_000);
    }
  });

  test('the critical path fits the 40–60 s quick allowance of spec §5.2', () => {
    // The page is fetched first, then robots, then the four lookups fan out in
    // parallel — so the worst case is page + robots + the slowest of the fan-out.
    const worstCase =
      BUDGET.page + BUDGET.robots + Math.max(BUDGET.sitemap, BUDGET.canonical, BUDGET.links);

    expect(worstCase).toBeLessThanOrEqual(60_000);
  });
});
