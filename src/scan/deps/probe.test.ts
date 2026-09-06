import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { ProbeContext } from '../probe.ts';
import { runProbe } from '../probe.ts';
import { RAW_SCHEMA_VERSION } from '../raw.ts';
import { toObservations } from './adapter.ts';
import { detectLibraryHits } from './analyze.ts';
import { collectServedScripts } from './collector.ts';
import { EMPTY_ENRICHMENT } from './enrichment.ts';
import { cleanAnalysis, depsAnalysis } from './fixture.ts';
import { depsProbe } from './probe.ts';
import { RETIRE_TOOL, scanWithRetire } from './retire.ts';
import { findExposedSourcemaps } from './sourcemaps.ts';
import { withWorkspace } from './workspace.ts';

const CONTEXT: ProbeContext = { url: 'https://example.test/', mode: 'quick', pages: 1 };

describe('depsProbe', () => {
  test('writes a raw document the normalizer can read', async () => {
    const raw = await depsProbe(() => Promise.resolve(cleanAnalysis())).run(CONTEXT);

    expect(raw.schema).toBe(RAW_SCHEMA_VERSION);
    expect(raw.axis).toBe('DEPS');
    expect(raw.target).toEqual({ url: 'https://example.test/', mode: 'quick' });
    expect(raw.observations.map((observation) => observation.id)).toEqual([
      'DEPS-VERSION-UNDETERMINED',
    ]);
  });

  test('records the Chrome build alongside the retire.js version (spec §6)', async () => {
    const outcome = await runProbe(
      depsProbe(() => Promise.resolve(depsAnalysis())),
      CONTEXT,
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.tool).toEqual({
      name: 'retire.js',
      version: `${RETIRE_TOOL.version}+chrome-152.0.7977.75`,
    });
  });

  test('degrades the axis instead of ending the run when the browser fails', async () => {
    const outcome = await runProbe(
      depsProbe(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'))),
      CONTEXT,
    );

    expect(outcome.status).toBe('failed');
    // Nothing ran, so the declared identity is the only honest answer.
    expect(outcome.tool).toEqual(RETIRE_TOOL);
    expect(outcome.status === 'failed' && outcome.error).toContain('ERR_NAME_NOT_RESOLVED');
  });
});

/**
 * The real thing: Chrome, retire.js and a site served from this process.
 *
 * Local rather than remote on purpose — the assertions are about what the probe
 * does with a known set of bundles, and a live site would make them a statement
 * about someone else's deploy. The public feeds are left out for the same
 * reason (they have their own tests in `enrichment.test.ts`); everything else
 * here is the real path, down to the subprocess and the temp directory.
 *
 * The page is deliberately built so each acceptance criterion has exactly one
 * cause: a vulnerable jQuery with a downloadable source map, and a chunk that
 * only a browser would ever see.
 */
const VENDOR_JS = `/*! jQuery v3.4.1 | (c) JS Foundation and other contributors | jquery.org/license */
window.jQuery=function(){};
//# sourceMappingURL=vendor.js.map
`;

/** React with no version anywhere: exactly the DEPS-VERSION-UNDETERMINED case. */
const LATE_CHUNK_JS = `
window.__app=function(){throw Error("Minified React error #418; visit react.dev/errors/418")};
`;

const VENDOR_MAP = JSON.stringify({
  version: 3,
  file: 'vendor.js',
  sources: ['src/index.ts', 'src/api.ts'],
  sourcesContent: ['export const secret = "internal"', 'export const api = "/internal/api"'],
  mappings: 'AAAA',
});

const PAGE = `<!doctype html>
<html lang="es">
  <head><title>Tienda</title><script src="/assets/vendor.js"></script></head>
  <body>
    <h1>Tienda</h1>
    <script>
      // Injected after load: an HTML parse would never find this one.
      var s = document.createElement('script');
      s.src = '/assets/late.chunk';
      document.body.appendChild(s);
    </script>
  </body>
</html>`;

const ROUTES: Readonly<Record<string, { body: string; type: string }>> = {
  '/': { body: PAGE, type: 'text/html; charset=utf-8' },
  '/assets/vendor.js': { body: VENDOR_JS, type: 'application/javascript' },
  '/assets/vendor.js.map': { body: VENDOR_MAP, type: 'application/json' },
  '/assets/late.chunk': { body: LATE_CHUNK_JS, type: 'application/javascript' },
};

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const route = ROUTES[new URL(request.url).pathname];

    return route === undefined
      ? new Response('not found', { status: 404 })
      : new Response(route.body, { headers: { 'content-type': route.type } });
  },
});

afterAll(() => {
  server.stop(true);
});

describe('the DEPS probe against a served site', () => {
  test('downloads the bundles, scans them, and leaves no temp directory behind', async () => {
    const url = `http://localhost:${server.port}/`;
    let directory = '';

    const analysis = await withWorkspace(async (workspace) => {
      directory = workspace.directory;

      const collection = await collectServedScripts({ url, mode: 'quick', pages: 1 }, workspace);
      const retire = await scanWithRetire(collection.directory);
      const [libraries, sourcemaps] = await Promise.all([
        detectLibraryHits(collection.assets),
        findExposedSourcemaps(collection.assets),
      ]);

      // Asserted inside the workspace: afterwards the files are gone by design.
      expect(collection.assets.every((asset) => existsSync(asset.path))).toBe(true);

      return { collection, retire, libraries, sourcemaps, enrichment: EMPTY_ENRICHMENT };
    });

    expect(existsSync(directory)).toBe(false);

    // 1. Every script the page served, including the one injected by script.
    expect(analysis.collection.assets.map((asset) => asset.url).sort()).toEqual([
      `${url}assets/late.chunk`,
      `${url}assets/vendor.js`,
    ]);

    // 2. retire.js ran against the downloaded files and pinned the library.
    const detected = analysis.retire.data.flatMap((file) => file.results);
    expect(detected.map((result) => `${result.component}@${result.version}`)).toEqual([
      'jquery@3.4.1',
    ]);

    // 3. A library with no version in sight, which only a signature can see.
    // jQuery matches a signature too, but retire.js pinned its version, so the
    // adapter subtracts it below and only React is left undetermined.
    expect(analysis.libraries).toEqual([
      { assetUrl: `${url}assets/late.chunk`, library: 'react' },
      { assetUrl: `${url}assets/vendor.js`, library: 'jquery' },
    ]);

    // 4. A source map that really downloads, carrying the original source.
    expect(analysis.sourcemaps.map((map) => map.kind)).toEqual(['linked']);
    expect(analysis.sourcemaps[0]?.sourcesContent).toBe(true);

    const observations = toObservations(analysis);
    const ids = observations.map((observation) => observation.id);

    expect(ids).toContain('DEPS-VULN-MEDIUM');
    expect(ids).toContain('DEPS-SOURCEMAP-EXPOSED');
    expect(ids).toContain('DEPS-VERSION-UNDETERMINED');

    const undetermined = observations.find(
      (observation) => observation.id === 'DEPS-VERSION-UNDETERMINED',
    );
    expect(undetermined?.evidence.undetermined).toBe(1);
    expect(undetermined?.evidence.libraries).toEqual(['react']);
  }, 180_000);
});
