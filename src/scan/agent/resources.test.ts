import { describe, expect, test } from 'bun:test';
import type { Fetcher, HttpResponse } from './http.ts';
import { isSoftHtml, resolveFromRoot } from './http.ts';
import { probeResource, probeResources, WELL_KNOWN_PATHS } from './resources.ts';

function respond(partial: Partial<HttpResponse>): HttpResponse {
  return {
    url: 'https://example.com/llms.txt',
    status: 200,
    contentType: 'text/plain',
    body: '# llms',
    error: undefined,
    ...partial,
  };
}

function fetcherOf(byUrl: Readonly<Record<string, HttpResponse>>): Fetcher {
  return (url: string) =>
    Promise.resolve(byUrl[url] ?? respond({ url, status: 404, body: '', contentType: undefined }));
}

describe('resolveFromRoot', () => {
  test('resolves against the origin, not the scanned path', () => {
    expect(resolveFromRoot('https://example.com/es/servicios', '/llms.txt')).toBe(
      'https://example.com/llms.txt',
    );
  });
});

describe('isSoftHtml', () => {
  test('detects an HTML shell served for a text path', () => {
    expect(isSoftHtml(respond({ contentType: 'text/html; charset=utf-8' }))).toBe(true);
    expect(isSoftHtml(respond({ contentType: undefined, body: '<!DOCTYPE html><html>' }))).toBe(
      true,
    );
    expect(isSoftHtml(respond({}))).toBe(false);
  });
});

describe('probeResource', () => {
  test('200 with a text body is present', async () => {
    const probe = await probeResource(
      fetcherOf({ 'https://example.com/llms.txt': respond({}) }),
      'https://example.com/',
      '/llms.txt',
    );

    expect(probe.state).toBe('present');
  });

  test('404 is absent, and says so', async () => {
    const probe = await probeResource(fetcherOf({}), 'https://example.com/', '/llms.txt');

    expect(probe.state).toBe('absent');
    expect(probe.detail).toBe('respondio 404');
  });

  test('200 with the site HTML is a soft 404, not a file', async () => {
    const probe = await probeResource(
      fetcherOf({
        'https://example.com/llms.txt': respond({
          contentType: 'text/html',
          body: '<html>404</html>',
        }),
      }),
      'https://example.com/',
      '/llms.txt',
    );

    expect(probe.state).toBe('absent');
    expect(probe.detail).toContain('404 encubierto');
  });

  test('200 with an empty body is absent', async () => {
    const probe = await probeResource(
      fetcherOf({ 'https://example.com/llms.txt': respond({ body: '   ' }) }),
      'https://example.com/',
      '/llms.txt',
    );

    expect(probe.state).toBe('absent');
    expect(probe.detail).toContain('cuerpo vacio');
  });

  test('a request that never completed is unknown, never absent', async () => {
    const probe = await probeResource(
      fetcherOf({
        'https://example.com/llms.txt': respond({
          status: null,
          body: '',
          contentType: undefined,
          error: 'The operation timed out.',
        }),
      }),
      'https://example.com/',
      '/llms.txt',
    );

    expect(probe.state).toBe('unknown');
    expect(probe.detail).toBe('The operation timed out.');
  });
});

describe('probeResources', () => {
  test('keeps the requested order so evidence is stable', async () => {
    const probes = await probeResources(fetcherOf({}), 'https://example.com/', WELL_KNOWN_PATHS);

    expect(probes.map((probe) => probe.path)).toEqual([...WELL_KNOWN_PATHS]);
  });
});
