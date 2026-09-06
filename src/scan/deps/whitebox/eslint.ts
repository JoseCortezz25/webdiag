/**
 * ESLint over the client's own code (spec §8, Fase 3: "osv-scanner, SBOM con
 * Syft, deps deprecadas, ESLint").
 *
 * Two decisions shape this file, and both follow from one fact: **this must run
 * the project's own ESLint, with the project's own configuration and plugins,
 * never this CLI's opinion of good code.** A diagnostic tool that graded a
 * client's code against a style it never adopted would produce noise, not a
 * finding.
 *
 * - **The binary is looked up inside the target repo first**
 *   (`node_modules/.bin/eslint`), before `PATH` is even considered. That is the
 *   one installation guaranteed to be the version and plugin set the project
 *   actually uses.
 * - **It runs with `cwd` set to the repo root** (the same `runCommand` option
 *   `curl.ts` added for exactly this), so a flat config or a plugin resolved
 *   relative to the working directory finds what the project's own `npm
 *   install` put there. Running it from anywhere else would either fail to
 *   resolve the config at all, or silently resolve a different one.
 *
 * A repository with no ESLint installed is a normal outcome, not an error: not
 * every white-box target uses it, and the probe says so and moves on to the
 * checks that do not depend on it.
 */
import { z } from 'zod';
import type { ToolVersion } from '../../raw.ts';
import { type CommandRunner, runCommand } from '../../sec/curl.ts';

export const ESLINT_TOOL_NAME = 'eslint';

/** A cold ESLint run across a real front-end (type-aware rules) is not instant. */
export const ESLINT_TIMEOUT_MS = 180_000;

/** ESLint exits 1 when it found lint problems. That is a result, not a crash. */
const PROBLEMS_FOUND = 1;

const eslintMessageSchema = z.object({
  ruleId: z.string().nullable().default(null),
  /** ESLint's own scale: `1` is a warning, `2` is an error. */
  severity: z.number().default(1),
  message: z.string().default(''),
  line: z.number().default(0),
  column: z.number().default(0),
});

export type EslintMessage = z.infer<typeof eslintMessageSchema>;

const eslintFileResultSchema = z.object({
  filePath: z.string(),
  messages: z.array(eslintMessageSchema).default([]),
  errorCount: z.number().default(0),
  warningCount: z.number().default(0),
});

export type EslintFileResult = z.infer<typeof eslintFileResultSchema>;

const eslintReportSchema = z.array(eslintFileResultSchema);

export type EslintReport = z.infer<typeof eslintReportSchema>;

export function parseEslintReport(input: unknown): EslintReport {
  return eslintReportSchema.parse(input);
}

/** What a run produced, including the case where it could not run at all. */
export type EslintScan = {
  readonly available: boolean;
  readonly version: string | undefined;
  readonly results: EslintReport;
  /** Why it could not run, or what it complained about. Never swallowed. */
  readonly errors: readonly string[];
};

export const UNAVAILABLE_ESLINT: EslintScan = {
  available: false,
  version: undefined,
  results: [],
  errors: [],
};

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/**
 * Where ESLint is, for this repo specifically.
 *
 * Order: an explicit override, then the copy the target project itself
 * installed (`node_modules/.bin/eslint`, resolved against `root` — the repo
 * under analysis, never this CLI's own checkout), then whatever is on `PATH`.
 * `undefined` is a normal answer and degrades the probe.
 */
export async function locateEslint(root: string): Promise<string | undefined> {
  const override = Bun.env.WEBDIAG_ESLINT;

  if (override !== undefined && override !== '' && (await exists(override))) {
    return override;
  }

  const local = `${root}/node_modules/.bin/eslint`;

  if (await exists(local)) {
    return local;
  }

  const onPath = Bun.which('eslint');

  return onPath ?? undefined;
}

/** `v8.57.0` becomes `8.57.0`. Recorded in `meta.json`. */
export async function eslintVersion(
  path: string,
  runner: CommandRunner = runCommand,
): Promise<string | undefined> {
  try {
    const result = await runner([path, '--version'], { timeoutMs: 30_000 });
    return /v?(\d\S*)/.exec(result.stdout.trim())?.[1];
  } catch {
    return undefined;
  }
}

export type EslintRun = {
  readonly path: string;
  /** The repo root. Passed as `cwd`, never appended to the argument list. */
  readonly root: string;
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
};

/**
 * Lints the whole checkout with the project's own configuration.
 *
 * `--format json` is asked for unconditionally: it is ESLint's own documented
 * machine-readable contract, parsed through zod for the same reason
 * `osv.ts`/`syft.ts` parse theirs that way — a renamed field must fail loudly
 * here, not quietly produce a DEPS axis with no lint findings in it.
 */
export async function runEslint(options: EslintRun): Promise<EslintScan> {
  const runner = options.runner ?? runCommand;
  const version = await eslintVersion(options.path, runner);

  const result = await runner([options.path, '.', '--format', 'json'], {
    cwd: options.root,
    timeoutMs: options.timeoutMs ?? ESLINT_TIMEOUT_MS,
  });

  if (result.exitCode !== 0 && result.exitCode !== PROBLEMS_FOUND) {
    throw new Error(
      `eslint exited with ${result.exitCode}: ${
        result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? 'no diagnostics'
      }`,
    );
  }

  try {
    return {
      available: true,
      version,
      results: parseEslintReport(JSON.parse(result.stdout)),
      errors: [],
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`eslint produced a report this build cannot read: ${detail}`);
  }
}

/**
 * The scan, or an empty one that says why there is none.
 *
 * Same contract as `osvScanOrDegrade`: ESLint is one more check inside the
 * white-box axis, not the whole of it, and a repo that never installed it
 * loses one finding, not the run.
 */
export async function eslintScanOrDegrade(root: string): Promise<EslintScan> {
  const path = await locateEslint(root);

  if (path === undefined) {
    return {
      ...UNAVAILABLE_ESLINT,
      errors: [
        'ESLint no está instalado en el repositorio analizado (ni en node_modules/.bin ni en PATH): no se evaluó la calidad de código. Agregarlo como devDependency del proyecto analizado, o exponerlo en PATH.',
      ],
    };
  }

  try {
    return await runEslint({ path, root });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    return {
      ...UNAVAILABLE_ESLINT,
      errors: [`eslint no pudo ejecutarse en este entorno: ${detail}`],
    };
  }
}

export function eslintTool(version: string | undefined): ToolVersion {
  return { name: ESLINT_TOOL_NAME, version: version ?? 'unavailable' };
}
