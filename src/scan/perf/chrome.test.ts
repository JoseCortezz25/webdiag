import { describe, expect, test } from 'bun:test';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  CHROME_TOOL_NAME,
  chromeCacheDir,
  PINNED_CHROME_BUILD,
  parseChromeVersion,
  pinnedExecutablePath,
} from './chrome.ts';
import { PINNED_LIGHTHOUSE_VERSION } from './lighthouse.ts';

describe('the pin', () => {
  test('the declared Lighthouse version is the installed one', async () => {
    const installed = await Bun.file(
      new URL('../../../node_modules/lighthouse/package.json', import.meta.url).pathname,
    ).json();

    expect(installed.version).toBe(PINNED_LIGHTHOUSE_VERSION);
  });

  test('the dependency is exact, because a range is not a pin', () => {
    // Spec §7: "reproducibilidad por versiones pineadas (sin `^`)".
    const dependencies = packageJson.dependencies as Record<string, string>;

    expect(dependencies.lighthouse).toBe(PINNED_LIGHTHOUSE_VERSION);
    expect(dependencies.lighthouse).not.toContain('^');
    expect(dependencies['@puppeteer/browsers']).not.toContain('^');
    // Declared even though Lighthouse pulls it in: `lighthouse.ts` imports it
    // directly, and a package we import is a package we own the version of.
    expect(dependencies['chrome-launcher']).not.toContain('^');
  });

  test('the Chrome build is a full four-part version', () => {
    expect(PINNED_CHROME_BUILD).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('parseChromeVersion', () => {
  test('reads the version the binary prints', () => {
    expect(parseChromeVersion('Google Chrome for Testing 148.0.7778.97\n')).toBe('148.0.7778.97');
  });

  test('returns nothing when the output is not a version', () => {
    expect(parseChromeVersion('command not found')).toBeUndefined();
  });
});

describe('chromeCacheDir', () => {
  test('prefers the webdiag override over the puppeteer one', () => {
    expect(chromeCacheDir({ WEBDIAG_CHROME_CACHE_DIR: '/a', PUPPETEER_CACHE_DIR: '/b' })).toBe(
      '/a',
    );
  });

  test('falls back to the puppeteer cache, then to the home directory', () => {
    expect(chromeCacheDir({ PUPPETEER_CACHE_DIR: '/b' })).toBe('/b');
    expect(chromeCacheDir({})).toContain('.cache/puppeteer');
  });
});

describe('pinnedExecutablePath', () => {
  test('points inside the cache, at the pinned build', () => {
    const path = pinnedExecutablePath({ WEBDIAG_CHROME_CACHE_DIR: '/cache' });

    expect(path.startsWith('/cache/')).toBe(true);
    expect(path).toContain(PINNED_CHROME_BUILD);
    expect(path).toContain(CHROME_TOOL_NAME);
  });
});
