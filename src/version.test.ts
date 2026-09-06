import { describe, expect, test } from 'bun:test';
import { PROGRAM_NAME, VERSION } from './version.ts';

describe('VERSION', () => {
  test('matches the version declared in package.json', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
      name: string;
      version: string;
    };

    expect(VERSION).toBe(pkg.version);
  });

  test('matches the binary name published to npm', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
      bin?: Record<string, string>;
    };

    expect(Object.keys(pkg.bin ?? {})).toContain(PROGRAM_NAME);
  });
});
