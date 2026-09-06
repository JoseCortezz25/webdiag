/**
 * The redirect tracer.
 *
 * Everything here runs against an injected `Fetcher`, because the point of
 * `traceUrl` is the *shape* of the chain and a real server cannot be asked to
 * produce a nine-hop loop on demand.
 */
import { describe, expect, test } from 'bun:test';
import { type Fetcher, fetchText, traceUrl, USER_AGENT } from './http.ts';

const OPTIONS = { timeoutMs: 1_000 };

/** A fetcher driven by a routing table, so a chain is written as a chain. */
function router(
  routes: Readonly<
    Record<string, { status: number; location?: string; body?: string; type?: string }>
  >,
): {
  fetch: Fetcher;
  calls: string[];
} {
  const calls: string[] = [];

  const fetch: Fetcher = (url) => {
    calls.push(url);
    const route = routes[url];

    if (route === undefined) {
      return Promise.resolve(new Response('not in table', { status: 404 }));
    }

    const headers = new Headers({ 'content-type': route.type ?? 'text/html' });
    if (route.location !== undefined) {
      headers.set('location', route.location);
    }

    return Promise.resolve(new Response(route.body ?? '', { status: route.status, headers }));
  };

  return { fetch, calls };
}

describe('traceUrl', () => {
  test('a direct 200 is a chain with no hops', async () => {
    const { fetch } = router({ 'https://example.com/': { status: 200, body: '<html></html>' } });
    const trace = await traceUrl('https://example.com/', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.status).toBe(200);
    expect(trace.hops).toEqual([]);
    expect(trace.finalUrl).toBe('https://example.com/');
    expect(trace.loop).toBe(false);
    expect(trace.body).toBe('<html></html>');
  });

  test('records every hop instead of collapsing them', async () => {
    const { fetch } = router({
      'http://example.com/': { status: 301, location: 'https://example.com/' },
      'https://example.com/': { status: 308, location: 'https://example.com/es/' },
      'https://example.com/es/': { status: 200, body: 'ok' },
    });

    const trace = await traceUrl('http://example.com/', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.hops).toEqual([
      { url: 'http://example.com/', status: 301, location: 'https://example.com/' },
      { url: 'https://example.com/', status: 308, location: 'https://example.com/es/' },
    ]);
    expect(trace.finalUrl).toBe('https://example.com/es/');
    expect(trace.status).toBe(200);
    expect(trace.requestedUrl).toBe('http://example.com/');
  });

  test('resolves a relative Location against the URL that sent it', async () => {
    const { fetch } = router({
      'https://example.com/a': { status: 302, location: '/b' },
      'https://example.com/b': { status: 200, body: 'ok' },
    });

    const trace = await traceUrl('https://example.com/a', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.finalUrl).toBe('https://example.com/b');
  });

  test('detects a two-URL loop by identity and says where it closed', async () => {
    const { fetch } = router({
      'https://example.com/a': { status: 301, location: '/b' },
      'https://example.com/b': { status: 301, location: '/a' },
    });

    const trace = await traceUrl('https://example.com/a', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.loop).toBe(true);
    expect(trace.loopAt).toBe('https://example.com/a');
    expect(trace.hops).toHaveLength(2);
  });

  test('detects a URL redirecting to itself', async () => {
    const { fetch } = router({ 'https://example.com/a': { status: 301, location: '/a' } });
    const trace = await traceUrl('https://example.com/a', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.loop).toBe(true);
    expect(trace.loopAt).toBe('https://example.com/a');
  });

  test('reports a chain that never repeats but never ends as a loop too', async () => {
    // No crawler follows this either, and the operator has to fix the same thing.
    const routes: Record<string, { status: number; location: string }> = {};
    for (let index = 0; index < 30; index += 1) {
      routes[`https://example.com/${index}`] = { status: 301, location: `/${index + 1}` };
    }

    const { fetch, calls } = router(routes);
    const trace = await traceUrl('https://example.com/0', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.loop).toBe(true);
    // Bounded: it stops at the hop cap rather than walking all thirty.
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  test('a redirect status with no Location is a dead end, not a loop', async () => {
    const { fetch } = router({ 'https://example.com/a': { status: 301 } });
    const trace = await traceUrl('https://example.com/a', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.loop).toBe(false);
    expect(trace.status).toBe(301);
    expect(trace.hops).toHaveLength(1);
  });

  test('a 404 is reported as 404, not interpreted', async () => {
    const { fetch } = router({ 'https://example.com/x': { status: 404, body: 'nope' } });
    const trace = await traceUrl('https://example.com/x', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.status).toBe(404);
    expect(trace.hops).toEqual([]);
  });

  test('303 counts as a redirect hop like the others', async () => {
    const { fetch } = router({
      'https://example.com/': { status: 303, location: '/b' },
      'https://example.com/b': { status: 200 },
    });
    const trace = await traceUrl('https://example.com/', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.hops).toHaveLength(1);
    expect(trace.finalUrl).toBe('https://example.com/b');
  });

  test('a 304 is not a redirect and ends the chain', async () => {
    const { fetch } = router({ 'https://example.com/': { status: 304 } });
    const trace = await traceUrl('https://example.com/', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.hops).toEqual([]);
    expect(trace.status).toBe(304);
  });

  test('lower-cases header names and keeps the body readable', async () => {
    const fetchImpl: Fetcher = () =>
      Promise.resolve(
        new Response('<html>hola</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex' },
        }),
      );

    const trace = await traceUrl('https://example.com/', { ...OPTIONS, fetchImpl });

    expect(trace.headers['x-robots-tag']).toBe('noindex');
    expect(trace.headers['content-type']).toBe('text/html');
  });

  test('sends an honest user agent that says who to contact', async () => {
    const sent: RequestInit[] = [];
    const fetchImpl: Fetcher = (_url, init) => {
      sent.push(init);
      return Promise.resolve(new Response('', { status: 200 }));
    };

    await traceUrl('https://example.com/', { ...OPTIONS, fetchImpl });

    const init = sent[0];
    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toContain('webdiag');
    expect(USER_AGENT).toContain('github.com');
    // Manual, because three of this axis' findings *are* the redirect chain.
    expect(init?.redirect).toBe('manual');
  });

  test('readBody:false skips the body, which is all the canonical probe needs', async () => {
    const { fetch } = router({ 'https://example.com/': { status: 200, body: 'mucho texto' } });
    const trace = await traceUrl('https://example.com/', {
      ...OPTIONS,
      fetchImpl: fetch,
      readBody: false,
    });

    expect(trace.body).toBe('');
    expect(trace.status).toBe(200);
  });

  test('a rejected fetch propagates rather than being reported as a status', async () => {
    const fetchImpl: Fetcher = () => Promise.reject(new Error('ECONNREFUSED'));

    expect(traceUrl('https://offline.test/', { ...OPTIONS, fetchImpl })).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

describe('fetchText', () => {
  test('returns the status and the body without walking redirects itself', async () => {
    let sent: RequestInit | undefined;
    const fetchImpl: Fetcher = (_url, init) => {
      sent = init;
      return Promise.resolve(new Response('User-agent: *', { status: 200 }));
    };

    const result = await fetchText('https://example.com/robots.txt', {
      ...OPTIONS,
      fetchImpl,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('User-agent: *');
    expect(sent?.redirect).toBe('follow');
  });

  test('falls back to the requested URL when the response has none', async () => {
    const fetchImpl: Fetcher = () => Promise.resolve(new Response('', { status: 404 }));
    const result = await fetchText('https://example.com/sitemap.xml', { ...OPTIONS, fetchImpl });

    expect(result.finalUrl).toBe('https://example.com/sitemap.xml');
    expect(result.status).toBe(404);
  });
});
