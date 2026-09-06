import { describe, expect, test } from 'bun:test';
import { diskName, LIMITS } from './collector.ts';

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
