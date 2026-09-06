import { describe, expect, test } from 'bun:test';
import {
  EPSS_API_URL,
  fetchEpss,
  fetchKev,
  fetchLatestVersions,
  KEV_FEED_URL,
} from './enrichment.ts';
import type { Fetcher } from './sourcemaps.ts';

const KEV_BODY = JSON.stringify({
  catalogVersion: '2026.09.01',
  vulnerabilities: [{ cveID: 'CVE-2020-11022' }, { cveID: 'CVE-2019-11358' }],
});

function fetcherFor(
  responses: Readonly<Record<string, { status: number; body: string }>>,
): Fetcher {
  return (url) => Promise.resolve(responses[url] ?? { status: 404, body: '' });
}

const failing: Fetcher = () => Promise.reject(new Error('ENETUNREACH'));

describe('fetchKev', () => {
  test('reports only the CVEs it was asked about', async () => {
    const kev = await fetchKev(
      ['CVE-2020-11022', 'CVE-2020-11023'],
      fetcherFor({ [KEV_FEED_URL]: { status: 200, body: KEV_BODY } }),
    );

    expect(kev).toEqual({
      available: true,
      listed: ['CVE-2020-11022'],
      catalogVersion: '2026.09.01',
    });
  });

  test('an unreachable feed is unavailable, never an empty answer', async () => {
    const kev = await fetchKev(['CVE-2020-11022'], failing);

    expect(kev.available).toBe(false);
    expect(kev.listed).toEqual([]);
  });

  test('never downloads the catalog when there is no CVE to look up', async () => {
    const kev = await fetchKev([], () => {
      throw new Error('the feed must not be fetched');
    });

    expect(kev).toEqual({ available: true, listed: [], catalogVersion: undefined });
  });
});

describe('fetchEpss', () => {
  test('asks for the CVEs in one deduplicated, ordered batch', async () => {
    const asked: string[] = [];
    const fetcher: Fetcher = (url) => {
      asked.push(url);
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({ data: [{ cve: 'CVE-2020-11022', epss: '0.42163' }] }),
      });
    };

    const epss = await fetchEpss(['CVE-2020-11022', 'CVE-2019-11358', 'CVE-2020-11022'], fetcher);

    expect(asked).toEqual([`${EPSS_API_URL}?cve=CVE-2019-11358,CVE-2020-11022`]);
    expect(epss).toEqual({ available: true, scores: { 'CVE-2020-11022': 0.42163 } });
  });

  test('an unavailable API leaves every score unknown', async () => {
    expect(await fetchEpss(['CVE-2020-11022'], failing)).toEqual({ available: false, scores: {} });
  });
});

describe('fetchLatestVersions', () => {
  test('reads the latest published version of each component', async () => {
    const registry = await fetchLatestVersions(
      ['jquery'],
      fetcherFor({
        'https://registry.npmjs.org/jquery/latest': {
          status: 200,
          body: JSON.stringify({ version: '3.7.1' }),
        },
      }),
    );

    expect(registry).toEqual({ available: true, latest: { jquery: '3.7.1' } });
  });

  test('a component npm never published is an answer, not a failure', async () => {
    const registry = await fetchLatestVersions(['some-vendored-widget'], fetcherFor({}));

    expect(registry).toEqual({ available: true, latest: {} });
  });

  test('an unreachable registry cannot be read as "nothing is outdated"', async () => {
    expect(await fetchLatestVersions(['jquery'], failing)).toEqual({
      available: false,
      latest: {},
    });
  });
});
