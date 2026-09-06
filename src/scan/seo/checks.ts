/**
 * Turning one `SeoAnalysis` into catalogue observations.
 *
 * Every function here is pure. No fetch, no clock, no filesystem — which is the
 * point: these are the twenty-odd judgement calls the axis is actually made of,
 * and a judgement call that can only be exercised against a live website is a
 * judgement call nobody will ever change with confidence.
 *
 * Two rules run through the file:
 *
 *  - **Severity comes from the catalogue, not from here.** An observation only
 *    carries `severity` when the run itself justifies deviating (spec §6), and
 *    nothing below does. `blocking` is likewise a catalogue property; this file
 *    just emits the ID and lets `scoring.ts` zero the axis.
 *  - **Confidence is the valve.** A check that infers rather than measures says
 *    `medium`, and a `low` finding never moves a score. That is what keeps a
 *    heuristic like "this page looks client-rendered" from zeroing an axis on a
 *    guess.
 */
import type { RawObservation } from '../raw.ts';
import type { SeoAnalysis } from './analysis.ts';
import { metaContent, type PageDocument, resolveUrl } from './page.ts';
import { pathOf, verdictFor } from './robots.ts';
import { MAX_SITEMAP_BYTES, MAX_SITEMAP_URLS } from './sitemap.ts';

/** The crawler this axis reasons about when robots.txt distinguishes agents. */
const CRAWLER = 'googlebot';

/** Below this many server-rendered words a page is treated as empty for a crawler. */
const CSR_WORD_FLOOR = 120;
/** Below this, "empty" is not an inference any more. */
const CSR_WORD_CERTAIN = 25;

/** Kept short so `findings.json` stays readable when a page has hundreds. */
const MAX_LISTED = 20;

function pathFor(url: string): string {
  try {
    return pathOf(url);
  } catch {
    return url;
  }
}

/** `<https://x/>; rel="canonical"` → `https://x/`. */
function canonicalFromLinkHeader(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*(.+)/);
    if (match !== undefined && match !== null && /rel\s*=\s*"?canonical"?/i.test(match[2] ?? '')) {
      return match[1]?.trim();
    }
  }

  return undefined;
}

function hasToken(value: string | undefined, token: string): boolean {
  return (value ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .includes(token);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function statusObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const { trace } = analysis;
  const out: RawObservation[] = [];

  if (trace.loop) {
    out.push({
      id: 'SEO-REDIRECT-LOOP',
      confidence: 'high',
      count: 1,
      affected: [pathFor(trace.requestedUrl)],
      evidence: {
        chain: trace.hops.map((hop) => `${hop.status} ${hop.url} -> ${hop.location ?? '?'}`),
        repeated_url: trace.loopAt,
        hops: trace.hops.length,
      },
      remediation:
        'Romper el bucle: cada URL debe redirigir a un destino final que responda 200, nunca a una URL ya visitada en la cadena.',
      title: 'La URL entra en un bucle de redirección',
    });
  } else if (trace.hops.length > 1) {
    out.push({
      id: 'SEO-REDIRECT-CHAIN',
      confidence: 'high',
      count: trace.hops.length,
      affected: trace.hops.map((hop) => pathFor(hop.url)),
      evidence: {
        hops: trace.hops.length,
        chain: trace.hops.map((hop) => `${hop.status} ${hop.url} -> ${hop.location ?? '?'}`),
        final_url: trace.finalUrl,
      },
      remediation:
        'Redirigir en un solo salto al destino final y actualizar los enlaces internos para que apunten ya a esa URL.',
    });
  }

  if (!trace.loop && trace.status >= 400) {
    out.push({
      id: 'SEO-STATUS-ERROR',
      confidence: 'high',
      count: 1,
      affected: [pathFor(trace.finalUrl)],
      evidence: {
        status: trace.status,
        url: trace.finalUrl,
        requested_url: trace.requestedUrl,
        redirect_hops: trace.hops.length,
      },
      remediation:
        trace.status >= 500
          ? 'Corregir el error de servidor: mientras la URL responda 5xx no puede indexarse.'
          : 'Devolver 200 en la URL, o redirigir 301 al recurso que la reemplaza si el contenido se movió.',
      title: `La URL responde ${trace.status}`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Indexability
// ---------------------------------------------------------------------------

export function noindexObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const { page, trace } = analysis;
  const header = trace.headers['x-robots-tag'];
  const metaRobots = page === undefined ? undefined : metaContent(page, 'robots');
  const metaGooglebot = page === undefined ? undefined : metaContent(page, 'googlebot');

  const sources: readonly (readonly [string, string | undefined])[] = [
    ['x-robots-tag', header],
    ['meta[name=robots]', metaRobots],
    ['meta[name=googlebot]', metaGooglebot],
  ];

  const hits = sources.filter(([, value]) => hasToken(value, 'noindex') || hasToken(value, 'none'));

  if (hits.length === 0) {
    return [];
  }

  return [
    {
      id: 'SEO-NOINDEX-UNINTENDED',
      confidence: 'high',
      count: 1,
      affected: [pathFor(trace.finalUrl)],
      evidence: Object.fromEntries([
        ['url', trace.finalUrl],
        ...hits.map(([source, value]) => [source, value ?? '']),
      ]),
      remediation:
        'Eliminar el noindex de producción (meta robots o cabecera X-Robots-Tag) y solicitar la reindexación de la URL.',
      title: 'La URL está marcada como no indexable',
    },
  ];
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export function robotsObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const robots = analysis.robots;

  if (robots === undefined || !robots.present) {
    return [];
  }

  const out: RawObservation[] = [];

  if (robots.errors.length > 0) {
    out.push({
      id: 'SEO-ROBOTS-INVALID',
      confidence: 'high',
      count: robots.errors.length,
      affected: [pathFor(robots.url)],
      evidence: {
        url: robots.url,
        errors: robots.errors
          .slice(0, MAX_LISTED)
          .map((error) => `line ${error.line}: ${error.reason} (${error.text})`),
        total_errors: robots.errors.length,
      },
      remediation:
        'Corregir las líneas inválidas de robots.txt: cada directiva debe ser "Campo: valor" con un campo reconocido, y Allow/Disallow deben ir después de un User-agent.',
    });
  }

  const rootVerdict = verdictFor(robots, CRAWLER, '/');

  if (!rootVerdict.allowed) {
    out.push({
      id: 'SEO-ROBOTS-BLOCKS-ALL',
      confidence: 'high',
      count: 1,
      affected: [pathFor(robots.url)],
      evidence: {
        url: robots.url,
        rule: `${rootVerdict.rule?.type ?? 'disallow'}: ${rootVerdict.rule?.path ?? '/'}`,
        agent: CRAWLER,
      },
      remediation:
        'Quitar el "Disallow: /" del grupo que aplica a los buscadores. Un robots.txt de staging publicado en producción bloquea el sitio completo.',
      title: 'robots.txt bloquea el sitio entero',
    });
  }

  const blockedAssets = blockedRenderAssets(analysis);

  if (blockedAssets.length > 0) {
    out.push({
      id: 'SEO-ROBOTS-BLOCKS-ASSETS',
      confidence: 'high',
      count: blockedAssets.length,
      affected: blockedAssets.slice(0, MAX_LISTED).map(pathFor),
      evidence: {
        url: robots.url,
        blocked: blockedAssets.slice(0, MAX_LISTED),
        total_blocked: blockedAssets.length,
        agent: CRAWLER,
      },
      remediation:
        'Permitir el rastreo del CSS y el JS de la página: si Google no puede descargarlos, renderiza una versión rota y evalúa esa.',
    });
  }

  return out;
}

/** Same-origin CSS and JS the page loads that robots.txt refuses to the crawler. */
function blockedRenderAssets(analysis: SeoAnalysis): readonly string[] {
  const { page, robots, trace } = analysis;

  if (page === undefined || robots === undefined || !robots.present) {
    return [];
  }

  const origin = new URL(trace.finalUrl).origin;
  const blocked: string[] = [];

  for (const resource of page.resources) {
    if (resource.kind !== 'script' && resource.kind !== 'link') {
      continue;
    }

    const resolved = resolveUrl(resource.url, trace.finalUrl);

    if (resolved === undefined || !resolved.startsWith(origin)) {
      continue;
    }

    // `link` covers rel=preconnect and friends too; only styles are render-blocking.
    if (resource.kind === 'link' && !/\.css(\?|$)/i.test(resolved)) {
      continue;
    }

    if (!verdictFor(robots, CRAWLER, pathOf(resolved)).allowed) {
      blocked.push(resolved);
    }
  }

  return [...new Set(blocked)].sort();
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export function sitemapObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const sitemap = analysis.sitemap;
  const out: RawObservation[] = [];

  if (!sitemap.found) {
    out.push({
      id: 'SEO-SITEMAP-MISSING',
      confidence: 'high',
      count: 1,
      affected: ['/sitemap.xml'],
      evidence: { reason: 'not-found', tried: sitemap.candidates },
      remediation:
        'Publicar un sitemap.xml con las URLs indexables y declararlo en robots.txt con una línea "Sitemap: <url>".',
    });
  } else if (!sitemap.declaredInRobots) {
    // The catalogue defines this ID as "sin sitemap.xml *o* no declarado en
    // robots.txt", so a sitemap nobody points at is the same finding with a
    // different reason — and a different fix.
    out.push({
      id: 'SEO-SITEMAP-MISSING',
      confidence: 'high',
      count: 1,
      affected: [pathFor(sitemap.url ?? '/sitemap.xml')],
      evidence: { reason: 'not-declared-in-robots', sitemap_url: sitemap.url },
      remediation:
        'Añadir "Sitemap: <url del sitemap>" a robots.txt: el sitemap existe pero ningún crawler sabe dónde buscarlo.',
    });
  }

  const validation = sitemap.validation;

  if (validation !== undefined && !validation.valid) {
    out.push({
      id: 'SEO-SITEMAP-INVALID',
      confidence: 'high',
      count: 1,
      affected: [pathFor(sitemap.url ?? '/sitemap.xml')],
      evidence: {
        sitemap_url: sitemap.url,
        schema: `sitemaps.org 0.9 (${validation.schema})`,
        validator: 'xmllint --schema',
        errors: validation.errors,
      },
      remediation:
        'Corregir el sitemap para que valide contra el esquema de sitemaps.org 0.9: los errores listados indican el elemento exacto.',
    });
  }

  if (
    sitemap.root === 'urlset' &&
    (sitemap.entryCount > MAX_SITEMAP_URLS || sitemap.byteLength > MAX_SITEMAP_BYTES)
  ) {
    out.push({
      id: 'SEO-SITEMAP-LIMITS-EXCEEDED',
      confidence: 'high',
      count: 1,
      affected: [pathFor(sitemap.url ?? '/sitemap.xml')],
      evidence: {
        sitemap_url: sitemap.url,
        urls: sitemap.entryCount,
        max_urls: MAX_SITEMAP_URLS,
        bytes: sitemap.byteLength,
        max_bytes: MAX_SITEMAP_BYTES,
      },
      remediation:
        'Partir el sitemap en varios archivos de menos de 50.000 URLs y 50 MB cada uno, y publicar un índice de sitemaps que los agrupe.',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Head tags
// ---------------------------------------------------------------------------

export function headObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const page = analysis.page;

  if (page === undefined) {
    return [];
  }

  const where = [pathFor(analysis.trace.finalUrl)];
  const out: RawObservation[] = [];

  if (page.titles.length === 0) {
    out.push({
      id: 'SEO-TITLE-MISSING',
      confidence: 'high',
      count: 1,
      affected: where,
      evidence: { title_count: 0 },
      remediation:
        'Añadir un <title> único y descriptivo: es el texto que el buscador usa como titular del resultado.',
    });
  }

  const description = metaContent(page, 'description');

  if (description === undefined || description === '') {
    out.push({
      id: 'SEO-META-DESC-MISSING',
      confidence: 'high',
      count: 1,
      affected: where,
      evidence: { present: false },
      remediation:
        'Redactar una meta description única de 120–160 caracteres que resuma el contenido de la página.',
    });
  }

  if (page.h1Count !== 1) {
    out.push({
      id: 'SEO-H1-MISSING',
      confidence: 'high',
      count: 1,
      affected: where,
      evidence: { h1_count: page.h1Count, expected: 1 },
      remediation:
        page.h1Count === 0
          ? 'Añadir un único <h1> que describa el contenido principal de la página.'
          : 'Dejar un único <h1> por página y degradar los demás a <h2>.',
    });
  }

  if (metaContent(page, 'viewport') === undefined) {
    out.push({
      id: 'SEO-VIEWPORT-MISSING',
      confidence: 'high',
      count: 1,
      affected: where,
      evidence: { present: false },
      remediation:
        'Añadir <meta name="viewport" content="width=device-width, initial-scale=1">: sin él la página no se considera apta para móvil.',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Canonical
// ---------------------------------------------------------------------------

export function canonicalObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const { page, trace, canonical } = analysis;

  if (page === undefined) {
    return [];
  }

  const where = [pathFor(trace.finalUrl)];
  const headerCanonical = canonicalFromLinkHeader(trace.headers.link);
  const declared = [
    ...new Set([...page.canonicals, ...(headerCanonical ? [headerCanonical] : [])]),
  ];

  if (declared.length === 0) {
    return [
      {
        id: 'SEO-CANONICAL-MISSING',
        confidence: 'high',
        count: 1,
        affected: where,
        evidence: { present: false, url: trace.finalUrl },
        remediation:
          'Añadir <link rel="canonical" href="<url absoluta de esta página>"> para que el buscador sepa cuál es la versión preferida.',
      },
    ];
  }

  const resolved = [
    ...new Set(declared.map((value) => resolveUrl(value, trace.finalUrl) ?? value)),
  ];

  if (resolved.length > 1) {
    return [
      {
        id: 'SEO-CANONICAL-CONFLICT',
        confidence: 'high',
        count: resolved.length,
        affected: where,
        evidence: { reason: 'multiple-canonicals', declared: resolved },
        remediation:
          'Dejar un solo rel=canonical por página. Con varios, el buscador los ignora todos y elige la canónica por su cuenta.',
        title: 'La página declara varias URLs canónicas distintas',
      },
    ];
  }

  if (canonical === undefined || canonical.selfReferencing || canonical.error !== undefined) {
    return [];
  }

  const broken = canonical.status !== undefined && canonical.status >= 400;

  if (!broken && !canonical.redirected && !canonical.noindex) {
    return [];
  }

  const reason = broken
    ? 'target-error'
    : canonical.noindex
      ? 'target-noindex'
      : 'target-redirects';

  return [
    {
      id: 'SEO-CANONICAL-CONFLICT',
      confidence: 'high',
      count: 1,
      affected: where,
      evidence: {
        reason,
        canonical: canonical.resolved,
        status: canonical.status,
        final_url: canonical.finalUrl,
        noindex: canonical.noindex,
      },
      remediation:
        'Apuntar el rel=canonical a una URL que responda 200, sea indexable y no redirija. Una canónica rota manda a indexar una página que no existe.',
      title: 'El rel=canonical apunta a una URL no indexable',
    },
  ];
}

// ---------------------------------------------------------------------------
// hreflang
// ---------------------------------------------------------------------------

/**
 * BCP 47 via the runtime's own tag parser, so the check is not a home-made regex.
 *
 * What this answers is *well-formedness*, not registry membership: `Intl` will
 * accept `zz` and `english` because both are structurally legal primary subtags,
 * and rejecting them would need the IANA subtag registry shipped alongside. That
 * is the right trade here — the catalogue's `SEO-HREFLANG-INVALID` is about
 * malformed codes, and the mistake sites actually make is `es_CO`, `es-co-x` or
 * a locale copied out of a Java properties file, all of which this catches. A
 * real-but-unregistered subtag stays a known blind spot rather than a guess.
 */
export function isValidLanguageTag(value: string): boolean {
  if (value.toLowerCase() === 'x-default') {
    return true;
  }

  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

export function hreflangObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const { page, trace } = analysis;

  if (page === undefined || page.hreflang.length === 0) {
    return [];
  }

  const where = [pathFor(trace.finalUrl)];
  const out: RawObservation[] = [];

  const invalid = page.hreflang.filter((link) => !isValidLanguageTag(link.hreflang));
  const hasDefault = page.hreflang.some((link) => link.hreflang.toLowerCase() === 'x-default');

  if (invalid.length > 0 || !hasDefault) {
    out.push({
      id: 'SEO-HREFLANG-INVALID',
      confidence: 'high',
      count: Math.max(invalid.length, 1),
      affected: where,
      evidence: {
        invalid_tags: invalid.slice(0, MAX_LISTED).map((link) => link.hreflang),
        x_default_present: hasDefault,
        declared: page.hreflang.length,
      },
      remediation: hasDefault
        ? 'Corregir los códigos hreflang a BCP 47 válidos (por ejemplo es-CO, no es_CO ni spa).'
        : 'Añadir un <link rel="alternate" hreflang="x-default"> que apunte a la versión por defecto del conjunto de idiomas.',
    });
  }

  const conflict = hreflangCanonicalConflict(page, trace.finalUrl);

  if (conflict !== undefined) {
    out.push({
      id: 'SEO-HREFLANG-CANONICAL-CONFLICT',
      confidence: 'medium',
      count: 1,
      affected: where,
      evidence: conflict,
      remediation:
        'Hacer que el rel=canonical de cada versión apunte a sí misma y que esa misma URL aparezca en su hreflang. Si la canónica apunta a otro idioma, el conjunto hreflang se descarta.',
    });
  }

  return out;
}

/**
 * A page in an hreflang set must canonicalise to itself. When its canonical
 * points somewhere the set does not list, the two tags give the crawler
 * contradictory instructions and the set is discarded.
 */
function hreflangCanonicalConflict(
  page: PageDocument,
  base: string,
): Readonly<Record<string, unknown>> | undefined {
  if (page.canonicals.length === 0) {
    return undefined;
  }

  const canonical = resolveUrl(page.canonicals[0] ?? '', base);

  if (canonical === undefined) {
    return undefined;
  }

  const alternates = page.hreflang
    .map((link) => resolveUrl(link.href, base))
    .filter((href): href is string => href !== undefined);

  if (alternates.includes(canonical)) {
    return undefined;
  }

  return { canonical, hreflang_targets: alternates.slice(0, MAX_LISTED), page_url: base };
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/** Required properties for rich results, per type. Unlisted types are not judged. */
const REQUIRED_JSONLD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  article: ['headline', 'datePublished', 'author'],
  newsarticle: ['headline', 'datePublished', 'author'],
  blogposting: ['headline', 'datePublished', 'author'],
  product: ['name', 'offers'],
  organization: ['name', 'url'],
  localbusiness: ['name', 'address'],
  website: ['name', 'url'],
  person: ['name'],
  event: ['name', 'startDate', 'location'],
  faqpage: ['mainEntity'],
  breadcrumblist: ['itemListElement'],
  recipe: ['name', 'recipeIngredient', 'recipeInstructions'],
  videoobject: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
};

type JsonLdNode = Record<string, unknown>;

/** Flattens `@graph` and top-level arrays into the nodes a crawler would read. */
function jsonLdNodes(value: unknown): readonly JsonLdNode[] {
  if (Array.isArray(value)) {
    return value.flatMap(jsonLdNodes);
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const node = value as JsonLdNode;
  const graph = node['@graph'];

  return graph === undefined ? [node] : [node, ...jsonLdNodes(graph)];
}

function typeNamesOf(node: JsonLdNode): readonly string[] {
  const raw = node['@type'];
  const values = Array.isArray(raw) ? raw : [raw];

  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.split('/').pop()?.toLowerCase() ?? '');
}

export function jsonLdObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const { page, trace } = analysis;

  if (page === undefined || page.jsonLd.length === 0) {
    return [];
  }

  const where = [pathFor(trace.finalUrl)];
  const invalid: string[] = [];
  const incomplete: string[] = [];

  for (const [index, block] of page.jsonLd.entries()) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(block);
    } catch (cause) {
      invalid.push(`block ${index + 1}: ${cause instanceof Error ? cause.message : 'unparseable'}`);
      continue;
    }

    const nodes = jsonLdNodes(parsed);

    if (nodes.length === 0) {
      invalid.push(`block ${index + 1}: not a JSON-LD object`);
      continue;
    }

    const root = nodes[0];

    if (root?.['@context'] === undefined) {
      invalid.push(`block ${index + 1}: missing @context`);
    }

    for (const node of nodes) {
      const types = typeNamesOf(node);

      if (types.length === 0) {
        invalid.push(`block ${index + 1}: a node has no @type`);
        continue;
      }

      for (const type of types) {
        const required = REQUIRED_JSONLD_FIELDS[type];

        if (required === undefined) {
          continue;
        }

        const missing = required.filter((field) => node[field] === undefined);

        if (missing.length > 0) {
          incomplete.push(`${type}: falta ${missing.join(', ')}`);
        }
      }
    }
  }

  const out: RawObservation[] = [];

  if (invalid.length > 0) {
    out.push({
      id: 'SEO-JSONLD-INVALID',
      confidence: 'high',
      count: invalid.length,
      affected: where,
      evidence: { blocks: page.jsonLd.length, problems: invalid.slice(0, MAX_LISTED) },
      remediation:
        'Corregir los bloques JSON-LD para que parseen y declaren @context y @type. Un bloque inválido se descarta entero, no parcialmente.',
    });
  }

  if (incomplete.length > 0) {
    out.push({
      id: 'SEO-JSONLD-INCOMPLETE',
      confidence: 'medium',
      count: incomplete.length,
      affected: where,
      evidence: { missing: [...new Set(incomplete)].slice(0, MAX_LISTED) },
      remediation:
        'Completar las propiedades requeridas del tipo declarado. Sin ellas el marcado es válido pero no habilita rich results.',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Rendering and links
// ---------------------------------------------------------------------------

export function renderingObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const { page, trace } = analysis;

  if (page === undefined) {
    return [];
  }

  const where = [pathFor(trace.finalUrl)];
  const out: RawObservation[] = [];

  const shipsJs = page.scriptsWithSrc > 0 || page.inlineScripts > 0;
  const looksEmpty = page.bodyWordCount < CSR_WORD_FLOOR;

  if (shipsJs && (looksEmpty || page.emptyMountRoot !== undefined)) {
    out.push({
      id: 'SEO-CSR-CONTENT-INVISIBLE',
      // The rendered DOM is not measured here, so "the crawler sees nothing" is
      // an inference from the server response. It becomes certain only when the
      // page is essentially empty bytes.
      confidence: page.bodyWordCount < CSR_WORD_CERTAIN ? 'high' : 'medium',
      count: 1,
      affected: where,
      evidence: {
        server_rendered_words: page.bodyWordCount,
        threshold_words: CSR_WORD_FLOOR,
        empty_mount_root: page.emptyMountRoot ?? null,
        scripts_with_src: page.scriptsWithSrc,
        note: 'medido sobre el HTML del servidor, que es lo que ve el primer pase del crawler',
      },
      remediation:
        'Servir el contenido principal ya renderizado (SSR, SSG o prerender). El segundo pase de renderizado de Google no está garantizado ni es inmediato.',
    });
  }

  const nonCrawlable = page.navAnchorsWithoutHref + page.pseudoLinks;
  const noInternalLinks = page.anchorsWithHref === 0;

  if (noInternalLinks || nonCrawlable > 0) {
    out.push({
      id: 'SEO-LINKS-NOT-CRAWLABLE',
      confidence: noInternalLinks ? 'high' : 'medium',
      count: Math.max(nonCrawlable, 1),
      affected: where,
      evidence: {
        anchors_with_href: page.anchorsWithHref,
        anchors_without_href: page.anchorsWithoutHref,
        nav_anchors_without_href: page.navAnchorsWithoutHref,
        pseudo_links: page.pseudoLinks,
      },
      remediation:
        'Usar <a href="..."> reales para la navegación. Un elemento que sólo navega por JavaScript no transmite enlace ni se rastrea.',
    });
  }

  const mixed = mixedContentResources(analysis);

  if (mixed.length > 0) {
    out.push({
      id: 'SEO-MIXED-CONTENT',
      confidence: 'high',
      count: mixed.length,
      affected: where,
      evidence: {
        resources: mixed.slice(0, MAX_LISTED),
        total: mixed.length,
        page_url: trace.finalUrl,
      },
      remediation:
        'Servir todos los recursos por https. El navegador bloquea el contenido activo mixto, así que la página se renderiza incompleta.',
    });
  }

  return out;
}

/** `http://` subresources on an `https://` page. */
function mixedContentResources(analysis: SeoAnalysis): readonly string[] {
  const { page, trace } = analysis;

  if (page === undefined || !trace.finalUrl.startsWith('https://')) {
    return [];
  }

  const insecure = page.resources
    .map((resource) => resource.url)
    .filter((url) => /^http:\/\//i.test(url));

  return [...new Set(insecure)].sort();
}

// ---------------------------------------------------------------------------
// lychee
// ---------------------------------------------------------------------------

export function linkObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const links = analysis.links;

  if (links.outcome !== 'ok' || links.broken.length === 0) {
    return [];
  }

  return [
    {
      id: 'SEO-LINKS-BROKEN',
      confidence: 'high',
      count: links.broken.length,
      affected: [pathFor(analysis.trace.finalUrl)],
      evidence: {
        checked: links.total,
        successful: links.successful,
        excluded: links.excluded,
        broken: links.broken.map((link) => `${link.code ?? '-'} ${link.url} (${link.status})`),
      },
      remediation:
        'Corregir o retirar los enlaces rotos listados. Los 401/403/429 no se cuentan aquí: son servidores que rechazan al rastreador, no enlaces muertos.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Every check, in one list.
 *
 * When the URL itself is unreachable, only the transport findings run: a page
 * that returned 503 has no title, and reporting `SEO-TITLE-MISSING` against it
 * would be twenty findings describing one problem.
 */
export function toObservations(analysis: SeoAnalysis): readonly RawObservation[] {
  const transport = statusObservations(analysis);

  if (analysis.page === undefined) {
    return [...transport, ...robotsObservations(analysis), ...sitemapObservations(analysis)];
  }

  return [
    ...transport,
    ...noindexObservations(analysis),
    ...robotsObservations(analysis),
    ...sitemapObservations(analysis),
    ...headObservations(analysis),
    ...canonicalObservations(analysis),
    ...hreflangObservations(analysis),
    ...jsonLdObservations(analysis),
    ...renderingObservations(analysis),
    ...linkObservations(analysis),
  ];
}
