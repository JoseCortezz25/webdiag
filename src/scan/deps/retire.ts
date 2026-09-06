/**
 * retire.js, and the schema for what it says.
 *
 * Two things are worth stating here.
 *
 * **It runs as a subprocess, driven with `--outputformat json`.** The library
 * entry point is not a published API and its shape has moved between majors;
 * the JSON report is the documented contract, and running the CLI is also what
 * the ticket literally asks for ("retire.js corre contra esos bundles").
 *
 * **It is spawned with Bun, not with `node`.** The README promises no Node.js
 * install is needed, and a probe that silently required one would make that
 * false on the first real scan.
 *
 * The report is parsed through zod rather than cast. Everything downstream
 * decides severity from these fields, so a retire.js release that renames one
 * must fail loudly here instead of quietly producing an empty DEPS axis.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ToolVersion } from '../raw.ts';

const require = createRequire(import.meta.url);

const retirePackage = require('retire/package.json') as {
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
};

/** The pinned retire.js, read from the installed package so it cannot drift. */
export const RETIRE_VERSION: string = retirePackage.version;

export const RETIRE_TOOL: ToolVersion = { name: 'retire.js', version: RETIRE_VERSION };

/** Definitions are fetched on first use; a cold cache pays for the download. */
const RETIRE_TIMEOUT_MS = 120_000;

/** retire.js exits 13 when it found something. That is a result, not a failure. */
const VULNERABILITIES_FOUND = 13;

/**
 * retire.js severities. `none` exists: an advisory can be published with no
 * rating, and dropping those would hide a real vulnerability behind a missing
 * field.
 */
export const RETIRE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;
export type RetireSeverity = (typeof RETIRE_SEVERITIES)[number];

const retireSeveritySchema = z
  .enum(RETIRE_SEVERITIES)
  .catch('none' as RetireSeverity)
  .default('none');

export const retireVulnerabilitySchema = z.object({
  /** First fixed version. The single most useful thing to put in a remediation. */
  below: z.string().optional(),
  atOrAbove: z.string().optional(),
  severity: retireSeveritySchema,
  identifiers: z
    .object({
      CVE: z.array(z.string()).optional(),
      githubID: z.string().optional(),
      summary: z.string().optional(),
      issue: z.string().optional(),
    })
    .default({}),
  info: z.array(z.string()).default([]),
  cwe: z.array(z.string()).default([]),
});

export type RetireVulnerability = z.infer<typeof retireVulnerabilitySchema>;

/** How retire.js recognised the library. It is the honest input to confidence. */
export const RETIRE_DETECTIONS = ['filename', 'filecontent', 'hash', 'unknown'] as const;
export type RetireDetection = (typeof RETIRE_DETECTIONS)[number];

export const retireResultSchema = z.object({
  component: z.string(),
  version: z.string(),
  npmname: z.string().optional(),
  detection: z
    .enum(RETIRE_DETECTIONS)
    .catch('unknown' as RetireDetection)
    .default('unknown'),
  vulnerabilities: z.array(retireVulnerabilitySchema).default([]),
});

export type RetireResult = z.infer<typeof retireResultSchema>;

export const retireFileSchema = z.object({
  file: z.string(),
  results: z.array(retireResultSchema).default([]),
});

export type RetireFile = z.infer<typeof retireFileSchema>;

export const retireReportSchema = z.object({
  version: z.string(),
  data: z.array(retireFileSchema).default([]),
  messages: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  /** Which advisory feed answered. Recorded so a finding can be reproduced. */
  vulnerabilityRepositories: z.array(z.string()).default([]),
});

export type RetireReport = z.infer<typeof retireReportSchema>;

export function parseRetireReport(input: unknown): RetireReport {
  return retireReportSchema.parse(input);
}

function retireCliPath(): string {
  const entry = retirePackage.bin.retire ?? './lib/cli.js';
  return join(dirname(require.resolve('retire/package.json')), entry);
}

export type RetireScanner = (directory: string) => Promise<RetireReport>;

/**
 * Scans a directory of bundles.
 *
 * `--verbose` is not a logging flag here, it is a data flag: without it
 * retire.js reports only files with known vulnerabilities, and a clean run
 * returns nothing at all. The probe needs the libraries it recognised *and
 * found clean* too — that is what `DEPS-LIB-OUTDATED` compares against, and
 * what keeps `DEPS-VERSION-UNDETERMINED` from claiming a library was
 * unidentifiable when retire.js identified it perfectly well.
 */
export async function scanWithRetire(directory: string): Promise<RetireReport> {
  const child = Bun.spawn(
    [process.execPath, retireCliPath(), '--path', directory, '--outputformat', 'json', '--verbose'],
    { stdout: 'pipe', stderr: 'pipe', timeout: RETIRE_TIMEOUT_MS },
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0 && code !== VULNERABILITIES_FOUND) {
    throw new Error(
      `retire.js exited with ${code}: ${stderr.trim().slice(0, 400) || 'no diagnostics'}`,
    );
  }

  try {
    return parseRetireReport(JSON.parse(stdout));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`retire.js produced a report this build cannot read: ${detail}`);
  }
}
