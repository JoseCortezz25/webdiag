import { describe, expect, test } from 'bun:test';
import { type FetchLike, fetchFieldData } from './crux.ts';

function respondWith(status: number, body: unknown): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const RECORD = {
  record: {
    metrics: {
      largest_contentful_paint: { percentiles: { p75: 4600 } },
      // CrUX returns CLS percentiles as strings; everything else as numbers.
      cumulative_layout_shift: { percentiles: { p75: '0.19' } },
      interaction_to_next_paint: { percentiles: { p75: 320 } },
    },
  },
};

describe('fetchFieldData', () => {
  test('reports the missing key rather than pretending it asked', async () => {
    const field = await fetchFieldData({ url: 'https://example.com/', apiKey: undefined });

    expect(field.available).toBe(false);
    expect(field.available === false && field.reason).toContain('WEBDIAG_CRUX_API_KEY');
  });

  test('parses the p75 of each metric, strings included', async () => {
    const field = await fetchFieldData({
      url: 'https://example.com/servicios',
      apiKey: 'k',
      fetchImpl: respondWith(200, RECORD),
    });

    expect(field).toEqual({
      available: true,
      source: 'CrUX',
      metrics: { lcp: 4600, cls: 0.19, inp: 320 },
    });
  });

  test('queries the origin, not the page', async () => {
    let body = '';
    const field = await fetchFieldData({
      url: 'https://example.com/servicios?utm=1',
      apiKey: 'k',
      fetchImpl: (_url, init) => {
        body = String(init.body ?? '');
        return Promise.resolve(new Response(JSON.stringify(RECORD), { status: 200 }));
      },
    });

    expect(JSON.parse(body).origin).toBe('https://example.com');
    expect(field.available).toBe(true);
  });

  test('a 404 means the origin has no traffic, and says so', async () => {
    const field = await fetchFieldData({
      url: 'https://example.com/',
      apiKey: 'k',
      fetchImpl: respondWith(404, { error: {} }),
    });

    expect(field.available).toBe(false);
    expect(field.available === false && field.reason).toContain('trafico suficiente');
  });

  test('a rate limit degrades the axis instead of failing the probe', async () => {
    const field = await fetchFieldData({
      url: 'https://example.com/',
      apiKey: 'k',
      fetchImpl: respondWith(429, {}),
    });

    expect(field.available).toBe(false);
    expect(field.available === false && field.reason).toContain('429');
  });

  test('a thrown request is still an answer', async () => {
    const field = await fetchFieldData({
      url: 'https://example.com/',
      apiKey: 'k',
      fetchImpl: () => Promise.reject(new Error('ENOTFOUND')),
    });

    expect(field.available).toBe(false);
    expect(field.available === false && field.reason).toContain('ENOTFOUND');
  });

  test('a record with no usable metric is not field data', async () => {
    const field = await fetchFieldData({
      url: 'https://example.com/',
      apiKey: 'k',
      fetchImpl: respondWith(200, { record: { metrics: {} } }),
    });

    expect(field.available).toBe(false);
  });
});
