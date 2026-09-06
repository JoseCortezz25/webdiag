/**
 * Single source of truth for the version reported by the CLI at runtime.
 *
 * It is duplicated from `package.json` on purpose: the bundled binary must not
 * depend on `package.json` being present next to it. `version.test.ts` fails the
 * build if the two ever drift apart.
 */
export const VERSION = '0.1.2';

export const PROGRAM_NAME = 'webdiag';
