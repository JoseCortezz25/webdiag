/**
 * Reading the HTML the server actually sent.
 *
 * This is deliberately the *unrendered* document. Googlebot's first pass is the
 * server response, and every finding in this module is about what that pass can
 * see — which is why `SEO-CSR-CONTENT-INVISIBLE` is answerable here at all. A
 * probe that measured the rendered DOM would report that everything is fine on
 * precisely the sites where it is not.
 *
 * Parsing goes through Bun's `HTMLRewriter`, which is a real streaming HTML5
 * parser rather than a regular expression, so malformed markup degrades the way
 * a browser degrades instead of the way a regex degrades. The two places a
 * regex survives are text volume and empty mount nodes: both are about the
 * *shape* of the raw bytes, and both say so where they are used.
 */

import { stripElements } from '../text/html-scan.ts';

export type MetaTag = { readonly name: string; readonly content: string };
export type HreflangLink = { readonly hreflang: string; readonly href: string };
export type ResourceRef = { readonly kind: string; readonly url: string };

export type PageDocument = {
  readonly lang: string | undefined;
  readonly titles: readonly string[];
  readonly metas: readonly MetaTag[];
  readonly canonicals: readonly string[];
  readonly hreflang: readonly HreflangLink[];
  readonly h1Count: number;
  /** Raw text of every `application/ld+json` block, in document order. */
  readonly jsonLd: readonly string[];
  readonly anchorsWithHref: number;
  readonly anchorsWithoutHref: number;
  readonly navAnchorsWithoutHref: number;
  readonly pseudoLinks: number;
  readonly links: readonly string[];
  readonly resources: readonly ResourceRef[];
  readonly scriptsWithSrc: number;
  readonly inlineScripts: number;
  readonly bodyWordCount: number;
  readonly emptyMountRoot: string | undefined;
};

/** `[selector, kind, attribute]`. One table so adding a resource kind is one line. */
const RESOURCE_SELECTORS: readonly (readonly [string, string, string])[] = [
  ['img[src]', 'img', 'src'],
  ['script[src]', 'script', 'src'],
  ['link[href]', 'link', 'href'],
  ['iframe[src]', 'iframe', 'src'],
  ['source[src]', 'source', 'src'],
  ['video[src]', 'video', 'src'],
  ['audio[src]', 'audio', 'src'],
  ['embed[src]', 'embed', 'src'],
  ['object[data]', 'object', 'data'],
  ['form[action]', 'form', 'action'],
];

/** Framework mount points. An empty one is the signature of a client-rendered app. */
const MOUNT_IDS: readonly string[] = ['root', 'app', '__next', '__nuxt', '___gatsby', 'svelte'];

/**
 * Word count of the server-rendered text.
 *
 * A regex rather than the parser on purpose: what matters is how much prose a
 * crawler would find in the bytes, and `<script>` / `<style>` content is not
 * prose no matter how the tree is shaped.
 */
export function bodyText(html: string): string {
  // `stripElements` rather than a lazy cross-tag regex: on a document full of
  // unclosed `<script>` tags the regex is quadratic, the scan is linear.
  return stripElements(html.replace(/<!--[\s\S]*?-->/g, ' '), [
    'script',
    'style',
    'template',
    'noscript',
  ])
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

export function countBodyWords(html: string): number {
  return bodyText(html)
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/** Returns the id of an empty framework mount node, when the document has one. */
export function findEmptyMountRoot(html: string): string | undefined {
  for (const id of MOUNT_IDS) {
    const pattern = new RegExp(
      `<(div|main|section)\\b[^>]*\\bid=["']?${id}["']?[^>]*>\\s*</\\1\\s*>`,
      'i',
    );
    if (pattern.test(html)) {
      return id;
    }
  }
  return undefined;
}

/**
 * Accumulates text chunks into whole nodes.
 *
 * `HTMLRewriter` splits one text node into several chunks and signals the end of
 * the node with a final empty chunk. Concatenating without that boundary would
 * glue two sibling JSON-LD blocks into one unparseable string.
 */
function textCollector(sink: string[]): { text(chunk: { text: string }): void } {
  let buffer = '';

  return {
    text(chunk) {
      if (chunk.text === '') {
        sink.push(buffer);
        buffer = '';
        return;
      }
      buffer += chunk.text;
    },
  };
}

export async function parsePage(html: string): Promise<PageDocument> {
  const titles: string[] = [];
  const metas: MetaTag[] = [];
  const canonicals: string[] = [];
  const hreflang: HreflangLink[] = [];
  const jsonLd: string[] = [];
  const links: string[] = [];
  const resources: ResourceRef[] = [];

  let lang: string | undefined;
  let h1Count = 0;
  let anchorsWithHref = 0;
  let anchorsWithoutHref = 0;
  let navAnchorsWithoutHref = 0;
  let pseudoLinks = 0;
  let scriptsWithSrc = 0;
  let inlineScripts = 0;

  let rewriter = new HTMLRewriter()
    .on('html', {
      element(element) {
        lang ??= element.getAttribute('lang') ?? undefined;
      },
    })
    .on('title', textCollector(titles))
    .on('script[type="application/ld+json"]', textCollector(jsonLd))
    .on('meta', {
      element(element) {
        // `name` for robots/description/viewport, `property` for Open Graph, and
        // `http-equiv` for the meta form of an HTTP header. All three are read
        // under one key so the checks do not have to know which spelling a site
        // happened to use.
        const name =
          element.getAttribute('name') ??
          element.getAttribute('property') ??
          element.getAttribute('http-equiv');
        const content = element.getAttribute('content');

        if (name !== null && content !== null) {
          metas.push({ name: name.trim().toLowerCase(), content: content.trim() });
        }
      },
    })
    .on('link', {
      element(element) {
        const rel = (element.getAttribute('rel') ?? '').trim().toLowerCase();
        const href = element.getAttribute('href');

        if (href === null || href.trim() === '') {
          return;
        }

        if (rel === 'canonical') {
          canonicals.push(href.trim());
        }

        const alternateLang = element.getAttribute('hreflang');
        if (rel === 'alternate' && alternateLang !== null) {
          hreflang.push({ hreflang: alternateLang.trim(), href: href.trim() });
        }
      },
    })
    .on('h1', {
      element() {
        h1Count += 1;
      },
    })
    .on('a', {
      element(element) {
        const href = element.getAttribute('href');
        if (href === null || href.trim() === '') {
          anchorsWithoutHref += 1;
          return;
        }
        anchorsWithHref += 1;
        links.push(href.trim());
      },
    })
    .on('nav a', {
      element(element) {
        const href = element.getAttribute('href');
        if (href === null || href.trim() === '') {
          navAnchorsWithoutHref += 1;
        }
      },
    })
    .on('[role="link"]', {
      element(element) {
        if (element.getAttribute('href') === null) {
          pseudoLinks += 1;
        }
      },
    })
    .on('script', {
      element(element) {
        if (element.getAttribute('src') === null) {
          inlineScripts += 1;
        } else {
          scriptsWithSrc += 1;
        }
      },
    });

  for (const [selector, kind, attribute] of RESOURCE_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        const value = element.getAttribute(attribute);
        if (value !== null && value.trim() !== '') {
          resources.push({ kind, url: value.trim() });
        }
      },
    });
  }

  await rewriter.transform(new Response(html)).text();

  return {
    lang,
    titles: titles.map((title) => title.trim()).filter((title) => title !== ''),
    metas,
    canonicals,
    hreflang,
    h1Count,
    jsonLd: jsonLd.map((block) => block.trim()).filter((block) => block !== ''),
    anchorsWithHref,
    anchorsWithoutHref,
    navAnchorsWithoutHref,
    pseudoLinks,
    links,
    resources,
    scriptsWithSrc,
    inlineScripts,
    bodyWordCount: countBodyWords(html),
    emptyMountRoot: findEmptyMountRoot(html),
  };
}

/** First value of a meta name, lower-cased. `undefined` when the page has none. */
export function metaContent(page: PageDocument, name: string): string | undefined {
  return page.metas.find((meta) => meta.name === name)?.content;
}

/** Resolves a possibly relative URL, returning `undefined` when it is unusable. */
export function resolveUrl(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}
