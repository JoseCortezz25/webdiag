/**
 * What the collector hands to everything downstream.
 *
 * A `JsAsset` is a bundle the page actually served, saved to a temp directory so
 * an external tool can read it from disk. It deliberately keeps both identities:
 * the `url` is what a reader has to go look at, and the `path` is what retire.js
 * scans. Losing either one breaks a different half of the probe — the evidence,
 * or the scan.
 */
import type { ToolVersion } from '../raw.ts';

export type JsAsset = {
  /** Absolute URL the browser fetched it from. */
  readonly url: string;
  /** Absolute path inside the run's temp directory. Gone once the probe ends. */
  readonly path: string;
  /** Basename on disk. Kept so a retire.js result can be matched back to a URL. */
  readonly file: string;
  readonly bytes: number;
  readonly status: number | undefined;
  /** Served by an origin other than the page's. A CDN copy is still a dependency. */
  readonly thirdParty: boolean;
};

export type SkipReason = 'too-large' | 'budget-exhausted' | 'empty' | 'unreadable';

/** A script the probe saw but did not scan. Reported, never silently dropped. */
export type SkippedAsset = {
  readonly url: string;
  readonly reason: SkipReason;
  readonly detail: string;
};

export type AssetCollection = {
  readonly directory: string;
  readonly assets: readonly JsAsset[];
  readonly skipped: readonly SkippedAsset[];
  readonly browser: ToolVersion;
  /** Where the browser ended up: a redirect makes this differ from the request. */
  readonly pageUrl: string;
  readonly pageOrigin: string;
  readonly navigationTimedOut: boolean;
};

/**
 * How an asset is named in `affected`.
 *
 * Same-origin bundles show as a path, because that is how the reader thinks
 * about their own site. Third-party ones keep the whole URL: `/ajax/libs/...`
 * with no host would send someone looking for a file they do not serve.
 */
export function displayPath(url: string, pageOrigin: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === pageOrigin ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}
