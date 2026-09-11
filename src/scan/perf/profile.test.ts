import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PROFILE_PREFIX, withBrowserProfile } from './profile.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('withBrowserProfile', () => {
  test('lends an absolute directory under the OS temp dir, with the webdiag prefix', async () => {
    let profileDir: string | undefined;

    await withBrowserProfile(async (dir) => {
      profileDir = dir;
      expect(isAbsolute(dir)).toBe(true);
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(dir.includes(PROFILE_PREFIX)).toBe(true);
      expect(await exists(dir)).toBe(true);
    });

    expect(await exists(profileDir as string)).toBe(false);
  });

  test('removes the directory when the run throws', async () => {
    let profileDir: string | undefined;

    await expect(
      withBrowserProfile(async (dir) => {
        profileDir = dir;
        throw new Error('browser never started');
      }),
    ).rejects.toThrow('browser never started');

    expect(await exists(profileDir as string)).toBe(false);
  });

  test('gives each run its own directory', async () => {
    const seen: string[] = [];

    await withBrowserProfile(async (dir) => {
      seen.push(dir);
    });
    await withBrowserProfile(async (dir) => {
      seen.push(dir);
    });

    expect(seen[0]).not.toBe(seen[1]);
  });

  /**
   * The incident: a browser profile written into the operator's working
   * directory. This asserts the promise directly, with the cwd moved to a
   * throwaway directory so a regression cannot hide behind a clean checkout.
   */
  test('never writes anything into the current working directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'webdiag-cwd-'));
    const previous = process.cwd();
    process.chdir(cwd);

    try {
      await withBrowserProfile(async (dir) => {
        expect(dir.startsWith(cwd)).toBe(false);
      });

      expect(await readdir(cwd)).toEqual([]);
    } finally {
      process.chdir(previous);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
