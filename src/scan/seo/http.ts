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
import { refusalFor } from '../net/address-guard.ts';
import { readBodyCapped } from '../net/body.ts';

/** Honest, and it says who to contact. A UA that lies is a UA nobody can block. */
export const USER_AGENT = `Mozilla/5.0 (compatible; webdiag/${VERSION}; +https://github.com/JoseCortezz25/webdiag)`;

/** Google gives up at 5 hops; 10 is enough to see a loop before we do. */
const MAX_HOPS = 10;

/**
 * Bodies past this are cut *while streaming*, so the cap bounds memory and not
 * just what reaches the parser. A 2 MB HTML page is already pathological.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

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
  /**
   * The `content-length` the terminal response declared, when it sent a usable
   * one. It is what lets a size limit be checked on a body that was cut at the
   * cap: the header describes the whole document, the cap only what was read.
   */
  readonly contentLength: number | undefined;
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
  /**
   * The hostname the operator pointed the scan at. Redirects and derived URLs
   * may lead anywhere public, and back to this host even when it is private;
   * they may not lead to any *other* private, loopback or link-local address.
   * Left undefined, only public addresses are followed.
   */
  readonly scanHost?: string | undefined;
  /** `Accept` header for the request. Defaults to what a browser sends for a page. */
  readonly accept?: string;
};

const PAGE_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';

/** Throws when the address policy refuses `url`, so no request is ever issued. */
function assertAllowed(url: string, options: TraceOptions): void {
  const refusal = refusalFor(url, { scanHost: options.scanHost });

  if (refusal !== undefined) {
    throw new Error(refusal);
  }
}

function headersOf(response: Response): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...response.headers].map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBody(
  response: Response,
): Promise<{ body: string; truncated: boolean; contentLength: number | undefined }> {
  const { body, truncated, contentLength } = await readBodyCapped(response, MAX_BODY_BYTES);
  return { body, truncated, contentLength };
}

/** Discards a body we are not going to read, so the connection is released. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
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
    // Every hop is checked, not just the first: the first URL is the
    // operator's, every later one was chosen by the site being scanned.
    assertAllowed(current, options);

    const response = await call(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: options.accept ?? PAGE_ACCEPT },
    });

    const headers = headersOf(response);

    if (!isRedirect(response.status)) {
      if (options.readBody === false) {
        await discardBody(response);

        return {
          requestedUrl: url,
          finalUrl: current,
          status: response.status,
          headers,
          body: '',
          truncated: false,
          contentLength: undefined,
          hops,
          loop: false,
          loopAt: undefined,
        };
      }

      const { body, truncated, contentLength } = await readBody(response);

      return {
        requestedUrl: url,
        finalUrl: current,
        status: response.status,
        headers,
        body,
        truncated,
        contentLength,
        hops,
        loop: false,
        loopAt: undefined,
      };
    }

    await discardBody(response);

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
        contentLength: undefined,
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
        contentLength: undefined,
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
    contentLength: undefined,
    hops,
    loop: true,
    loopAt: current,
  };
}

export type TextResource = {
  readonly status: number;
  readonly body: string;
  readonly finalUrl: string;
  /** True when the body was cut at `MAX_BODY_BYTES`; `body` is then a prefix. */
  readonly truncated: boolean;
  /** Declared size of the whole resource, when the server said. */
  readonly contentLength: number | undefined;
};

/**
 * Fetches a text resource such as robots.txt or a sitemap.
 *
 * Redirects are followed through the same walk as `traceUrl`, so every hop is
 * subject to the address policy: a `Sitemap:` line that redirects to an
 * internal address is refused, not fetched. A chain that loops or outruns the
 * hop limit surfaces as its terminal status with an empty body.
 */
export async function fetchText(url: string, options: TraceOptions): Promise<TextResource> {
  const trace = await traceUrl(url, { ...options, accept: options.accept ?? '*/*' });

  return {
    status: trace.status,
    body: trace.body,
    finalUrl: trace.finalUrl,
    truncated: trace.truncated,
    contentLength: trace.contentLength,
  };
}
