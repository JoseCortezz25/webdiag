/**
 * Whether the site is publishing its source maps.
 *
 * A published `.map` with `sourcesContent` is the original, unminified source
 * of the application — comments, dead code, internal file names, sometimes
 * keys. The catalogue makes DEPS the owner of `DEPS-SOURCEMAP-EXPOSED` and lets
 * SEC mention it without deducting, which is why it is detected here and not in
 * the security probe.
 *
 * "Exposed" is a fetched fact, never an inferred one. A `sourceMappingURL`
 * comment proves the build emitted a map, not that anyone can download it; and
 * a `200` proves nothing either, because SPA hosting answers `200` with an HTML
 * shell for every unknown path. So a map counts as exposed only when the body
 * that came back actually parses as a source map.
 */
import type { JsAsset } from './assets.ts';

/** How the map was found. Each one is a different statement about the build. */
export type SourcemapKind = 'inline' | 'linked' | 'conventional';

export type SourcemapFinding = {
  /** URL of the bundle that points at the map. */
  readonly asset: string;
  /** URL of the map, or `inline` when it is embedded in the bundle. */
  readonly url: string;
  readonly kind: SourcemapKind;
  readonly status: number | undefined;
  /** How many original files the map names. */
  readonly sources: number;
  /** Whether the original source text itself ships inside the map. */
  readonly sourcesContent: boolean;
  /** Served by an origin other than the page's — see the adapter for why this matters. */
  readonly thirdParty: boolean;
};

/** Enough tail to hold the comment; not enough to re-read a megabyte bundle. */
const TAIL_BYTES = 4_096;

/** One request per bundle for a declared map, plus the conventional guesses. */
const MAX_PROBES = 60;

const FETCH_TIMEOUT_MS = 10_000;

const COMMENT = /[#@]\s*sourceMappingURL\s*=\s*(\S+)/g;

/**
 * The last `sourceMappingURL` in the content, which is the one the browser
 * honours. Concatenated bundles routinely carry several.
 */
export function extractSourceMappingUrl(content: string): string | undefined {
  const tail = content.length > TAIL_BYTES ? content.slice(-TAIL_BYTES) : content;
  const matches = [...tail.matchAll(COMMENT)];
  const last = matches.at(-1)?.[1];

  return last === undefined ? undefined : last.replace(/["'*/]+$/, '');
}

export type SourcemapPayload = {
  readonly sources: number;
  readonly sourcesContent: boolean;
};

/**
 * Reads a body as a source map. Returns `undefined` for anything that is not
 * one, which is what keeps an SPA's catch-all HTML from being reported as a
 * leaked map.
 */
export function readSourcemapPayload(body: string): SourcemapPayload | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const map = parsed as { version?: unknown; sources?: unknown; sourcesContent?: unknown };

  if (map.version !== 3 || !Array.isArray(map.sources)) {
    return undefined;
  }

  return {
    sources: map.sources.length,
    sourcesContent: Array.isArray(map.sourcesContent) && map.sourcesContent.length > 0,
  };
}

function decodeInline(reference: string): string | undefined {
  const match = /^data:application\/json;(?:charset=[^;,]+;)?base64,(.+)$/i.exec(reference);

  if (match?.[1] !== undefined) {
    try {
      return Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  const plain = /^data:application\/json[^,]*,(.*)$/i.exec(reference);
  return plain?.[1] === undefined ? undefined : decodeURIComponent(plain[1]);
}

/** `https://host/app.js?v=3` → `https://host/app.js.map`. */
export function conventionalMapUrl(assetUrl: string): string | undefined {
  try {
    const parsed = new URL(assetUrl);
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.toString()}.map`;
  } catch {
    return undefined;
  }
}

export type Fetcher = (url: string) => Promise<{ status: number; body: string }>;

export const httpFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  return { status: response.status, body: await response.text() };
};

function resolve(reference: string, assetUrl: string): string | undefined {
  try {
    return new URL(reference, assetUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Probes every collected bundle for a reachable source map.
 *
 * When a bundle declares no map, the conventional `<bundle>.js.map` is still
 * tried once: a build that strips the comment but ships the file is the common
 * way this leak survives a "we disabled source maps" fix.
 */
export async function findExposedSourcemaps(
  assets: readonly JsAsset[],
  fetcher: Fetcher = httpFetcher,
): Promise<readonly SourcemapFinding[]> {
  const findings: SourcemapFinding[] = [];
  let probes = 0;

  for (const asset of assets) {
    const content = await Bun.file(asset.path)
      .text()
      .catch(() => '');
    const reference = extractSourceMappingUrl(content);

    if (reference?.startsWith('data:') === true) {
      const payload = readSourcemapPayload(decodeInline(reference) ?? '');

      if (payload !== undefined) {
        findings.push({
          asset: asset.url,
          url: 'inline',
          kind: 'inline',
          status: asset.status,
          thirdParty: asset.thirdParty,
          ...payload,
        });
      }
      continue;
    }

    const candidate =
      reference === undefined
        ? { url: conventionalMapUrl(asset.url), kind: 'conventional' as const }
        : { url: resolve(reference, asset.url), kind: 'linked' as const };

    if (candidate.url === undefined || probes >= MAX_PROBES) {
      continue;
    }

    probes += 1;
    const response = await fetcher(candidate.url).catch(() => undefined);

    if (response === undefined || response.status !== 200) {
      continue;
    }

    const payload = readSourcemapPayload(response.body);

    if (payload !== undefined) {
      findings.push({
        asset: asset.url,
        url: candidate.url,
        kind: candidate.kind,
        status: response.status,
        thirdParty: asset.thirdParty,
        ...payload,
      });
    }
  }

  return findings;
}
