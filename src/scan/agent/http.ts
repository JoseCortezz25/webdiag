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
 *  - **The body is capped.** A probe that reads a 200 MB response to count
 *    JSON-LD blocks is a probe that hangs a run. `MAX_BODY_CHARS` is above any
 *    plausible HTML document and far below anything that hurts.
 */
import { PROGRAM_NAME, VERSION } from '../../version.ts';

/** Identifies the probe to the site being measured. A scan should be attributable. */
export const USER_AGENT = `${PROGRAM_NAME}/${VERSION} (+agent-readiness probe)`;

/** Per-request budget. The AGENT probe issues a handful of small GETs. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** ~2 MB of text. Enough for any HTML page worth analysing. */
export const MAX_BODY_CHARS = 2_000_000;

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

export function httpFetcher(timeoutMs: number = DEFAULT_TIMEOUT_MS): Fetcher {
  return async (url: string): Promise<HttpResponse> => {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      });

      const body = await response.text();

      return {
        url,
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        body: body.slice(0, MAX_BODY_CHARS),
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
