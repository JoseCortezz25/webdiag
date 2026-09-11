/**
 * The temp directory a browser profile lives in.
 *
 * This exists because of a real incident, not as a precaution. The Performance
 * probe used to launch its browser through `chrome-launcher`, which decided the
 * profile directory from the host's `TEMP` variable. Under WSL that produced a
 * Windows path (`C:\Users\...\AppData\Local\`), and because the process was
 * actually Linux, joining it created a literal `C:\Users\...` directory *in the
 * operator's working directory*, one `lighthouse.<pid>` folder per run, never
 * removed.
 *
 * Puppeteer happens to keep its default profile under `os.tmpdir()` and delete
 * it on `close()`, so migrating to it (PR #36) fixed the symptom. What was
 * missing is the *guarantee*: relying on a third party's undocumented default is
 * how the bug comes back. So the directory is never handed out raw — it is lent
 * to a callback and this module owns both ends of its life, exactly like
 * `withWorkspace` in the DEPS probe. The `finally` is what makes "se elimina al
 * terminar la prueba" true for a success, a throw, and a browser that never
 * launched.
 *
 * Cleanup failures are swallowed on purpose: a run that produced a valid
 * diagnostic but could not remove a temp directory has still produced a valid
 * diagnostic, and an OS temp dir is collected anyway.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const PROFILE_PREFIX = 'webdiag-perf-';

/**
 * The root every profile is created under.
 *
 * `os.tmpdir()` does not read Windows' `TEMP`, so the WSL failure mode cannot
 * recur through it. The guard still matters: a temp root that is not an absolute
 * POSIX path would make `mkdtemp` create the profile *relative to the cwd* —
 * which is the incident — so it is refused and `/tmp` is used instead.
 */
function tempRoot(): string {
  const root = tmpdir();
  return isAbsolute(root) ? root : '/tmp';
}

/** Runs `use` with a fresh browser-profile directory and removes it however `use` ends. */
export async function withBrowserProfile<T>(use: (profileDir: string) => Promise<T>): Promise<T> {
  const profileDir = await mkdtemp(join(tempRoot(), PROFILE_PREFIX));

  try {
    return await use(profileDir);
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
