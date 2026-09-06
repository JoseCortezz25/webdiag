/**
 * The one place the AGENT probe touches the network.
 *
 * Everything else in `agent/` is a pure function over strings, which is what
 * makes the axis testable without a server. The seam is `Fetcher`: the probe
 * receives one, so a test drives the same code path a real run does.
 *
 * Two rules shape it:
 *
 *  - **A request never throws.** A refused connection, a DNS miss and a timeout
 *    all come back as a `Response` with `status: null` and an `error`, because
 *    "we could not look" and "it is not there" are different claims and the
 *    observations layer has to be able to tell them apart.
 *  - **The body is capped while it streams.** A probe that reads a 200 MB
 *    response to count JSON-LD blocks is a probe that hangs a run.
 *    `MAX_BODY_BYTES` is above any plausible HTML document and far below
 *    anything that hurts, and the read stops there instead of buffering first.
 *  - **Redirects are walked by hand.** Every `Location` is chosen by the site
 *    being scanned, so each hop passes the address policy before it is fetched.
 */
import { PROGRAM_NAME, VERSION } from '../../version.ts';
import { refusalFor } from '../net/address-guard.ts';
import { readBodyCapped } from '../net/body.ts';

/** Identifies the probe to the site being measured. A scan should be attributable. */
export const USER_AGENT = `${PROGRAM_NAME}/${VERSION} (+agent-readiness probe)`;

/** Per-request budget. The AGENT probe issues a handful of small GETs. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * ~2 MB. Enough for any HTML page worth analysing. Applied while the body
 * streams, so it bounds memory and not just what reaches the analyser.
 */
export const MAX_BODY_BYTES = 2_000_000;

/** Redirects followed by hand, so every hop can be checked. Five is what browsers allow before giving up. */
const MAX_REDIRECTS = 5;

export type HttpResponse = {
  readonly url: string;
  /** `null` when the request never produced one: DNS, TLS, timeout, reset. */
  readonly status: number | null;
  readonly contentType: string | undefined;
  readonly body: string;
  /** Set only when the request failed to complete. */
  readonly error: string | undefined;
};

export type Fetcher = (url: string) => Promise<HttpResponse>;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** True when the response carries a body we are willing to interpret. */
export function isPresent(response: HttpResponse): boolean {
  return response.status === 200 && response.body.trim().length > 0;
}

/**
 * Many servers answer an unknown path with `200` and the site's HTML shell.
 * Treating that as "the file exists" is the single easiest way for this axis to
 * lie, so a text resource that arrives as HTML is read as a soft 404.
 */
export function isSoftHtml(response: HttpResponse): boolean {
  const type = response.contentType?.toLowerCase() ?? '';
  return (
    type.includes('text/html') ||
    response.body.trimStart().toLowerCase().startsWith('<!doctype html')
  );
}

export type HttpFetcherOptions = {
  readonly timeoutMs?: number;
  /**
   * The hostname the operator pointed the scan at. Redirects may lead anywhere
   * public, and back to this host even when it is private; never to another
   * private, loopback or link-local address.
   */
  readonly scanHost?: string | undefined;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
};

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Follows redirects by hand rather than with `redirect: 'follow'`: the runtime
 * would otherwise walk to whatever `Location` the site names before this code
 * ever saw it, and the address policy has to run on every hop.
 */
async function follow(
  url: string,
  options: Required<Pick<HttpFetcherOptions, 'timeoutMs' | 'fetchImpl'>> &
    Pick<HttpFetcherOptions, 'scanHost'>,
): Promise<Response> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = refusalFor(current, { scanHost: options.scanHost });

    if (refusal !== undefined) {
      throw new Error(refusal);
    }

    const response = await options.fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });

    const location = response.headers.get('location');

    if (!isRedirect(response.status) || location === null || location === '') {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current).toString();
  }

  throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
}

export function httpFetcher(options: HttpFetcherOptions = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (url: string): Promise<HttpResponse> => {
    try {
      const response = await follow(url, { timeoutMs, fetchImpl, scanHost: options.scanHost });
      const { body } = await readBodyCapped(response, MAX_BODY_BYTES);

      return {
        url,
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        body,
        error: undefined,
      };
    } catch (cause) {
      return {
        url,
        status: null,
        contentType: undefined,
        body: '',
        error: messageOf(cause),
      };
    }
  };
}

/** Resolves a site-root path (`/llms.txt`) against the scanned URL. */
export function resolveFromRoot(base: string, path: string): string {
  return new URL(path, new URL(base).origin).toString();
}
