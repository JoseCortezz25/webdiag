/**
 * The flat files an agent looks for before it starts guessing: `/llms.txt` and
 * the `/.well-known/` endpoints.
 *
 * Each probe answers with one of three states, and keeping them distinct is the
 * whole point of the module:
 *
 *  - `present` — 200, non-empty, and not the site's HTML shell.
 *  - `absent`  — the server answered and the file is not there.
 *  - `unknown` — the request never completed, so we did not look.
 *
 * `unknown` exists because "we could not reach the host" and "the file is
 * missing" are different claims, and the second one is the only one this axis is
 * entitled to make from a completed request.
 */
import { type Fetcher, type HttpResponse, isPresent, isSoftHtml, resolveFromRoot } from './http.ts';

/** Paths an agent-aware site publishes. Provisional: no registry covers all three. */
export const WELL_KNOWN_PATHS: readonly string[] = [
  '/.well-known/security.txt',
  '/.well-known/ai-plugin.json',
  '/.well-known/ai.txt',
];

export const LLMS_TXT_PATH = '/llms.txt';

export type ResourceState = 'present' | 'absent' | 'unknown';

export type ResourceProbe = {
  readonly path: string;
  readonly state: ResourceState;
  readonly status: number | null;
  readonly contentType: string | undefined;
  /** Why the state is what it is, in one phrase, for `evidence`. */
  readonly detail: string | undefined;
};

function classify(path: string, response: HttpResponse): ResourceProbe {
  const base = {
    path,
    status: response.status,
    contentType: response.contentType,
  };

  if (response.status === null) {
    return { ...base, state: 'unknown', detail: response.error ?? 'la peticion no completo' };
  }

  if (isPresent(response) && !isSoftHtml(response)) {
    return { ...base, state: 'present', detail: undefined };
  }

  if (response.status === 200 && isSoftHtml(response)) {
    return { ...base, state: 'absent', detail: 'respondio 200 con HTML: 404 encubierto' };
  }

  if (response.status === 200) {
    return { ...base, state: 'absent', detail: 'respondio 200 con cuerpo vacio' };
  }

  return { ...base, state: 'absent', detail: `respondio ${response.status}` };
}

export async function probeResource(
  fetcher: Fetcher,
  url: string,
  path: string,
): Promise<ResourceProbe> {
  return classify(path, await fetcher(resolveFromRoot(url, path)));
}

export function probeResources(
  fetcher: Fetcher,
  url: string,
  paths: readonly string[],
): Promise<readonly ResourceProbe[]> {
  return Promise.all(paths.map((path) => probeResource(fetcher, url, path)));
}
