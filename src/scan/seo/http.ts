/**
 * The HTTP layer of the SEO probe.
 *
 * Redirects are followed by hand, with `redirect: 'manual'`, for one reason:
 * three of this axis' findings *are* the redirect chain. `fetch` with the
 * default `follow` collapses the hops into a single final response and throws
 * away exactly the evidence `SEO-REDIRECT-CHAIN` and `SEO-REDIRECT-LOOP` are
 * about. So the loop lives here, and every hop is recorded.
 *
 * Nothing in this file decides what a status *means*. A 404 is reported as 404;
 * turning that into a blocking finding is `checks.ts`, which is pure and can be
 * tested without a socket.
 */
import { VERSION } from '../../version.ts';

/** Honest, and it says who to contact. A UA that lies is a UA nobody can block. */
export const USER_AGENT = `Mozilla/5.0 (compatible; webdiag/${VERSION}; +https://github.com/JoseCortezz25/webdiag)`;

/** Google gives up at 5 hops; 10 is enough to see a loop before we do. */
const MAX_HOPS = 10;

/** Bodies past this are truncated before parsing. A 2 MB HTML page is already pathological. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type Hop = {
  readonly url: string;
  readonly status: number;
  readonly location: string | undefined;
};

export type FetchTrace = {
  readonly requestedUrl: string;
  /** Where the chain came to rest. Equals `requestedUrl` when nothing redirected. */
  readonly finalUrl: string;
  readonly status: number;
  /** Lower-cased header names, as `Headers` yields them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
  /** Redirect hops only. The terminal response is not a hop. */
  readonly hops: readonly Hop[];
  /** True when a URL repeated, or when the chain outran `MAX_HOPS`. */
  readonly loop: boolean;
  readonly loopAt: string | undefined;
};

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type TraceOptions = {
  readonly timeoutMs: number;
  readonly fetchImpl?: Fetcher;
  /** `false` skips reading the body — used for the canonical target probe. */
  readonly readBody?: boolean;
};

function headersOf(response: Response): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...response.headers].map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBody(response: Response): Promise<{ body: string; truncated: boolean }> {
  const text = await response.text();
  return text.length > MAX_BODY_BYTES
    ? { body: text.slice(0, MAX_BODY_BYTES), truncated: true }
    : { body: text, truncated: false };
}

/**
 * Walks the redirect chain and reports what it saw.
 *
 * A loop is detected by identity of the resolved URL, not by hop count alone:
 * `A → B → A` is a loop after three requests, and saying so is more useful than
 * saying "too many redirects".
 */
export async function traceUrl(url: string, options: TraceOptions): Promise<FetchTrace> {
  const call = options.fetchImpl ?? fetch;
  const hops: Hop[] = [];
  const seen = new Set<string>([url]);

  let current = url;

  for (let attempt = 0; attempt <= MAX_HOPS; attempt += 1) {
    const response = await call(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });

    const headers = headersOf(response);

    if (!isRedirect(response.status)) {
      const { body, truncated } =
        options.readBody === false ? { body: '', truncated: false } : await readBody(response);

      return {
        requestedUrl: url,
        finalUrl: current,
        status: response.status,
        headers,
        body,
        truncated,
        hops,
        loop: false,
        loopAt: undefined,
      };
    }

    const location = headers.location;
    hops.push({ url: current, status: response.status, location });

    if (location === undefined || location === '') {
      // A redirect status with no target is a dead end, not a loop.
      return {
        requestedUrl: url,
        finalUrl: current,
        status: response.status,
        headers,
        body: '',
        truncated: false,
        hops,
        loop: false,
        loopAt: undefined,
      };
    }

    const next = new URL(location, current).toString();

    if (seen.has(next)) {
      return {
        requestedUrl: url,
        finalUrl: next,
        status: response.status,
        headers,
        body: '',
        truncated: false,
        hops,
        loop: true,
        loopAt: next,
      };
    }

    seen.add(next);
    current = next;
  }

  // Ten hops without repeating a URL is not a cycle, but no crawler follows it
  // either, so it is reported as a loop: the operator has to fix the same thing.
  return {
    requestedUrl: url,
    finalUrl: current,
    status: 508,
    headers: {},
    body: '',
    truncated: false,
    hops,
    loop: true,
    loopAt: current,
  };
}

/** Fetches a text resource without following it anywhere. Used for robots and sitemaps. */
export async function fetchText(
  url: string,
  options: TraceOptions,
): Promise<{ readonly status: number; readonly body: string; readonly finalUrl: string }> {
  const call = options.fetchImpl ?? fetch;

  const response = await call(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
  });

  const { body } = await readBody(response);
  return { status: response.status, body, finalUrl: response.url === '' ? url : response.url };
}
