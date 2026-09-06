/**
 * The AGENT probe's one network seam. Everything runs against an injected
 * `fetchImpl`, so the redirect walk, the address policy and the body cap are
 * asserted without a socket.
 */
import { describe, expect, test } from 'bun:test';
import { httpFetcher, MAX_BODY_BYTES } from './http.ts';

type Route = { status: number; body?: string; location?: string; type?: string };

function router(routes: Readonly<Record<string, Route>>) {
  const calls: string[] = [];
  const inits: RequestInit[] = [];

  const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url);
    inits.push(init);
    const route = routes[url];

    if (route === undefined) {
      return Promise.resolve(new Response('', { status: 404 }));
    }

    const headers = new Headers({ 'content-type': route.type ?? 'text/html' });
    if (route.location !== undefined) {
      headers.set('location', route.location);
    }
    return Promise.resolve(new Response(route.body ?? '', { status: route.status, headers }));
  };

  return { fetchImpl, calls, inits };
}

describe('httpFetcher', () => {
  test('returns status, content type and body for a direct answer', async () => {
    const { fetchImpl } = router({
      'https://example.com/llms.txt': { status: 200, body: '# site', type: 'text/plain' },
    });

    const response = await httpFetcher({ fetchImpl })('https://example.com/llms.txt');

    expect(response).toEqual({
      url: 'https://example.com/llms.txt',
      status: 200,
      contentType: 'text/plain',
      body: '# site',
      error: undefined,
    });
  });

  test('follows redirects by hand and reports the terminal response', async () => {
    const { fetchImpl, calls, inits } = router({
      'https://example.com/': { status: 301, location: 'https://www.example.com/' },
      'https://www.example.com/': { status: 200, body: '<!doctype html>' },
    });

    const response = await httpFetcher({ fetchImpl })('https://example.com/');

    expect(response.status).toBe(200);
    expect(response.body).toBe('<!doctype html>');
    expect(calls).toEqual(['https://example.com/', 'https://www.example.com/']);
    expect(inits.every((init) => init.redirect === 'manual')).toBe(true);
  });

  test('a redirect into a private address is refused, not followed', async () => {
    const { fetchImpl, calls } = router({
      'https://example.com/': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
      'http://169.254.169.254/latest/meta-data/': { status: 200, body: 'ami-id' },
    });

    const response = await httpFetcher({ fetchImpl, scanHost: 'example.com' })(
      'https://example.com/',
    );

    expect(response.status).toBeNull();
    expect(response.error).toContain('private or local address');
    expect(calls).toEqual(['https://example.com/']);
  });

  test('the scan host itself may be a loopback address', async () => {
    const { fetchImpl } = router({
      'http://127.0.0.1:4000/robots.txt': { status: 200, body: 'x' },
    });

    const response = await httpFetcher({ fetchImpl, scanHost: '127.0.0.1' })(
      'http://127.0.0.1:4000/robots.txt',
    );

    expect(response.status).toBe(200);
  });

  test('a redirect chain that never settles becomes an error, not a hang', async () => {
    const routes: Record<string, Route> = {};
    for (let index = 0; index < 20; index += 1) {
      routes[`https://example.com/${index}`] = { status: 302, location: `/${index + 1}` };
    }
    const { fetchImpl, calls } = router(routes);

    const response = await httpFetcher({ fetchImpl })('https://example.com/0');

    expect(response.status).toBeNull();
    expect(response.error).toContain('redirected more than');
    expect(calls.length).toBeLessThanOrEqual(7);
  });

  test('cuts an endless body at the byte cap while streaming', async () => {
    const fetchImpl = (): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    };

    const response = await httpFetcher({ fetchImpl })('https://example.com/');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(MAX_BODY_BYTES);
  });

  test('a transport failure comes back as status null with the reason', async () => {
    const fetchImpl = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'));

    const response = await httpFetcher({ fetchImpl })('https://example.com/');

    expect(response.status).toBeNull();
    expect(response.error).toBe('ECONNREFUSED');
  });
});
