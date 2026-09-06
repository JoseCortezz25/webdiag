/**
 * Driving Lighthouse.
 *
 * Every setting here is stated rather than defaulted. Lighthouse's defaults are
 * good, but they are also free to change between minor versions, and a run whose
 * throttling changed silently produces a score that looks like a regression the
 * client did not cause. Spec §7 asks for reproducibility "por versiones
 * pineadas"; pinning the binary is only half of it, the configuration is the
 * other half.
 *
 * The browser is launched here and killed in a `finally`, so a Lighthouse throw
 * cannot leak a Chrome process into the machine running the diagnostic.
 */
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { type ResolvedChrome, resolveChrome } from './chrome.ts';
import type { LighthouseReport } from './lhr.ts';

/** Pinned, no range. `chrome.test.ts` fails when the lockfile drifts from it. */
export const PINNED_LIGHTHOUSE_VERSION = '13.4.1';

/**
 * Flags chosen for a headless server, not for a desktop. `--no-sandbox` is here
 * because CI containers run as root and Chrome refuses to start otherwise; the
 * pages we open are the client's own public site.
 */
const CHROME_FLAGS: readonly string[] = [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

/**
 * Mobile, simulated throttling: the configuration Core Web Vitals thresholds are
 * defined against. Measuring desktop and comparing against a mobile threshold is
 * the most common way to produce a flattering, meaningless number.
 */
const SETTINGS = {
  formFactor: 'mobile',
  throttlingMethod: 'simulate',
  locale: 'en-US',
  disableStorageReset: false,
  maxWaitForFcp: 30_000,
  maxWaitForLoad: 45_000,
} as const;

/** Only Performance: the other five axes have (or will have) their own probes. */
const CATEGORIES: readonly string[] = ['performance'];

export type LighthouseRun = {
  readonly report: LighthouseReport;
  readonly chrome: ResolvedChrome;
};

export type LighthouseOptions = {
  /** Injected in tests; production resolves the pinned build. */
  readonly chrome?: ResolvedChrome;
};

export async function runLighthouse(
  url: string,
  options: LighthouseOptions = {},
): Promise<LighthouseRun> {
  const chrome = options.chrome ?? (await resolveChrome());

  const browser = await launch({
    chromePath: chrome.executablePath,
    chromeFlags: [...CHROME_FLAGS],
  });

  try {
    const run = await lighthouse(url, {
      port: browser.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: [...CATEGORIES],
      ...SETTINGS,
    });

    if (run === undefined) {
      throw new Error('Lighthouse returned no result.');
    }

    const report = run.lhr as unknown as LighthouseReport;

    // A page that never painted yields a report full of errored audits. Reading
    // it would mean inventing findings out of missing data; failing the probe
    // marks the axis as unmeasured, which is what actually happened.
    if (report.runtimeError !== undefined) {
      throw new Error(`Lighthouse could not load the page: ${report.runtimeError.message}`);
    }

    return { report, chrome };
  } finally {
    await browser.kill();
  }
}
