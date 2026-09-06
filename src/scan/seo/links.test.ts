/**
 * The lychee adapter.
 *
 * The parsing tests use recorded `--format json` output rather than a live run,
 * because what has to be pinned down is the mapping — which lychee buckets count
 * as broken and which do not. The one test that spawns the real binary asserts
 * only that it is there and answers, which is all `meta.json` claims.
 */
import { describe, expect, test } from 'bun:test';
import { checkLinks, lycheeVersion, parseLycheeOutput } from './links.ts';

const OK_REPORT = JSON.stringify({
  total: 10,
  successful: 9,
  errors: 1,
  excludes: 2,
  error_map: {
    'https://example.com/': [
      { url: 'https://dead.test/a', status: { text: 'Not Found', code: 404 } },
    ],
  },
});

describe('parseLycheeOutput', () => {
  test('reads the totals and the broken links', () => {
    const report = parseLycheeOutput(OK_REPORT);

    expect(report.outcome).toBe('ok');
    expect(report.total).toBe(10);
    expect(report.successful).toBe(9);
    expect(report.excluded).toBe(2);
    expect(report.broken).toEqual([{ url: 'https://dead.test/a', status: 'Not Found', code: 404 }]);
  });

  test('a clean run reports no broken links', () => {
    const report = parseLycheeOutput(JSON.stringify({ total: 5, successful: 5, error_map: {} }));

    expect(report.outcome).toBe('ok');
    expect(report.broken).toEqual([]);
  });

  test('counts timeouts as broken alongside errors', () => {
    const report = parseLycheeOutput(
      JSON.stringify({
        total: 2,
        successful: 0,
        error_map: { page: [{ url: 'https://b.test/', status: { text: 'Error', code: 500 } }] },
        timeout_map: { page: [{ url: 'https://a.test/', status: { text: 'Timeout' } }] },
      }),
    );

    expect(report.broken.map((link) => link.url)).toEqual(['https://a.test/', 'https://b.test/']);
    expect(report.broken[0]?.code).toBeUndefined();
  });

  test('sorts by URL, so two runs of the same page produce the same report', () => {
    const report = parseLycheeOutput(
      JSON.stringify({
        error_map: {
          page: [
            { url: 'https://z.test/', status: { text: 'Not Found', code: 404 } },
            { url: 'https://a.test/', status: { text: 'Not Found', code: 404 } },
          ],
        },
      }),
    );

    expect(report.broken.map((link) => link.url)).toEqual(['https://a.test/', 'https://z.test/']);
  });

  test('flattens the per-source buckets lychee groups by', () => {
    const report = parseLycheeOutput(
      JSON.stringify({
        error_map: {
          'https://example.com/a': [
            { url: 'https://x.test/', status: { text: 'Gone', code: 410 } },
          ],
          'https://example.com/b': [
            { url: 'https://y.test/', status: { text: 'Gone', code: 410 } },
          ],
        },
      }),
    );

    expect(report.broken).toHaveLength(2);
  });

  test('caps the list so one page cannot produce a 200-row table', () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      url: `https://dead.test/${String(index).padStart(3, '0')}`,
      status: { text: 'Not Found', code: 404 },
    }));

    const report = parseLycheeOutput(JSON.stringify({ error_map: { page: entries } }));

    expect(report.broken).toHaveLength(25);
  });

  test('missing and non-numeric totals read as zero rather than NaN', () => {
    const report = parseLycheeOutput(JSON.stringify({ total: 'muchos', successful: null }));

    expect(report.total).toBe(0);
    expect(report.successful).toBe(0);
    expect(report.excluded).toBe(0);
  });

  test('an entry with no URL is dropped instead of becoming an undefined row', () => {
    const report = parseLycheeOutput(
      JSON.stringify({ error_map: { page: [{ status: { text: 'Not Found' } }] } }),
    );

    expect(report.broken).toEqual([]);
  });

  test('the same broken URL linked from several pages counts once (issue #12)', () => {
    // error_map is keyed by source page: a footer link broken on every crawled
    // page arrives once per page, plus a cached echo in deep mode.
    const report = parseLycheeOutput(
      JSON.stringify({
        error_map: {
          'https://example.com/': [
            {
              url: 'https://dead.test/footer',
              status: { text: 'Rejected status code', code: 999 },
            },
          ],
          'https://example.com/precios': [
            { url: 'https://dead.test/footer', status: { text: 'Error (cached)', code: 999 } },
          ],
          'https://example.com/about': [
            { url: 'https://dead.test/footer', status: { text: 'Error (cached)', code: 999 } },
          ],
        },
      }),
    );

    expect(report.broken).toEqual([
      { url: 'https://dead.test/footer', status: 'Rejected status code', code: 999 },
    ]);
  });

  test('an entry with no status text is reported as unknown, not as missing', () => {
    const report = parseLycheeOutput(
      JSON.stringify({ error_map: { page: [{ url: 'https://a.test/' }] } }),
    );

    expect(report.broken).toEqual([{ url: 'https://a.test/', status: 'unknown', code: undefined }]);
  });

  test('non-JSON output throws, so the caller can degrade deliberately', () => {
    expect(() => parseLycheeOutput('lychee: error: no such option')).toThrow();
  });
});

describe('checkLinks', () => {
  test('uses the injected runner, so a unit test spawns nothing', async () => {
    const calls: [readonly string[], number][] = [];
    const report = await checkLinks(['https://example.com/'], {
      timeoutMs: 1_234,
      run: (urls, timeoutMs) => {
        calls.push([urls, timeoutMs]);
        return Promise.resolve(parseLycheeOutput(OK_REPORT));
      },
    });

    expect(calls).toEqual([[['https://example.com/'], 1_234]]);
    expect(report.broken).toHaveLength(1);
  });

  test('a deep run hands every sampled page to one lychee invocation', async () => {
    const calls: (readonly string[])[] = [];

    await checkLinks(['https://example.com/', 'https://example.com/precios'], {
      timeoutMs: 1_000,
      run: (urls) => {
        calls.push(urls);
        return Promise.resolve(parseLycheeOutput(OK_REPORT));
      },
    });

    expect(calls).toEqual([['https://example.com/', 'https://example.com/precios']]);
  });

  test('no pages to check degrades instead of spawning lychee with no input', async () => {
    const report = await checkLinks([], { timeoutMs: 1_000 });

    expect(report.outcome).toBe('failed');
    expect(report.broken).toEqual([]);
  });

  test('an injected failure is passed through as an outcome, not thrown', async () => {
    const report = await checkLinks(['https://example.com/'], {
      timeoutMs: 10,
      run: () =>
        Promise.resolve({
          outcome: 'unavailable',
          detail: 'lychee not on PATH',
          total: 0,
          successful: 0,
          excluded: 0,
          broken: [],
        }),
    });

    expect(report.outcome).toBe('unavailable');
    expect(report.broken).toEqual([]);
  });
});

describe('lychee, for real', () => {
  test('reports a version when it is installed, and nothing when it is not', async () => {
    const version = await lycheeVersion();

    // Either answer is correct — the axis degrades rather than failing — but the
    // shape must be honest, because `meta.json` prints it verbatim.
    if (version === undefined) {
      expect(version).toBeUndefined();
    } else {
      expect(version).toMatch(/^\d+\.\d+/);
    }
  });
});
