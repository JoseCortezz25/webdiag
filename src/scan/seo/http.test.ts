/**
 * The redirect tracer.
 *
 * Everything here runs against an injected `Fetcher`, because the point of
 * `traceUrl` is the *shape* of the chain and a real server cannot be asked to
 * produce a nine-hop loop on demand.
 */
import { describe, expect, test } from 'bun:test';
import { type Fetcher, fetchText, MAX_BODY_BYTES, traceUrl, USER_AGENT } from './http.ts';

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
  test('returns the status and the body, walking redirects hop by hop', async () => {
    let sent: RequestInit | undefined;
    const { fetch } = router({
      'https://example.com/robots.txt': { status: 301, location: '/robots-v2.txt' },
      'https://example.com/robots-v2.txt': { status: 200, body: 'User-agent: *' },
    });
    const fetchImpl: Fetcher = (url, init) => {
      sent = init;
      return fetch(url, init);
    };

    const result = await fetchText('https://example.com/robots.txt', {
      ...OPTIONS,
      fetchImpl,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('User-agent: *');
    expect(result.finalUrl).toBe('https://example.com/robots-v2.txt');
    // Manual so that every hop passes the address policy; `follow` would let
    // the server steer the request anywhere before we saw the Location.
    expect(sent?.redirect).toBe('manual');
  });

  test('asks for any content type, unlike a page trace', async () => {
    let sent: RequestInit | undefined;
    const fetchImpl: Fetcher = (_url, init) => {
      sent = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    await fetchText('https://example.com/sitemap.xml', { ...OPTIONS, fetchImpl });

    expect(new Headers(sent?.headers).get('accept')).toBe('*/*');
  });

  test('falls back to the requested URL when the response has none', async () => {
    const fetchImpl: Fetcher = () => Promise.resolve(new Response('', { status: 404 }));
    const result = await fetchText('https://example.com/sitemap.xml', { ...OPTIONS, fetchImpl });

    expect(result.finalUrl).toBe('https://example.com/sitemap.xml');
    expect(result.status).toBe(404);
  });
});

describe('body cap', () => {
  /** A body that never ends. Without a streaming cap this fetch never returns. */
  function endless(): Response {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x78));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': '99999999999' },
    });
  }

  test('cuts an oversized body at the cap while streaming and says so', async () => {
    const trace = await traceUrl('https://example.com/', {
      ...OPTIONS,
      fetchImpl: () => Promise.resolve(endless()),
    });

    expect(trace.truncated).toBe(true);
    expect(new TextEncoder().encode(trace.body).length).toBe(MAX_BODY_BYTES);
    expect(trace.contentLength).toBe(99999999999);
  });

  test('a normal body is neither truncated nor guessed at', async () => {
    const { fetch } = router({ 'https://example.com/': { status: 200, body: '<p>hi</p>' } });
    const trace = await traceUrl('https://example.com/', { ...OPTIONS, fetchImpl: fetch });

    expect(trace.truncated).toBe(false);
    expect(trace.body).toBe('<p>hi</p>');
  });
});

describe('address policy', () => {
  test('refuses a redirect to a private address before issuing the request', async () => {
    const { fetch, calls } = router({
      'https://example.com/': { status: 302, location: 'http://169.254.169.254/latest/' },
      'http://169.254.169.254/latest/': { status: 200, body: 'secret' },
    });

    await expect(
      traceUrl('https://example.com/', { ...OPTIONS, fetchImpl: fetch, scanHost: 'example.com' }),
    ).rejects.toThrow(/private or local address/);
    expect(calls).toEqual(['https://example.com/']);
  });

  test('the scan host is followed even when it is a loopback address', async () => {
    const { fetch } = router({
      'http://127.0.0.1:8080/': { status: 301, location: 'http://127.0.0.1:8080/home' },
      'http://127.0.0.1:8080/home': { status: 200, body: 'ok' },
    });

    const trace = await traceUrl('http://127.0.0.1:8080/', {
      ...OPTIONS,
      fetchImpl: fetch,
      scanHost: '127.0.0.1',
    });

    expect(trace.status).toBe(200);
    expect(trace.finalUrl).toBe('http://127.0.0.1:8080/home');
  });

  test('without a scan host, a private start URL is refused outright', async () => {
    const { fetch, calls } = router({ 'http://localhost:9200/': { status: 200, body: '{}' } });

    await expect(
      traceUrl('http://localhost:9200/', { ...OPTIONS, fetchImpl: fetch }),
    ).rejects.toThrow(/private or local address/);
    expect(calls).toEqual([]);
  });
});
