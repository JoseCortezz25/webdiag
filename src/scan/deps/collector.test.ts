import { describe, expect, test } from 'bun:test';
import type { LaunchOptions } from 'puppeteer';
import type { ResolvedChrome } from '../perf/chrome.ts';
import {
  admit,
  type BrowserLauncher,
  collectServedScripts,
  diskName,
  LIMITS,
} from './collector.ts';

describe('diskName', () => {
  test('always ends in .js, because retire.js only scans JavaScript files', () => {
    // Real chunk URLs routinely carry no extension at all.
    expect(diskName('https://x.test/_next/static/chunks/framework', 3)).toBe('003-framework.js');
    expect(diskName('https://x.test/assets/vendor.js', 0)).toBe('000-vendor.js');
  });

  test('keeps two bundles with the same basename apart', () => {
    const first = diskName('https://x.test/a/app.js', 1);
    const second = diskName('https://x.test/b/app.js', 2);

    expect(first).not.toBe(second);
  });

  test('strips anything that could escape the temp directory', () => {
    expect(diskName('https://x.test/../../etc/passwd.js', 0)).toBe('000-passwd.js');
    expect(diskName('https://x.test/a/%2e%2e%2fx.js', 0)).not.toContain('/');
  });

  test('survives a URL it cannot parse', () => {
    expect(diskName('not a url', 7)).toBe('007-asset.js');
  });
});

describe('LIMITS', () => {
  test('caps a single bundle below the whole-run budget', () => {
    expect(LIMITS.maxAssetBytes).toBeLessThan(LIMITS.maxTotalBytes);
    expect(LIMITS.maxAssets).toBeGreaterThan(0);
  });
});

describe('admit', () => {
  const fresh = { admitted: 0, declaredBytes: 0 };

  test('admits a response without a content-length; it is measured after download', () => {
    expect(admit(undefined, fresh)).toBeUndefined();
  });

  test('refuses a declared body over the per-asset budget before reading it', () => {
    // Regression: every JavaScript response used to be read into memory and
    // only then compared against LIMITS, so the budgets bounded the disk, not
    // the run.
    expect(admit(LIMITS.maxAssetBytes + 1, fresh)?.reason).toBe('too-large');
    expect(admit(LIMITS.maxAssetBytes, fresh)).toBeUndefined();
  });

  test('refuses once the asset count is spent, whatever the size', () => {
    const spent = { admitted: LIMITS.maxAssets, declaredBytes: 0 };

    expect(admit(10, spent)?.reason).toBe('budget-exhausted');
    expect(admit(undefined, spent)?.reason).toBe('budget-exhausted');
  });

  test('refuses a declared body that would push the run over its total budget', () => {
    const nearlyFull = { admitted: 1, declaredBytes: LIMITS.maxTotalBytes - 10 };

    expect(admit(11, nearlyFull)?.reason).toBe('budget-exhausted');
    expect(admit(10, nearlyFull)).toBeUndefined();
  });
});

describe('collectServedScripts', () => {
  test('launches the injected pinned binary as the headless shell', async () => {
    // Regression: `puppeteer.launch()` with no executablePath relied on
    // puppeteer's postinstall download, which a consumer install may skip.
    const chrome: ResolvedChrome = {
      executablePath: '/opt/webdiag/chrome-headless-shell',
      version: '148.0.7778.97',
      buildId: '148.0.7778.97',
      pinned: true,
      source: 'cache',
    };
    let launched: LaunchOptions | undefined;
    const launch: BrowserLauncher = (options) => {
      launched = options;
      return Promise.reject(new Error('not launching in a unit test'));
    };

    await expect(
      collectServedScripts(
        { url: 'https://example.com/', mode: 'quick', pages: 1 },
        { directory: '/tmp/never-used' },
        { chrome, launch },
      ),
    ).rejects.toThrow('not launching in a unit test');

    expect(launched?.executablePath).toBe(chrome.executablePath);
    expect(launched?.headless).toBe('shell');
  });
});
