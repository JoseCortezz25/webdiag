import { afterAll, describe, expect, test } from 'bun:test';
import type { ProbeContext } from '../probe.ts';
import { runProbe } from '../probe.ts';
import { RAW_SCHEMA_VERSION } from '../raw.ts';
import type { AxeAnalysis } from './adapter.ts';
import { axeReport, axeRule } from './fixture.ts';
import { MANUAL_REVIEW_ID } from './mapping.ts';
import { AXE_TOOL, a11yProbe } from './probe.ts';

const CONTEXT: ProbeContext = {
  url: 'https://example.test/',
  mode: 'quick',
  pages: 1,
};

function stubAnalysis(overrides: Partial<AxeAnalysis> = {}): AxeAnalysis {
  return {
    report: axeReport({ violations: [axeRule('image-alt', ['img.hero'])] }),
    browser: { name: 'chrome', version: '152.0.7977.75' },
    pageUrl: 'https://example.test/',
    httpStatus: 200,
    navigationTimedOut: false,
    ...overrides,
  };
}

describe('a11yProbe', () => {
  test('writes a raw document the normalizer can read', async () => {
    const raw = await a11yProbe(() => Promise.resolve(stubAnalysis())).run(CONTEXT);

    expect(raw.schema).toBe(RAW_SCHEMA_VERSION);
    expect(raw.axis).toBe('A11Y');
    expect(raw.target).toEqual({ url: 'https://example.test/', mode: 'quick' });
    expect(raw.observations.map((observation) => observation.id)).toEqual([
      'A11Y-IMG-ALT-MISSING',
      MANUAL_REVIEW_ID,
    ]);
  });

  test('records the Chrome build alongside the axe version (spec §6)', async () => {
    const outcome = await runProbe(
      a11yProbe(() => Promise.resolve(stubAnalysis())),
      CONTEXT,
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.tool).toEqual({ name: 'axe-core', version: '4.13.0+chrome-152.0.7977.75' });
  });

  test('degrades the axis instead of ending the run when the browser fails', async () => {
    const outcome = await runProbe(
      a11yProbe(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'))),
      CONTEXT,
    );

    expect(outcome.status).toBe('failed');
    // Nothing ran, so the declared identity is the only honest answer.
    expect(outcome.tool).toEqual(AXE_TOOL);
    expect(outcome.status === 'failed' && outcome.error).toContain('ERR_NAME_NOT_RESOLVED');
  });
});

/**
 * The real thing: Chrome, axe-core and a page served from this process.
 *
 * Local rather than remote on purpose — the assertions are about what axe finds
 * in a known DOM, and a live site would make them a statement about someone
 * else's deploy. The page below is deliberately broken in one way per catalog ID
 * the ticket lists.
 */
const BROKEN_PAGE = `<!doctype html>
<html>
  <head><title>Broken</title></head>
  <body>
    <div id="app">
      <h1>Contacto</h1>
      <h4>Escríbenos</h4>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <p style="color:#bbbbbb;background:#ffffff">Texto de bajo contraste</p>
      <form>
        <input type="text" name="email">
      </form>
      <button></button>
      <div role="button" aria-hidden="true" tabindex="0">Oculto pero enfocable</div>
      <div aria-labelledby="no-existe" role="region"></div>
    </div>
  </body>
</html>`;

describe('a11yProbe against a real browser', () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(BROKEN_PAGE, { headers: { 'content-type': 'text/html' } }),
  });

  afterAll(() => {
    server.stop(true);
  });

  test(
    'finds the catalog IDs the ticket names on a deliberately broken page',
    async () => {
      const raw = await a11yProbe().run({ ...CONTEXT, url: server.url.href });
      const ids = raw.observations.map((observation) => observation.id);

      expect(ids).toContain('A11Y-LANG-MISSING');
      expect(ids).toContain('A11Y-IMG-ALT-MISSING');
      expect(ids).toContain('A11Y-CONTRAST-INSUFFICIENT');
      expect(ids).toContain('A11Y-FORM-LABEL-MISSING');
      expect(ids).toContain('A11Y-BUTTON-NAME-MISSING');
      expect(ids).toContain('A11Y-HEADING-ORDER');
      expect(ids).toContain('A11Y-ARIA-INVALID');
      expect(ids).toContain('A11Y-LANDMARKS-MISSING');
      expect(ids).toContain(MANUAL_REVIEW_ID);

      // The tool string is what `meta.json` publishes for this axis.
      expect(raw.tool.name).toBe('axe-core');
      expect(raw.tool.version).toMatch(/^\d+\.\d+\.\d+\+chrome-\d+\./);
    },
    { timeout: 120_000 },
  );
});
