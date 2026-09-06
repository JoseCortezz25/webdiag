import { describe, expect, test } from 'bun:test';
import { analyzeHtml } from './html.ts';

const SHELL = `<!doctype html><html><head>
<script src="/app.js"></script>
</head><body><div id="root"></div><script>window.__DATA__ = {"a":1}</script></body></html>`;

const SERVED = `<!doctype html><html><body>
<header><nav><a href="/">Inicio</a></nav></header>
<main><h1>Servicios de fontaneria</h1>
<p>${'Atendemos urgencias en toda la ciudad las veinticuatro horas del dia. '.repeat(5)}</p>
</main>
<footer><p>Contacto</p></footer>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</body></html>`;

describe('analyzeHtml — contenido sin JavaScript', () => {
  test('a client-rendered shell measures as empty even though it has scripts', () => {
    const analysis = analyzeHtml(SHELL);

    expect(analysis.textLength).toBe(0);
    expect(analysis.scripts).toBe(2);
  });

  test('inline script and style bodies never count as visible text', () => {
    const analysis = analyzeHtml(
      '<body><style>.a{content:"hola mundo muy largo"}</style><script>const x = "texto";</script></body>',
    );

    expect(analysis.textLength).toBe(0);
  });

  test('server-rendered copy is measured, entities included', () => {
    const analysis = analyzeHtml('<body><p>Caf&eacute; &amp; t&eacute;</p></body>');

    expect(analysis.textLength).toBeGreaterThan(0);
  });

  test('markup outside body is ignored', () => {
    const analysis = analyzeHtml(
      '<head><title>Un titulo largo de verdad</title></head><body></body>',
    );

    expect(analysis.textLength).toBe(0);
  });
});

describe('analyzeHtml — landmarks', () => {
  test('finds semantic elements', () => {
    expect(analyzeHtml(SERVED).landmarks).toEqual(['footer', 'header', 'main', 'nav']);
  });

  test('accepts ARIA roles for pages built out of divs', () => {
    const analysis = analyzeHtml(
      '<body><div role="main">x</div><div role=navigation>y</div></body>',
    );

    expect(analysis.landmarks).toEqual(['role=main', 'role=navigation']);
  });

  test('reports none when the document is a bare div tree', () => {
    expect(analyzeHtml(SHELL).landmarks).toEqual([]);
  });
});

describe('analyzeHtml — datos estructurados', () => {
  test('counts and types valid JSON-LD, including @graph', () => {
    const analysis = analyzeHtml(
      '<body><script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script></body>',
    );

    expect(analysis.jsonLdBlocks).toBe(1);
    expect(analysis.jsonLdValid).toBe(1);
    expect(analysis.jsonLdTypes).toEqual(['Organization', 'Thing', 'WebSite']);
  });

  test('an unparseable block is counted but declares nothing', () => {
    const analysis = analyzeHtml(
      '<body><script type="application/ld+json">{ roto,, }</script></body>',
    );

    expect(analysis.jsonLdBlocks).toBe(1);
    expect(analysis.jsonLdValid).toBe(0);
  });

  test('microdata is tracked separately from JSON-LD', () => {
    const analysis = analyzeHtml(
      '<body><div itemscope itemtype="https://schema.org/Product"></div></body>',
    );

    expect(analysis.microdataItems).toBe(1);
    expect(analysis.jsonLdValid).toBe(0);
  });
});

describe('analyzeHtml — nombres accesibles', () => {
  test('text, aria-label, title and a labelled image all name a control', () => {
    const analysis = analyzeHtml(
      `<body>
        <a href="/a">Ver planes</a>
        <button aria-label="Cerrar"><svg></svg></button>
        <a href="/b" title="Descargar"><i></i></a>
        <button><img src="/x.png" alt="Buscar"></button>
      </body>`,
    );

    expect(analysis.interactiveTotal).toBe(4);
    expect(analysis.interactiveUnnamed).toBe(0);
  });

  test('an icon-only control with no label is unnamed', () => {
    const analysis = analyzeHtml(
      '<body><button><svg viewBox="0 0 1 1"></svg></button><a href="/x"><img src="/i.png" alt=""></a></body>',
    );

    expect(analysis.interactiveTotal).toBe(2);
    expect(analysis.interactiveUnnamed).toBe(2);
  });

  test('anchors without href are not controls and are not counted', () => {
    const analysis = analyzeHtml('<body><a name="ancla"></a><a href="/y">Ir</a></body>');

    expect(analysis.interactiveTotal).toBe(1);
    expect(analysis.interactiveUnnamed).toBe(0);
  });
});

describe('analyzeHtml — robustez', () => {
  test('comments never contribute text or landmarks', () => {
    const analysis = analyzeHtml('<body><!-- <main>texto oculto en comentario</main> --></body>');

    expect(analysis.textLength).toBe(0);
    expect(analysis.landmarks).toEqual([]);
  });

  test('a document with no body falls back to the whole input', () => {
    expect(analyzeHtml('<p>Hola</p>').textLength).toBe(4);
  });

  test('empty input does not throw', () => {
    expect(analyzeHtml('').textLength).toBe(0);
  });

  test('forty thousand unclosed anchors are analysed in linear time', () => {
    // Regression: the control counter re-scanned to the end of the document
    // for every `<a>` without a `</a>`, ~80 s on a 2 MB body.
    const html = `<body>${'<a href="/x">'.repeat(40_000)}fin</body>`;
    const started = performance.now();

    const analysis = analyzeHtml(html);

    expect(performance.now() - started).toBeLessThan(1_000);
    // No `</a>` anywhere: none of them is a closed control, same as before.
    expect(analysis.interactiveTotal).toBe(0);
    expect(analysis.textLength).toBe(3);
  });

  test('forty thousand unclosed scripts do not hide the text after them', () => {
    const html = `<body>${'<script>'.repeat(40_000)}</script><p>texto</p></body>`;
    const started = performance.now();

    expect(analyzeHtml(html).textLength).toBe(5);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
