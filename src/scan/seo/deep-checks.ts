/**
 * The eight catalogue IDs that only exist once you have looked at more than one
 * page (issue #9).
 *
 * Everything here is pure, like `checks.ts`: a `SiteAnalysis` in, observations
 * out. What is new is the failure mode. A single-page check either saw the tag
 * or it did not; a cross-page check is looking at a *sample*, and the difference
 * between "no page links to this URL" and "none of the eight pages I happened to
 * open links to this URL" is the whole difference between a finding and a libel.
 *
 * So two rules run through this file:
 *
 *  - **Confidence carries the coverage.** A conclusion that only holds because
 *    the sample was complete says `high`; one drawn from a partial view says
 *    `low`, and `scoring.ts` then keeps it out of the score while the report
 *    still lists it. `SEO-ORPHAN-PAGES` is the sharp case and gets a hard gate:
 *    on a site whose sitemap dwarfs the sample the check does not run at all,
 *    and says so in a note.
 *  - **One ID, one observation, `count: N`.** Spec §6. A title repeated on six
 *    pages is one finding about six pages, never six findings.
 */
import type { RawObservation } from '../raw.ts';
import { pathOf } from './robots.ts';
import { hammingDistance, NEAR_DUPLICATE_DISTANCE } from './simhash.ts';
import type { SamplePage, SiteAnalysis } from './site.ts';

/** Kept short so `findings.json` stays readable on a site with hundreds. */
const MAX_LISTED = 20;

/**
 * Orphan detection is skipped when the sitemap is more than this many times the
 * sample. Past it, "no incoming links" only means "not linked from the pages I
 * read", and reporting 400 orphans from an 8-page crawl is noise wearing the
 * costume of a finding.
 */
const ORPHAN_COVERAGE_RATIO = 3;

function pathFor(url: string): string {
  try {
    return pathOf(url);
  } catch {
    return url;
  }
}

function normalize(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Where a sampled page ended up, which is the identity every check compares. */
function finalUrlOf(page: SamplePage): string {
  return page.analysis.trace.finalUrl;
}

/** Only pages a crawler would actually index are worth comparing to each other. */
function indexablePages(site: SiteAnalysis): readonly SamplePage[] {
  return site.pages.filter(
    (page) =>
      page.analysis.page !== undefined &&
      page.analysis.trace.status >= 200 &&
      page.analysis.trace.status < 300,
  );
}

/** Whitespace-collapsed and lower-cased: "Inicio " and "inicio" are one title. */
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Groups pages by a normalised string and keeps the groups with more than one
 * member. The shared shape behind both duplicate-tag checks.
 */
function duplicateGroups(
  pages: readonly SamplePage[],
  valueFor: (page: SamplePage) => string | undefined,
): readonly { readonly value: string; readonly pages: readonly string[] }[] {
  const groups = new Map<string, string[]>();

  for (const page of pages) {
    const raw = valueFor(page);

    if (raw === undefined || raw.trim() === '') {
      continue;
    }

    const key = normalizeText(raw);
    groups.set(key, [...(groups.get(key) ?? []), pathFor(finalUrlOf(page))]);
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([value, members]) => ({ value, pages: [...members].sort() }))
    .sort((left, right) => (left.value < right.value ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Duplicate head tags
// ---------------------------------------------------------------------------

export function titleDuplicateObservations(site: SiteAnalysis): readonly RawObservation[] {
  const pages = indexablePages(site);
  const groups = duplicateGroups(pages, (page) => page.analysis.page?.titles[0]);

  if (groups.length === 0) {
    return [];
  }

  const affected = [...new Set(groups.flatMap((group) => group.pages))].sort();

  return [
    {
      id: 'SEO-TITLE-DUPLICATE',
      confidence: 'high',
      count: affected.length,
      affected: affected.slice(0, MAX_LISTED),
      evidence: {
        pages_compared: pages.length,
        duplicate_groups: groups.length,
        titles: groups
          .slice(0, MAX_LISTED)
          .map((group) => `"${group.value}" → ${group.pages.join(', ')}`),
      },
      remediation:
        'Dar a cada página un <title> propio que la distinga: con títulos repetidos el buscador elige una de las páginas y descarta las demás como duplicadas.',
    },
  ];
}

export function metaDescriptionDuplicateObservations(
  site: SiteAnalysis,
): readonly RawObservation[] {
  const pages = indexablePages(site);

  const groups = duplicateGroups(
    pages,
    (page) => page.analysis.page?.metas.find((meta) => meta.name === 'description')?.content,
  );

  if (groups.length === 0) {
    return [];
  }

  const affected = [...new Set(groups.flatMap((group) => group.pages))].sort();

  return [
    {
      id: 'SEO-META-DESC-DUPLICATE',
      confidence: 'high',
      count: affected.length,
      affected: affected.slice(0, MAX_LISTED),
      evidence: {
        pages_compared: pages.length,
        duplicate_groups: groups.length,
        descriptions: groups
          .slice(0, MAX_LISTED)
          .map((group) => `${group.pages.join(', ')}: "${group.value.slice(0, 80)}"`),
      },
      remediation:
        'Redactar una meta description distinta por página. Cuando se repite, el buscador la ignora y compone el fragmento con texto suelto de la página.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Near-duplicate content
// ---------------------------------------------------------------------------

export function nearDuplicateObservations(site: SiteAnalysis): readonly RawObservation[] {
  const comparable = indexablePages(site).filter((page) => page.contentHash !== undefined);
  const pairs: { readonly left: string; readonly right: string; readonly distance: number }[] = [];

  for (let index = 0; index < comparable.length; index += 1) {
    for (let other = index + 1; other < comparable.length; other += 1) {
      const left = comparable[index];
      const right = comparable[other];

      if (left?.contentHash === undefined || right?.contentHash === undefined) {
        continue;
      }

      const distance = hammingDistance(left.contentHash, right.contentHash);

      if (distance <= NEAR_DUPLICATE_DISTANCE) {
        pairs.push({
          left: pathFor(finalUrlOf(left)),
          right: pathFor(finalUrlOf(right)),
          distance,
        });
      }
    }
  }

  if (pairs.length === 0) {
    return [];
  }

  const affected = [...new Set(pairs.flatMap((pair) => [pair.left, pair.right]))].sort();

  return [
    {
      id: 'SEO-CONTENT-NEAR-DUPLICATE',
      // Simhash answers "these read the same", not "these are the same". The
      // catalogue asks for the algorithm; honesty asks for the valve.
      confidence: 'medium',
      count: affected.length,
      affected: affected.slice(0, MAX_LISTED),
      evidence: {
        algorithm: 'simhash-64 sobre shingles de 3 palabras',
        max_distance: NEAR_DUPLICATE_DISTANCE,
        pages_compared: comparable.length,
        pairs: pairs
          .slice(0, MAX_LISTED)
          .map((pair) => `${pair.left} ≈ ${pair.right} (distancia ${pair.distance})`),
      },
      remediation:
        'Unificar las páginas casi idénticas en una sola y redirigir el resto con 301, o diferenciar su contenido. Si la duplicación es intencionada, marcar la versión preferida con rel=canonical.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Canonical chains
// ---------------------------------------------------------------------------

/**
 * A canonicalises to B, and B canonicalises to C. Google follows one hop and
 * then gives up, so the chain silently drops A out of the index.
 *
 * Only chains whose middle page was sampled are reported: without B's own
 * markup there is no chain to see, only a canonical.
 */
export function canonicalChainObservations(site: SiteAnalysis): readonly RawObservation[] {
  const byUrl = new Map<string, SamplePage>();

  for (const page of site.pages) {
    const key = normalize(finalUrlOf(page));

    if (key !== undefined) {
      byUrl.set(key, page);
    }
  }

  function canonicalOf(page: SamplePage): string | undefined {
    const declared = page.analysis.page?.canonicals[0];

    if (declared === undefined) {
      return undefined;
    }

    try {
      return normalize(new URL(declared, finalUrlOf(page)).toString());
    } catch {
      return undefined;
    }
  }

  const chains: string[] = [];
  const affected: string[] = [];

  for (const page of site.pages) {
    const self = normalize(finalUrlOf(page));
    const middle = canonicalOf(page);

    if (self === undefined || middle === undefined || middle === self) {
      continue;
    }

    const target = byUrl.get(middle);

    if (target === undefined) {
      continue;
    }

    const end = canonicalOf(target);

    if (end === undefined || end === middle) {
      continue;
    }

    chains.push(`${pathFor(self)} → ${pathFor(middle)} → ${pathFor(end)}`);
    affected.push(pathFor(self));
  }

  if (chains.length === 0) {
    return [];
  }

  return [
    {
      id: 'SEO-CANONICAL-CHAIN',
      confidence: 'high',
      count: chains.length,
      affected: [...new Set(affected)].sort().slice(0, MAX_LISTED),
      evidence: { chains: chains.slice(0, MAX_LISTED), pages_compared: site.pages.length },
      remediation:
        'Apuntar cada rel=canonical directamente a la URL final. El buscador sigue un solo salto: en una cadena, la primera página queda fuera del índice.',
    },
  ];
}

// ---------------------------------------------------------------------------
// hreflang reciprocity
// ---------------------------------------------------------------------------

/**
 * An hreflang set is only valid if it is mutual: every page in it must list every
 * other page *and itself*. A page that names a translation which does not name it
 * back is not in a set at all — Google discards the whole cluster.
 *
 * A target outside the sample is skipped rather than assumed guilty, so the only
 * thing reported is reciprocity that was actually checked on both sides.
 */
export function hreflangReturnObservations(site: SiteAnalysis): readonly RawObservation[] {
  const byUrl = new Map<string, SamplePage>();

  for (const page of site.pages) {
    const key = normalize(finalUrlOf(page));

    if (key !== undefined) {
      byUrl.set(key, page);
    }
  }

  function alternatesOf(page: SamplePage): readonly string[] {
    return (page.analysis.page?.hreflang ?? []).flatMap((link) => {
      try {
        const resolved = normalize(new URL(link.href, finalUrlOf(page)).toString());
        return resolved === undefined ? [] : [resolved];
      } catch {
        return [];
      }
    });
  }

  const problems: string[] = [];
  const affected: string[] = [];

  for (const page of site.pages) {
    const self = normalize(finalUrlOf(page));
    const alternates = alternatesOf(page);

    if (self === undefined || alternates.length === 0) {
      continue;
    }

    if (!alternates.includes(self)) {
      problems.push(`${pathFor(self)} no se incluye a sí misma en su conjunto hreflang`);
      affected.push(pathFor(self));
    }

    for (const alternate of alternates) {
      const target = byUrl.get(alternate);

      if (target === undefined || alternate === self) {
        continue;
      }

      if (!alternatesOf(target).includes(self)) {
        problems.push(`${pathFor(self)} → ${pathFor(alternate)} sin enlace de vuelta`);
        affected.push(pathFor(self));
      }
    }
  }

  if (problems.length === 0) {
    return [];
  }

  return [
    {
      id: 'SEO-HREFLANG-NO-RETURN',
      confidence: 'high',
      count: problems.length,
      affected: [...new Set(affected)].sort().slice(0, MAX_LISTED),
      evidence: { problems: problems.slice(0, MAX_LISTED), pages_compared: site.pages.length },
      remediation:
        'Hacer recíproco el conjunto hreflang: cada versión de idioma debe listar a todas las demás y también a sí misma. Sin reciprocidad, el buscador descarta el conjunto entero.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Sitemap hygiene
// ---------------------------------------------------------------------------

/**
 * Sitemap URLs that the crawl visited and found redirected, broken or noindex.
 *
 * Measured, not inferred: every URL reported here was requested during this run.
 * The evidence names how many of the sitemap's URLs were actually checked, so a
 * clean result on a 3-of-400 sample cannot be read as a clean sitemap.
 */
export function sitemapDirtyObservations(site: SiteAnalysis): readonly RawObservation[] {
  const checked = site.pages.filter((page) => page.inSitemap);
  const dirty: string[] = [];
  const affected: string[] = [];

  for (const page of checked) {
    const { trace } = page.analysis;
    const reasons: string[] = [];

    if (trace.status >= 400) {
      reasons.push(`responde ${trace.status}`);
    }

    if (trace.hops.length > 0) {
      reasons.push(`redirige a ${pathFor(trace.finalUrl)}`);
    }

    const metaRobots =
      page.analysis.page?.metas.find((meta) => meta.name === 'robots')?.content ?? '';
    const headerRobots = trace.headers['x-robots-tag'] ?? '';

    if (/noindex|(^|[\s,])none([\s,]|$)/i.test(`${metaRobots} ${headerRobots}`)) {
      reasons.push('está marcada noindex');
    }

    if (reasons.length > 0) {
      dirty.push(`${pathFor(page.url)}: ${reasons.join('; ')}`);
      affected.push(pathFor(page.url));
    }
  }

  if (dirty.length === 0) {
    return [];
  }

  return [
    {
      id: 'SEO-SITEMAP-DIRTY-URLS',
      confidence: 'high',
      count: dirty.length,
      affected: [...new Set(affected)].sort().slice(0, MAX_LISTED),
      evidence: {
        sitemap_url: site.seed.sitemap.url,
        sitemap_urls: site.sitemapUrls.length,
        urls_checked: checked.length,
        dirty: dirty.slice(0, MAX_LISTED),
      },
      remediation:
        'Dejar en el sitemap solo URLs finales que respondan 200 y sean indexables. Una URL redirigida, rota o con noindex gasta presupuesto de rastreo y contradice al propio sitemap.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Orphan pages
// ---------------------------------------------------------------------------

export type OrphanResult = {
  readonly observations: readonly RawObservation[];
  /** Set when the sample was too small for the question to be answerable. */
  readonly note: string | undefined;
};

/**
 * Sitemap URLs that no sampled page links to.
 *
 * The gate matters more than the check. From an 8-page sample of a 400-page
 * sitemap, "no incoming links" means "not linked from the 8 pages I read", and
 * emitting 392 orphans would be a confident answer to a question the run never
 * asked. So past `ORPHAN_COVERAGE_RATIO` the check declines and says why; below
 * it, the finding is emitted with a confidence that states how complete the view
 * was — `high` only when every sitemap URL was visited.
 */
export function orphanPageObservations(site: SiteAnalysis): OrphanResult {
  const sitemapUrls = site.sitemapUrls
    .map((url) => normalize(url))
    .filter((url): url is string => url !== undefined);

  if (sitemapUrls.length === 0) {
    return { observations: [], note: undefined };
  }

  const visited = site.pages.length;

  if (sitemapUrls.length > visited * ORPHAN_COVERAGE_RATIO) {
    return {
      observations: [],
      note: `SEO-ORPHAN-PAGES no se evaluó: el sitemap declara ${sitemapUrls.length} URLs y el crawl profundo visitó ${visited}, una cobertura insuficiente para afirmar que a una página no llega ningún enlace.`,
    };
  }

  const linked = new Set<string>();

  for (const page of site.pages) {
    for (const link of page.internalLinks) {
      const normalized = normalize(link);

      if (normalized !== undefined) {
        linked.add(normalized);
      }
    }
  }

  const reachable = new Set<string>([
    ...linked,
    ...site.pages.flatMap((page) => {
      const url = normalize(finalUrlOf(page));
      return url === undefined ? [] : [url];
    }),
  ]);

  // A sitemap URL that no page links to, and that is not the entry point itself.
  const orphans = sitemapUrls.filter((url) => !reachable.has(url)).sort();

  if (orphans.length === 0) {
    return { observations: [], note: undefined };
  }

  const complete = sitemapUrls.every((url) =>
    site.pages.some((page) => normalize(finalUrlOf(page)) === url),
  );

  return {
    observations: [
      {
        id: 'SEO-ORPHAN-PAGES',
        // `low` is not hedging: `scoring.ts` keeps low-confidence findings out of
        // the score and the report still lists them. A partial crawl earns
        // exactly that — visible, not punitive.
        confidence: complete ? 'high' : 'low',
        count: orphans.length,
        affected: orphans.map(pathFor).slice(0, MAX_LISTED),
        evidence: {
          sitemap_urls: sitemapUrls.length,
          pages_crawled: visited,
          crawl_covered_whole_sitemap: complete,
          orphans: orphans.slice(0, MAX_LISTED),
        },
        remediation:
          'Enlazar estas páginas desde la navegación o desde contenido relacionado. Estar en el sitemap no las hace descubribles: sin enlaces entrantes el buscador las trata como secundarias.',
      },
    ],
    note: undefined,
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type DeepObservations = {
  readonly observations: readonly RawObservation[];
  readonly notes: readonly string[];
};

/** Every cross-page check, in catalogue order. */
export function siteObservations(site: SiteAnalysis): DeepObservations {
  const orphans = orphanPageObservations(site);

  return {
    observations: [
      ...canonicalChainObservations(site),
      ...sitemapDirtyObservations(site),
      ...titleDuplicateObservations(site),
      ...metaDescriptionDuplicateObservations(site),
      ...hreflangReturnObservations(site),
      ...orphans.observations,
      ...nearDuplicateObservations(site),
    ],
    notes: orphans.note === undefined ? [] : [orphans.note],
  };
}
