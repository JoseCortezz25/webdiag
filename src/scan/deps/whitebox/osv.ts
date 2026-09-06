/**
 * osv-scanner, and the schema for what it says.
 *
 * Two decisions shape this file, both the same ones `retire.ts` made for the
 * black-box side.
 *
 * **It runs as a subprocess with `--format json`.** osv-scanner is a Go binary
 * with no library surface for us, and the JSON report is its documented
 * contract. **The report is parsed through zod rather than cast**, because
 * everything downstream decides severity from these fields: an osv-scanner
 * release that renames one must fail loudly here instead of quietly producing a
 * DEPS axis with no vulnerabilities in it.
 *
 * The one thing worth knowing about the output shape: each vulnerable package
 * carries both `groups` and `vulnerabilities`. `groups` is the compact view —
 * aliased advisories collapsed into one entry with a numeric `max_severity`,
 * which is the CVSS score already computed for us. `vulnerabilities` is the full
 * OSV record, and is where the summary and the fixed version live. Both are
 * read: the group decides how bad it is, the records say what it is.
 */
import { z } from 'zod';
import type { ToolVersion } from '../../raw.ts';
import { type CommandRunner, runCommand } from '../../sec/curl.ts';

export const OSV_TOOL_NAME = 'osv-scanner';

/** A cold osv-scanner downloads its offline database on first use. */
export const OSV_TIMEOUT_MS = 300_000;

/** osv-scanner exits 1 when it found vulnerabilities. That is a result. */
const VULNERABILITIES_FOUND = 1;

const osvSeveritySchema = z.object({
  type: z.string().default('UNKNOWN'),
  score: z.string().default(''),
});

const osvRangeEventSchema = z.object({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
  last_affected: z.string().optional(),
});

const osvAffectedSchema = z.object({
  package: z
    .object({ ecosystem: z.string().default(''), name: z.string().default('') })
    .default({ ecosystem: '', name: '' }),
  ranges: z
    .array(
      z.object({ type: z.string().default(''), events: z.array(osvRangeEventSchema).default([]) }),
    )
    .default([]),
});

export const osvVulnerabilitySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).default([]),
  summary: z.string().optional(),
  severity: z.array(osvSeveritySchema).default([]),
  affected: z.array(osvAffectedSchema).default([]),
});

export type OsvVulnerability = z.infer<typeof osvVulnerabilitySchema>;

export const osvGroupSchema = z.object({
  ids: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  /** CVSS base score as a string, e.g. `"8.1"`. Absent when nothing scored it. */
  max_severity: z.string().default(''),
});

export type OsvGroup = z.infer<typeof osvGroupSchema>;

export const osvPackageSchema = z.object({
  package: z.object({
    name: z.string(),
    version: z.string().default(''),
    ecosystem: z.string().default(''),
  }),
  groups: z.array(osvGroupSchema).default([]),
  vulnerabilities: z.array(osvVulnerabilitySchema).default([]),
});

export type OsvPackage = z.infer<typeof osvPackageSchema>;

export const osvResultSchema = z.object({
  source: z.object({ path: z.string().default(''), type: z.string().default('') }).default({
    path: '',
    type: '',
  }),
  packages: z.array(osvPackageSchema).default([]),
});

export type OsvResult = z.infer<typeof osvResultSchema>;

export const osvReportSchema = z.object({
  results: z.array(osvResultSchema).default([]),
});

export type OsvReport = z.infer<typeof osvReportSchema>;

export function parseOsvReport(input: unknown): OsvReport {
  return osvReportSchema.parse(input);
}

/** What a run produced, including the case where it could not run at all. */
export type OsvScan = {
  readonly available: boolean;
  readonly version: string | undefined;
  readonly report: OsvReport;
  /** Why it could not run, or what it complained about. Never swallowed. */
  readonly errors: readonly string[];
};

export const UNAVAILABLE_OSV: OsvScan = {
  available: false,
  version: undefined,
  report: { results: [] },
  errors: [],
};

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/**
 * Where osv-scanner is.
 *
 * Same order as `locateTestssl`: an explicit override first, then the operator's
 * PATH, then the copy `scripts/install-whitebox.sh` vendored. `undefined` is a
 * normal answer and degrades the probe.
 */
export async function locateOsvScanner(): Promise<string | undefined> {
  const override = Bun.env.WEBDIAG_OSV_SCANNER;

  if (override !== undefined && override !== '' && (await exists(override))) {
    return override;
  }

  const onPath = Bun.which('osv-scanner');

  if (onPath !== null) {
    return onPath;
  }

  const vendored = `${import.meta.dir}/../../../../vendor/osv-scanner`;

  return (await exists(vendored)) ? vendored : undefined;
}

/** `osv-scanner version: 2.5.1` becomes `2.5.1`. Recorded in `meta.json`. */
export async function osvVersion(
  path: string,
  runner: CommandRunner = runCommand,
): Promise<string | undefined> {
  try {
    const result = await runner([path, '--version'], { timeoutMs: 30_000 });
    return /version:?\s*v?(\d\S*)/i.exec(result.stdout)?.[1];
  } catch {
    return undefined;
  }
}

export type OsvRun = {
  readonly path: string;
  readonly root: string;
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
};

/**
 * Scans a checkout.
 *
 * `scan source --recursive` is the lockfile mode: osv-scanner walks the tree,
 * finds every manifest and lockfile it understands, and queries osv.dev for the
 * exact resolved versions. That is the whole point of white-box — the versions
 * are read, not inferred from a minified bundle.
 *
 * `--no-ignore` is deliberately *not* passed: a path the project excluded from
 * version control is not shipped, and reporting a vulnerability in a fixture
 * nobody deploys is how a scanner earns the reputation of crying wolf.
 */
export async function runOsvScanner(options: OsvRun): Promise<OsvScan> {
  const runner = options.runner ?? runCommand;
  const version = await osvVersion(options.path, runner);

  const result = await runner(
    [options.path, 'scan', 'source', '--recursive', '--format', 'json', options.root],
    { timeoutMs: options.timeoutMs ?? OSV_TIMEOUT_MS },
  );

  if (result.exitCode !== 0 && result.exitCode !== VULNERABILITIES_FOUND) {
    throw new Error(
      `osv-scanner exited with ${result.exitCode}: ${
        result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? 'no diagnostics'
      }`,
    );
  }

  try {
    return {
      available: true,
      version,
      report: parseOsvReport(JSON.parse(result.stdout)),
      errors: [],
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`osv-scanner produced a report this build cannot read: ${detail}`);
  }
}

/**
 * The scan, or an empty one that says why there is none.
 *
 * Same contract as `scanOrDegrade` on the black-box side, and for the same
 * reason: osv-scanner is the centrepiece of the white-box axis but not the whole
 * of it. Deprecated packages, unmaintained ones and an EOL runtime are all
 * established without it, and letting a missing binary take those down would
 * trade real findings for an empty axis.
 */
export async function osvScanOrDegrade(root: string): Promise<OsvScan> {
  const path = await locateOsvScanner();

  if (path === undefined) {
    return {
      ...UNAVAILABLE_OSV,
      errors: [
        'osv-scanner no está instalado: no se consultaron los avisos de osv.dev para los lockfiles del repo. Instalarlo con `bun run install:whitebox`.',
      ],
    };
  }

  try {
    return await runOsvScanner({ path, root });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    return {
      ...UNAVAILABLE_OSV,
      errors: [`osv-scanner no pudo ejecutarse en este entorno: ${detail}`],
    };
  }
}

export function osvTool(version: string | undefined): ToolVersion {
  return { name: OSV_TOOL_NAME, version: version ?? 'unavailable' };
}
