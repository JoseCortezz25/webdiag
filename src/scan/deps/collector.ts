/**
 * The only part of the DEPS probe that launches a browser.
 *
 * The ticket says "bundles JS publicos servidos por la pagina", and that word —
 * *served* — is why this is a browser and not an HTML parse. A modern site
 * ships a small entry script and pulls its real dependencies in later: lazy
 * chunks, a CDN copy of jQuery injected by a tag manager, a vendor bundle
 * behind an import(). Reading `<script src>` out of the initial HTML would scan
 * the one file that never contains the vulnerable library.
 *
 * Everything downstream is pure and reads from a temp directory, so this module
 * is also the seam: `probe.test.ts` drives the rest of the probe from bundles on
 * disk without ever starting Chrome.
 */
import { basename } from 'node:path';
import puppeteer, { type HTTPResponse, TimeoutError } from 'puppeteer';
import type { ProbeContext } from '../probe.ts';
import type { ToolVersion } from '../raw.ts';
import type { AssetCollection, JsAsset, SkippedAsset } from './assets.ts';
import type { Workspace } from './workspace.ts';

/** `quick` budgets ~40-60s per axis (spec §5.2); navigation gets half of it. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * How long to keep listening after the page settles. Deferred chunks and
 * tag-manager injections routinely land after `networkidle2`, and they are
 * exactly the ones worth scanning.
 */
const SETTLE_MS = 2_000;

const VIEWPORT = { width: 1366, height: 768, deviceScaleFactor: 1 } as const;

/**
 * Budgets. A diagnostic must not become a mirror of the site it is diagnosing:
 * without a cap, one page with a 200 MB source-mapped bundle would fill the
 * disk and time out retire.js. Anything refused is reported as `skipped`.
 */
export const LIMITS = {
  maxAssets: 60,
  maxAssetBytes: 8 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
} as const;

/**
 * Chrome's sandbox stays on by default, because this probe loads whatever a
 * client site serves and that is untrusted code. Containers that cannot create
 * the user namespace it needs opt out explicitly, never by silent fallback.
 */
function launchArgs(): readonly string[] {
  return process.env.WEBDIAG_CHROME_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-dev-shm-usage']
    : [];
}

function isJavaScript(response: HTTPResponse): boolean {
  const url = response.url();

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }

  if (response.request().resourceType() === 'script') {
    return true;
  }

  const type = response.headers()['content-type'] ?? '';
  return /javascript|ecmascript/i.test(type);
}

/**
 * A disk name that is unique, safe, and ends in `.js`.
 *
 * The extension is load-bearing rather than cosmetic: retire.js only scans
 * files it recognises as JavaScript, and plenty of real bundles are served from
 * URLs with no extension at all (`/_next/static/chunks/framework`).
 */
export function diskName(url: string, index: number): string {
  let candidate = 'asset';

  try {
    candidate = basename(new URL(url).pathname) || 'asset';
  } catch {
    candidate = 'asset';
  }

  const safe = candidate.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.js$/i, '');
  return `${String(index).padStart(3, '0')}-${safe.slice(0, 60) || 'asset'}.js`;
}

type PendingAsset = {
  readonly url: string;
  readonly status: number;
  readonly body: Promise<string | undefined>;
};

function isTimeout(cause: unknown): boolean {
  return cause instanceof TimeoutError;
}

/** `Chrome/152.0.7977.75` → `152.0.7977.75`. Falls back to the raw string. */
async function browserVersion(browser: { version(): Promise<string> }): Promise<string> {
  const raw = await browser.version();
  return raw.split('/')[1] ?? raw;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Writes the collected bodies to `workspace`, applying the budgets in a fixed
 * order so two runs over the same page produce the same directory.
 */
async function materialize(
  pending: readonly PendingAsset[],
  workspace: Workspace,
  pageOrigin: string,
): Promise<{ assets: readonly JsAsset[]; skipped: readonly SkippedAsset[] }> {
  const assets: JsAsset[] = [];
  const skipped: SkippedAsset[] = [];
  let total = 0;

  const ordered = [...pending].sort((left, right) => (left.url < right.url ? -1 : 1));

  for (const [index, entry] of ordered.entries()) {
    const body = await entry.body;

    if (body === undefined) {
      skipped.push({
        url: entry.url,
        reason: 'unreadable',
        detail: 'The browser could not hand back the response body.',
      });
      continue;
    }

    const bytes = Buffer.byteLength(body, 'utf8');

    if (bytes === 0) {
      skipped.push({ url: entry.url, reason: 'empty', detail: 'The response body was empty.' });
      continue;
    }

    if (bytes > LIMITS.maxAssetBytes) {
      skipped.push({
        url: entry.url,
        reason: 'too-large',
        detail: `${bytes} bytes exceeds the ${LIMITS.maxAssetBytes} byte per-asset budget.`,
      });
      continue;
    }

    if (assets.length >= LIMITS.maxAssets || total + bytes > LIMITS.maxTotalBytes) {
      skipped.push({
        url: entry.url,
        reason: 'budget-exhausted',
        detail: `The run already scanned ${assets.length} bundles (${total} bytes).`,
      });
      continue;
    }

    const file = diskName(entry.url, index);
    const path = `${workspace.directory}/${file}`;
    await Bun.write(path, body);
    total += bytes;

    assets.push({
      url: entry.url,
      path,
      file,
      bytes,
      status: entry.status,
      thirdParty: originOf(entry.url) !== pageOrigin,
    });
  }

  return { assets, skipped };
}

/** Loads the page and saves every JavaScript response it served. */
export async function collectServedScripts(
  context: ProbeContext,
  workspace: Workspace,
): Promise<AssetCollection> {
  const browser = await puppeteer.launch({ headless: true, args: [...launchArgs()] });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    const seen = new Set<string>();
    const pending: PendingAsset[] = [];

    page.on('response', (response) => {
      const url = response.url();

      if (seen.has(url) || !isJavaScript(response) || !response.ok()) {
        return;
      }

      seen.add(url);
      pending.push({
        url,
        status: response.status(),
        // Requested inside the handler: once the page moves on, the body is
        // no longer retrievable, so waiting until after navigation loses it.
        body: response.text().catch(() => undefined),
      });
    });

    let navigationTimedOut = false;

    try {
      await page.goto(context.url, {
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (cause) {
      if (!isTimeout(cause)) {
        throw cause;
      }
      // A tag that never stops polling must not cost the whole axis: whatever
      // was already served is still a real answer, and the flag says so.
      navigationTimedOut = true;
    }

    await Bun.sleep(SETTLE_MS);

    const pageUrl = page.url();
    const pageOrigin = originOf(pageUrl) || originOf(context.url);
    const { assets, skipped } = await materialize(pending, workspace, pageOrigin);
    const chrome: ToolVersion = { name: 'chrome', version: await browserVersion(browser) };

    return {
      directory: workspace.directory,
      assets,
      skipped,
      browser: chrome,
      pageUrl,
      pageOrigin,
      navigationTimedOut,
    };
  } finally {
    await browser.close();
  }
}
