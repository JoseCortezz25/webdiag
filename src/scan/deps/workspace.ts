/**
 * The temp directory the bundles are downloaded into.
 *
 * The ticket asks for a directory "limpiado al finalizar", and the only way to
 * mean that is `finally`: the cleanup has to survive a retire.js crash, a
 * browser that never launched, and a caller that threw halfway through. So the
 * directory is never handed out raw — it is lent to a callback, and this module
 * owns both ends of its life.
 *
 * Cleanup failures are swallowed on purpose. A probe that could not remove a
 * temp directory has still produced a valid diagnostic, and turning that into a
 * failed axis would trade real findings for housekeeping.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORKSPACE_PREFIX = 'webdiag-deps-';

export type Workspace = {
  readonly directory: string;
};

/** Runs `use` with a fresh temp directory and removes it however `use` ends. */
export async function withWorkspace<T>(use: (workspace: Workspace) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));

  try {
    return await use({ directory });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
