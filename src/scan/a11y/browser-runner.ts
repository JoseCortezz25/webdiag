/**
 * The only part of the A11Y probe that touches Chrome.
 *
 * It is isolated behind `AxeAnalyzer` so everything that decides *what the
 * finding says* — `mapping.ts`, `adapter.ts` — stays testable from a fixture. A
 * unit test that needed a browser would be run once and then skipped.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *  - **axe is injected by evaluating its source, not by `addScriptTag`.** A
 *    `<script>` element is subject to the page's CSP, and a strict CSP is
 *    exactly the kind of thing a client site has. `page.evaluate` runs in the
 *    main world outside that check, which is also what `@axe-core/puppeteer`
 *    does.
 *  - **A navigation that outruns its budget is not a failure.** A third-party
 *    tag that never stops polling would otherwise cost us the whole axis. If
 *    something rendered, axe reads it, and the run is flagged in the evidence as
 *    `navigation_timed_out` so the reader knows the page may be incomplete. A
 *    navigation that genuinely failed (DNS, refused, TLS) still throws, and
 *    `runProbe` degrades the axis honestly.
 */
import { createRequire } from 'node:module';
import puppeteer, { type Browser, type LaunchOptions, TimeoutError } from 'puppeteer';
// The PERF module owns the Chrome pin; every browser probe launches that same
// binary so `meta.json` records one browser, not three.
import {
  CHROME_TOOL_NAME,
  headlessLaunchOptions,
  type ResolvedChrome,
  resolveChromeOnce,
  sandboxArgs,
} from '../perf/chrome.ts';
import type { ProbeContext } from '../probe.ts';
import type { ToolVersion } from '../raw.ts';
import type { AxeAnalysis } from './adapter.ts';
import { parseAxeReport } from './axe.ts';

const require = createRequire(import.meta.url);

const axePackage = require('axe-core/package.json') as { readonly version: string };

/** The pinned axe-core, read from the installed package so it cannot drift. */
export const AXE_VERSION: string = axePackage.version;

/** `quick` budgets ~40–60s per axis (spec §5.2); navigation gets half of it. */
const NAVIGATION_TIMEOUT_MS = 30_000;
const AXE_TIMEOUT_MS = 60_000;

/** Fixed so two runs of the same page see the same layout, and so does a diff. */
const VIEWPORT = { width: 1366, height: 768, deviceScaleFactor: 1 } as const;

/**
 * `resultTypes` keeps the node detail of the two result sets we actually read.
 * `passes` and `inapplicable` still arrive as full rule lists, which is all the
 * manual-review evidence needs, without shipping a DOM dump per passing rule.
 */
const AXE_OPTIONS = { resultTypes: ['violations', 'incomplete'] } as const;

export type BrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

export type BrowserRunnerOptions = {
  /** Injected in tests; production resolves the pinned build once per process. */
  readonly chrome?: ResolvedChrome;
  /** Injected in tests to assert what would be launched without launching it. */
  readonly launch?: BrowserLauncher;
};

let cachedAxeSource: string | undefined;

/** Read once per process: the file is ~600 KB and never changes mid-run. */
async function axeSource(): Promise<string> {
  cachedAxeSource ??= await Bun.file(require.resolve('axe-core')).text();
  return cachedAxeSource;
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof TimeoutError;
}

/**
 * Runs axe-core against the rendered page and reports what rendered it.
 *
 * The browser is the pinned `chrome-headless-shell`, resolved (and downloaded
 * once if needed) by the PERF module — never puppeteer's own postinstall
 * download, which a consumer install may legitimately have skipped.
 */
export async function analyzeWithBrowser(
  context: ProbeContext,
  options: BrowserRunnerOptions = {},
): Promise<AxeAnalysis> {
  const chrome = options.chrome ?? (await resolveChromeOnce());
  const launch = options.launch ?? ((launchOptions) => puppeteer.launch(launchOptions));
  const browser = await launch(headlessLaunchOptions(chrome, sandboxArgs()));

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.setBypassCSP(true);
    page.setDefaultTimeout(AXE_TIMEOUT_MS);

    let navigationTimedOut = false;
    let httpStatus: number | undefined;

    try {
      const response = await page.goto(context.url, {
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      httpStatus = response?.status();
    } catch (cause) {
      if (!isTimeout(cause)) {
        throw cause;
      }
      navigationTimedOut = true;
    }

    await page.evaluate(`${await axeSource()}\n;undefined;`);

    const injected = await page.evaluate(
      'typeof axe === "object" && typeof axe.run === "function"',
    );

    if (injected !== true) {
      throw new Error(
        'axe-core did not load in the page; the document may have blocked scripting.',
      );
    }

    const report = parseAxeReport(
      await page.evaluate(`axe.run(document, ${JSON.stringify(AXE_OPTIONS)})`),
    );

    // The version the binary itself reported when it was resolved: the pin is a
    // request, and only the binary can confirm what actually rendered the page.
    const browserTool: ToolVersion = { name: CHROME_TOOL_NAME, version: chrome.version };

    return {
      report,
      browser: browserTool,
      pageUrl: page.url(),
      httpStatus,
      navigationTimedOut,
    };
  } finally {
    await browser.close();
  }
}
