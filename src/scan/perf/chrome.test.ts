import { describe, expect, test } from 'bun:test';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  CHROME_TOOL_NAME,
  chromeCacheDir,
  debuggingPortOf,
  headlessLaunchOptions,
  PINNED_CHROME_BUILD,
  parseChromeVersion,
  pinnedExecutablePath,
  type ResolvedChrome,
  sandboxArgs,
} from './chrome.ts';
import { LIGHTHOUSE_CHROME_FLAGS, PINNED_LIGHTHOUSE_VERSION } from './lighthouse.ts';

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
    expect(dependencies.puppeteer).not.toContain('^');
    // Not a dependency any more: under WSL it guessed a Windows temp path and
    // created a literal `C:\Users\...` directory in the operator's cwd. Every
    // browser probe launches through puppeteer instead.
    expect(dependencies['chrome-launcher']).toBeUndefined();
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

const RESOLVED: ResolvedChrome = {
  executablePath: '/opt/chrome/chrome-headless-shell',
  version: PINNED_CHROME_BUILD,
  buildId: PINNED_CHROME_BUILD,
  pinned: true,
  source: 'cache',
};

describe('headlessLaunchOptions', () => {
  test('launches the resolved binary as the headless shell it is', () => {
    const options = headlessLaunchOptions(RESOLVED, ['--no-sandbox']);

    expect(options.executablePath).toBe(RESOLVED.executablePath);
    // The pinned binary is chrome-headless-shell; `--headless=new` (what
    // `headless: true` sends) is not something it understands.
    expect(options.headless).toBe('shell');
    expect(options.args).toEqual(['--no-sandbox']);
  });

  test('never forwards a --headless flag of its own', () => {
    const options = headlessLaunchOptions(RESOLVED, [
      '--headless',
      '--headless=new',
      '--disable-gpu',
    ]);

    expect(options.args).toEqual(['--disable-gpu']);
  });

  test('the Lighthouse flag set carries no --headless either', () => {
    expect(LIGHTHOUSE_CHROME_FLAGS.some((flag) => flag.startsWith('--headless'))).toBe(false);
  });
});

describe('sandboxArgs', () => {
  test('keeps the sandbox on unless explicitly opted out', () => {
    expect(sandboxArgs({})).toEqual([]);
    expect(sandboxArgs({ WEBDIAG_CHROME_NO_SANDBOX: '0' })).toEqual([]);
    expect(sandboxArgs({ WEBDIAG_CHROME_NO_SANDBOX: '1' })).toEqual([
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ]);
  });
});

describe('debuggingPortOf', () => {
  test('reads the port Lighthouse must connect to from the browser endpoint', () => {
    expect(debuggingPortOf('ws://127.0.0.1:9222/devtools/browser/0b6a-4f')).toBe(9222);
  });

  test('refuses an endpoint with no port instead of handing Lighthouse NaN', () => {
    expect(() => debuggingPortOf('ws://127.0.0.1/devtools/browser/x')).toThrow(/debugging port/);
  });
});
