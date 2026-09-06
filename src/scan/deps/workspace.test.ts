import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { WORKSPACE_PREFIX, withWorkspace } from './workspace.ts';

describe('withWorkspace', () => {
  test('lends a real, empty directory', async () => {
    const seen = await withWorkspace(async (workspace) => {
      await Bun.write(`${workspace.directory}/vendor.js`, 'window.x=1');

      expect(existsSync(workspace.directory)).toBe(true);
      expect(workspace.directory).toContain(WORKSPACE_PREFIX);

      return workspace.directory;
    });

    expect(existsSync(seen)).toBe(false);
  });

  test('removes the directory even when the work throws', async () => {
    let directory = '';

    const failing = withWorkspace((workspace) => {
      directory = workspace.directory;
      return Promise.reject(new Error('retire.js exited with 1'));
    });

    await expect(failing).rejects.toThrow('retire.js exited with 1');
    expect(existsSync(directory)).toBe(false);
  });

  test('two runs never share a directory', async () => {
    const [first, second] = await Promise.all([
      withWorkspace((workspace) => Promise.resolve(workspace.directory)),
      withWorkspace((workspace) => Promise.resolve(workspace.directory)),
    ]);

    expect(first).not.toBe(second);
  });
});
