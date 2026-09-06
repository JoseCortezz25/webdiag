/**
 * Reading the server's HTML.
 *
 * These assertions are about the *unrendered* document on purpose. Every one of
 * them describes what Googlebot's first pass can see, which is the only reason
 * `SEO-CSR-CONTENT-INVISIBLE` is answerable from a single fetch.
 */
import { describe, expect, test } from 'bun:test';
import { countBodyWords, findEmptyMountRoot, metaContent, parsePage, resolveUrl } from './page.ts';

const BASE = 'https://example.com/es/';

describe('parsePage', () => {
  test('reads the lang, the title and the meta tags', async () => {
    const page = await parsePage(
      `<!doctype html><html lang="es-CO"><head>
         <title>  Mi página  </title>
         <meta name="description" content=" Una descripción ">
         <meta name="viewport" content="width=device-width">
       </head><body><h1>Hola</h1></body></html>`,
    );

    expect(page.lang).toBe('es-CO');
    expect(page.titles).toEqual(['Mi página']);
    expect(metaContent(page, 'description')).toBe('Una descripción');
    expect(metaContent(page, 'viewport')).toBe('width=device-width');
  });

  test('reads meta names, og properties and http-equiv under one key', async () => {
    const page = await parsePage(
      `<html><head>
         <meta name="ROBOTS" content="noindex">
         <meta property="og:title" content="Título">
         <meta http-equiv="content-language" content="es">
       </head><body></body></html>`,
    );

    expect(metaContent(page, 'robots')).toBe('noindex');
    expect(metaContent(page, 'og:title')).toBe('Título');
    expect(metaContent(page, 'content-language')).toBe('es');
  });

  test('a meta without content contributes nothing', async () => {
    const page = await parsePage('<html><head><meta name="robots"></head><body></body></html>');

    expect(metaContent(page, 'robots')).toBeUndefined();
  });

  test('collects canonicals and hreflang alternates separately', async () => {
    const page = await parsePage(
      `<html><head>
         <link rel="canonical" href="https://example.com/es/">
         <link rel="alternate" hreflang="en" href="/en/">
         <link rel="alternate" hreflang="x-default" href="/">
         <link rel="alternate" type="application/rss+xml" href="/feed.xml">
       </head><body></body></html>`,
    );

    expect(page.canonicals).toEqual(['https://example.com/es/']);
    expect(page.hreflang).toEqual([
      { hreflang: 'en', href: '/en/' },
      { hreflang: 'x-default', href: '/' },
    ]);
  });

  test('a link with an empty href is not a declaration', async () => {
    const page = await parsePage('<html><head><link rel="canonical" href="  "></head></html>');

    expect(page.canonicals).toEqual([]);
  });

  test('counts h1 elements, however many there are', async () => {
    const page = await parsePage('<body><h1>a</h1><h1>b</h1><h2>c</h2></body>');

    expect(page.h1Count).toBe(2);
  });

  test('keeps two sibling JSON-LD blocks apart', async () => {
    const page = await parsePage(
      `<html><head>
         <script type="application/ld+json">{"@type":"Person"}</script>
         <script type="application/ld+json">{"@type":"Product"}</script>
       </head></html>`,
    );

    expect(page.jsonLd).toEqual(['{"@type":"Person"}', '{"@type":"Product"}']);
    for (const block of page.jsonLd) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  test('reassembles a JSON-LD block the parser delivered in chunks', async () => {
    // A long block is split across text chunks; concatenating without the node
    // boundary is what would corrupt it.
    const payload = JSON.stringify({ '@context': 'https://schema.org', name: 'x'.repeat(5_000) });
    const page = await parsePage(
      `<html><head><script type="application/ld+json">${payload}</script></head></html>`,
    );

    expect(page.jsonLd).toHaveLength(1);
    expect(() => JSON.parse(page.jsonLd[0] ?? '')).not.toThrow();
  });

  test('separates real anchors from the ones a crawler cannot follow', async () => {
    const page = await parsePage(
      `<body>
         <nav><a href="/a">A</a><a>Sin href</a></nav>
         <a href="/b">B</a>
         <span role="link">Pseudo</span>
         <a href="">Vacío</a>
       </body>`,
    );

    expect(page.anchorsWithHref).toBe(2);
    expect(page.anchorsWithoutHref).toBe(2);
    expect(page.navAnchorsWithoutHref).toBe(1);
    expect(page.pseudoLinks).toBe(1);
    expect(page.links).toEqual(['/a', '/b']);
  });

  test('an anchor with role=link and an href is a real link', async () => {
    const page = await parsePage('<body><a role="link" href="/a">A</a></body>');

    expect(page.pseudoLinks).toBe(0);
    expect(page.anchorsWithHref).toBe(1);
  });

  test('separates external scripts from inline ones', async () => {
    const page = await parsePage(
      '<body><script src="/a.js"></script><script>var x=1</script></body>',
    );

    expect(page.scriptsWithSrc).toBe(1);
    expect(page.inlineScripts).toBe(1);
  });

  test('collects every kind of subresource, which is what mixed content reads', async () => {
    const page = await parsePage(
      `<body>
         <img src="http://cdn.test/a.png">
         <script src="/a.js"></script>
         <link href="/a.css">
         <iframe src="/frame"></iframe>
         <form action="/post"></form>
         <object data="/o.swf"></object>
       </body>`,
    );

    expect(page.resources).toEqual([
      { kind: 'img', url: 'http://cdn.test/a.png' },
      { kind: 'script', url: '/a.js' },
      { kind: 'link', url: '/a.css' },
      { kind: 'iframe', url: '/frame' },
      { kind: 'form', url: '/post' },
      { kind: 'object', url: '/o.swf' },
    ]);
  });

  test('degrades on malformed markup the way a browser does', async () => {
    const page = await parsePage(
      '<html><head><title>Roto</title></head><body><p>Hola<h1>H<a href="/a">A</body>',
    );

    expect(page.titles).toEqual(['Roto']);
    expect(page.h1Count).toBe(1);
    expect(page.anchorsWithHref).toBe(1);
  });

  test('an unclosed <title> swallows the rest, because <title> is RCDATA', async () => {
    // Not a bug to route around: this is what a browser does with the same bytes,
    // and agreeing with the browser is the whole reason a real parser is used.
    const page = await parsePage('<html><head><title>Roto</head><body><h1>H');

    expect(page.titles).toEqual(['Roto</head><body><h1>H']);
  });

  test('an empty document parses to an empty page', async () => {
    const page = await parsePage('');

    expect(page.titles).toEqual([]);
    expect(page.h1Count).toBe(0);
    expect(page.bodyWordCount).toBe(0);
    expect(page.lang).toBeUndefined();
  });
});

describe('countBodyWords', () => {
  test('counts the prose a crawler would find', () => {
    expect(countBodyWords('<p>uno dos tres</p>')).toBe(3);
  });

  test('does not count script or style content as prose', () => {
    const html = '<body><script>var a = 1; var b = 2; var c = 3;</script><p>uno</p></body>';

    expect(countBodyWords(html)).toBe(1);
  });

  test('does not count noscript, template or comments', () => {
    const html =
      '<body><!-- uno dos --><noscript>tres cuatro</noscript><template>cinco</template><p>seis</p></body>';

    expect(countBodyWords(html)).toBe(1);
  });

  test('does not count tag names or entities', () => {
    expect(countBodyWords('<div class="a b c">&nbsp;&amp;</div>')).toBe(0);
  });

  test('an empty shell has no words, which is the CSR signature', () => {
    expect(countBodyWords('<html><body><div id="root"></div></body></html>')).toBe(0);
  });
});

describe('findEmptyMountRoot', () => {
  test.each([['root'], ['app'], ['__next'], ['__nuxt'], ['___gatsby']])(
    'finds an empty #%s mount node',
    (id) => {
      expect(findEmptyMountRoot(`<body><div id="${id}"></div></body>`)).toBe(id);
    },
  );

  test('finds it with single quotes and with no quotes', () => {
    expect(findEmptyMountRoot("<body><div id='root'></div></body>")).toBe('root');
    expect(findEmptyMountRoot('<body><div id=root></div></body>')).toBe('root');
  });

  test('finds it on a main or section element too', () => {
    expect(findEmptyMountRoot('<body><main id="app"></main></body>')).toBe('app');
  });

  test('a mount node with content in it is not empty', () => {
    expect(findEmptyMountRoot('<body><div id="root"><h1>Hola</h1></div></body>')).toBeUndefined();
  });

  test('a page with no mount node reports none', () => {
    expect(findEmptyMountRoot('<body><p>Hola</p></body>')).toBeUndefined();
  });
});

describe('resolveUrl', () => {
  test('resolves relative, root-relative and protocol-relative forms', () => {
    expect(resolveUrl('otra', BASE)).toBe('https://example.com/es/otra');
    expect(resolveUrl('/en/', BASE)).toBe('https://example.com/en/');
    expect(resolveUrl('//cdn.test/a.js', BASE)).toBe('https://cdn.test/a.js');
  });

  test('leaves an absolute URL alone', () => {
    expect(resolveUrl('https://other.test/x', BASE)).toBe('https://other.test/x');
  });

  test('returns nothing for something that is not a URL at all', () => {
    expect(resolveUrl('http://', BASE)).toBeUndefined();
    expect(resolveUrl('', 'not a base')).toBeUndefined();
  });
});
