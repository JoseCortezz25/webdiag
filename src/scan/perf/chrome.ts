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

async function readVersion(executablePath: string): Promise<string> {
  const child = Bun.spawn([executablePath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

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
