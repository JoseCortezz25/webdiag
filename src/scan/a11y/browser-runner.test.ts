/**
 * The launch seam. A real browser is exercised in `probe.test.ts`; this file
 * asserts *which* browser would be launched, without launching one.
 */
import { describe, expect, test } from 'bun:test';
import type { LaunchOptions } from 'puppeteer';
import type { ResolvedChrome } from '../perf/chrome.ts';
import { analyzeWithBrowser, type BrowserLauncher } from './browser-runner.ts';

const CHROME: ResolvedChrome = {
  executablePath: '/opt/webdiag/chrome-headless-shell',
  version: '148.0.7778.97',
  buildId: '148.0.7778.97',
  pinned: true,
  source: 'cache',
};

describe('analyzeWithBrowser', () => {
  test('launches the injected pinned binary as the headless shell', async () => {
    // Regression: the probe used to call `puppeteer.launch()` with no
    // executablePath, which relies on puppeteer's postinstall download — a
    // step bun skips for untrusted transitive dependencies on a consumer
    // install, so A11Y failed with "Could not find Chrome" while PERF worked.
    let launched: LaunchOptions | undefined;
    const launch: BrowserLauncher = (options) => {
      launched = options;
      return Promise.reject(new Error('not launching in a unit test'));
    };

    await expect(
      analyzeWithBrowser(
        { url: 'https://example.com/', mode: 'quick', pages: 1 },
        {
          chrome: CHROME,
          launch,
        },
      ),
    ).rejects.toThrow('not launching in a unit test');

    expect(launched?.executablePath).toBe(CHROME.executablePath);
    expect(launched?.headless).toBe('shell');
    expect(launched?.args?.some((flag) => flag.startsWith('--headless'))).toBe(false);
  });
});
