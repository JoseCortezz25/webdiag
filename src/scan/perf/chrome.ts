/**
 * The pinned Chrome.
 *
 * Spec §7 removed Docker from phases 0–2 on the grounds that "el único beneficio
 * real era reproducibilidad, y se cubre con versiones fijadas". This module is
 * that coverage: a Lighthouse number is only comparable against last quarter's
 * number if the browser that produced both is the same browser, and spec §9
 * lists "deriva de versión de Chrome altera métricas" as a live risk whose only
 * mitigation is recording the version.
 *
 * So the build ID below is a constant, not a discovery. We do not use whatever
 * Chrome happens to sit in `/Applications`: that binary auto-updates behind our
 * back, and a silent minor bump is exactly the drift the pin exists to make
 * visible. We resolve the pinned build from the `@puppeteer/browsers` cache,
 * download it once if it is missing, and then ask the binary itself what version
 * it is — because the pin is a request, and only the binary can confirm it.
 *
 * `chrome-headless-shell` rather than full Chrome: full Chrome under
 * `--headless=new` throttles background renderers on macOS and Lighthouse comes
 * back with `NO_FCP` on pages that paint perfectly well. The shell is the build
 * Lighthouse is regression-tested against.
 */
import { homedir } from 'node:os';
import { Browser, computeExecutablePath, install } from '@puppeteer/browsers';
import type { LaunchOptions } from 'puppeteer';

/** Pinned, no range. Bumping it invalidates comparisons against older runs. */
export const PINNED_CHROME_BUILD = '148.0.7778.97';

/** Recorded in `meta.json` as the tool component that produced the metrics. */
export const CHROME_TOOL_NAME = 'chrome-headless-shell';

export type ChromeSource = 'override' | 'cache' | 'download';

export type ResolvedChrome = {
  readonly executablePath: string;
  /** What the binary reports, which is the only version worth recording. */
  readonly version: string;
  readonly buildId: string;
  /** False when an override binary is not the pinned build. Never fatal. */
  readonly pinned: boolean;
  readonly source: ChromeSource;
};

/**
 * The environment variables this module reads. Declared as an index signature so
 * `process.env` satisfies it directly, with the keys named for documentation:
 *
 *  - `WEBDIAG_CHROME_PATH` — escape hatch for CI images that ship a browser.
 *  - `WEBDIAG_CHROME_CACHE_DIR` / `PUPPETEER_CACHE_DIR` — where builds live.
 *  - `WEBDIAG_CHROME_NO_DOWNLOAD` — refuse the one-time download instead of
 *    blocking a run on a 150 MB fetch.
 */
export type ChromeEnvironment = {
  readonly [key: string]: string | undefined;
};

/** `Google Chrome for Testing 148.0.7778.97` → `148.0.7778.97`. */
export function parseChromeVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+\.\d+)/.exec(output)?.[1];
}

export function chromeCacheDir(env: ChromeEnvironment): string {
  return env.WEBDIAG_CHROME_CACHE_DIR ?? env.PUPPETEER_CACHE_DIR ?? `${homedir()}/.cache/puppeteer`;
}

export function pinnedExecutablePath(env: ChromeEnvironment): string {
  return computeExecutablePath({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: PINNED_CHROME_BUILD,
    cacheDir: chromeCacheDir(env),
  });
}

/** `--version` prints one line and exits; a binary that does not is not a browser we can drive. */
const VERSION_TIMEOUT_MS = 15_000;

async function readVersion(executablePath: string): Promise<string> {
  const child = Bun.spawn([executablePath, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: VERSION_TIMEOUT_MS,
  });
  // Both pipes drained: a Chrome that logs warnings to stderr on start would
  // otherwise fill the pipe and never exit.
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`'${executablePath} --version' exited with code ${exitCode}.`);
  }

  const version = parseChromeVersion(stdout);

  if (version === undefined) {
    throw new Error(`Could not read a Chrome version from '${stdout.trim()}'.`);
  }

  return version;
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/**
 * Resolves the browser Lighthouse will drive.
 *
 * Order: explicit override, then the pinned build in the cache, then a one-time
 * download of the pinned build. Anything that goes wrong throws — the probe
 * contract turns that into a failed axis, which is the honest outcome: a
 * Performance score measured by an unknown browser is worse than no score.
 */
export async function resolveChrome(env: ChromeEnvironment = process.env): Promise<ResolvedChrome> {
  const override = env.WEBDIAG_CHROME_PATH;

  if (override !== undefined && override !== '') {
    const version = await readVersion(override);

    return {
      executablePath: override,
      version,
      buildId: PINNED_CHROME_BUILD,
      pinned: version === PINNED_CHROME_BUILD,
      source: 'override',
    };
  }

  const cacheDir = chromeCacheDir(env);
  const cached = pinnedExecutablePath(env);

  if (await exists(cached)) {
    return {
      executablePath: cached,
      version: await readVersion(cached),
      buildId: PINNED_CHROME_BUILD,
      pinned: true,
      source: 'cache',
    };
  }

  if (env.WEBDIAG_CHROME_NO_DOWNLOAD !== undefined && env.WEBDIAG_CHROME_NO_DOWNLOAD !== '') {
    throw new Error(
      `Pinned ${CHROME_TOOL_NAME} ${PINNED_CHROME_BUILD} is not in ${cacheDir} and downloads are disabled.`,
    );
  }

  const installed = await install({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: PINNED_CHROME_BUILD,
    cacheDir,
  });

  return {
    executablePath: installed.executablePath,
    version: await readVersion(installed.executablePath),
    buildId: PINNED_CHROME_BUILD,
    pinned: true,
    source: 'download',
  };
}

let resolvedOnce: Promise<ResolvedChrome> | undefined;

/**
 * `resolveChrome`, once per process.
 *
 * Three probes launch a browser and they start together. Without this, a cold
 * cache would begin three concurrent 150 MB downloads of the same build into the
 * same directory. A failed resolution is not memoised, so a transient error on
 * one probe does not doom the next run in the same process.
 */
export function resolveChromeOnce(env: ChromeEnvironment = process.env): Promise<ResolvedChrome> {
  resolvedOnce ??= resolveChrome(env).catch((cause: unknown) => {
    resolvedOnce = undefined;
    throw cause;
  });

  return resolvedOnce;
}

/**
 * Chrome's sandbox stays on by default, because every browser probe loads
 * whatever a client site serves and that is untrusted code. Containers that
 * cannot create the user namespace it needs opt out explicitly, never by silent
 * fallback on a launch failure.
 */
export function sandboxArgs(env: ChromeEnvironment = process.env): readonly string[] {
  return env.WEBDIAG_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
}

/**
 * The puppeteer launch options every browser probe uses for the pinned binary.
 *
 * `headless: 'shell'` because the binary *is* `chrome-headless-shell`: it does
 * not understand `--headless=new`, which is what `headless: true` would pass.
 * No `--headless` in `args` either, for the same reason — puppeteer adds the
 * one flag the shell expects.
 *
 * `profileDir` is passed as `userDataDir` and is owned by the caller, not by
 * puppeteer: see `withBrowserProfile`, which creates it under the OS temp
 * directory and removes it. Naming it explicitly is the point — it is what keeps
 * the profile from ever landing in the operator's working directory (the
 * `chrome-launcher` incident), instead of depending on a puppeteer default.
 */
export function headlessLaunchOptions(
  chrome: ResolvedChrome,
  args: readonly string[] = [],
  profileDir?: string,
): LaunchOptions & { readonly executablePath: string; readonly headless: 'shell' } {
  return {
    executablePath: chrome.executablePath,
    headless: 'shell',
    args: args.filter((flag) => !flag.startsWith('--headless')),
    ...(profileDir === undefined ? {} : { userDataDir: profileDir }),
  };
}

/** `ws://127.0.0.1:9222/devtools/browser/<id>` → `9222`. What Lighthouse connects to. */
export function debuggingPortOf(wsEndpoint: string): number {
  const port = Number(new URL(wsEndpoint).port);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`The browser endpoint '${wsEndpoint}' carries no debugging port.`);
  }

  return port;
}
