/**
 * The I/O half of the white-box DEPS probe: read the checkout, run the tools,
 * ask the public feeds, hand over one plain value.
 *
 * The mirror of `../analyze.ts`, with the same reason for existing: everything
 * with a side effect — the filesystem walk, the two subprocesses, ESLint, the
 * three network lookups — happens here, so `whitebox/adapter.ts` stays pure and
 * testable from a fixture.
 *
 * Nothing here is allowed to let a missing tool take the whole axis down.
 * `inspectRepo` is the one call that may throw (`--repo` pointing at something
 * that is not a readable directory is a request the probe cannot honour at
 * all); everything after it degrades instead of failing, and every degradation
 * lands in `notes`.
 */
import type { ProbeContext } from '../../probe.ts';
import { type EpssLookup, fetchEpss, fetchKev, type KevLookup } from '../enrichment.ts';
import { type EolLookup, fetchEolProducts } from './eol.ts';
import { type EslintScan, eslintScanOrDegrade } from './eslint.ts';
import {
  EMPTY_INVENTORY,
  type Inventory,
  normalizeInventory,
  type PackageRef,
  readerFor,
} from './inventory.ts';
import { fetchNpmFacts, type NpmLookup } from './npm.ts';
import { type OsvReport, type OsvScan, osvScanOrDegrade } from './osv.ts';
import { inspectRepo, type RepoInspection } from './repo.ts';
import { fetchScorecards, type ScorecardLookup } from './scorecard.ts';
import { type SyftScan, syftScanOrDegrade } from './syft.ts';

export type WhiteboxAnalysis = {
  readonly repo: RepoInspection;
  readonly osv: OsvScan;
  readonly syft: SyftScan;
  readonly inventory: Inventory;
  readonly npm: NpmLookup;
  readonly scorecard: ScorecardLookup;
  readonly eol: EolLookup;
  readonly eslint: EslintScan;
  readonly kev: KevLookup;
  readonly epss: EpssLookup;
  /** Injected so `DEPS-RUNTIME-EOL` is testable without depending on the clock. */
  readonly now: Date;
  /** What this run could not see, in plain language. Never swallowed. */
  readonly notes: readonly string[];
};

/**
 * Package refs straight out of the repo's own lockfiles, for when Syft is not
 * installed. Only the two formats `inventory.ts` can parse without guessing are
 * read; the rest simply contribute nothing, and the caller says so.
 */
async function inventoryFromLockfiles(repo: RepoInspection): Promise<Inventory> {
  const packages: PackageRef[] = [];
  let sawSupportedLockfile = false;

  for (const lockfile of repo.lockfiles) {
    const reader = readerFor(lockfile);

    if (reader === undefined) {
      continue;
    }

    sawSupportedLockfile = true;
    const text = await Bun.file(`${repo.root}/${lockfile}`)
      .text()
      .catch(() => undefined);

    if (text !== undefined) {
      packages.push(...reader(text));
    }
  }

  return sawSupportedLockfile
    ? { packages: normalizeInventory(packages), source: 'lockfile' }
    : EMPTY_INVENTORY;
}

/** Every CVE-shaped identifier a group's `ids`/`aliases` name, across the report. */
function cvesOfReport(report: OsvReport): readonly string[] {
  const cves = new Set<string>();

  for (const result of report.results) {
    for (const pkg of result.packages) {
      for (const group of pkg.groups) {
        for (const id of [...group.ids, ...group.aliases]) {
          if (/^CVE-\d{4}-\d+$/.test(id)) {
            cves.add(id);
          }
        }
      }
    }
  }

  return [...cves].sort();
}

export type WhiteboxAnalyzeOptions = {
  readonly now?: Date;
};

export type WhiteboxDepsAnalyzer = (
  context: ProbeContext,
  options?: WhiteboxAnalyzeOptions,
) => Promise<WhiteboxAnalysis>;

export const analyzeWhiteboxRepo: WhiteboxDepsAnalyzer = async (
  context: ProbeContext,
  options: WhiteboxAnalyzeOptions = {},
): Promise<WhiteboxAnalysis> => {
  if (context.repo === undefined) {
    throw new Error('analyzeWhiteboxRepo was called without context.repo.');
  }

  const notes: string[] = [];
  const repo = await inspectRepo(context.repo);
  notes.push(...repo.notes);

  const [osv, syft] = await Promise.all([
    osvScanOrDegrade(repo.root),
    syftScanOrDegrade(repo.root),
  ]);
  notes.push(...osv.errors, ...syft.errors);

  const inventory =
    syft.available && syft.inventory.packages.length > 0
      ? syft.inventory
      : await inventoryFromLockfiles(repo);

  if (inventory.packages.length === 0) {
    notes.push(
      'No se pudo construir un inventario de paquetes (Syft no disponible y ningún lockfile del repo es de un formato que este build sabe leer): DEPS-LIB-DEPRECATED y DEPS-LIB-UNMAINTAINED no se evaluaron.',
    );
  }

  const npmPackages = inventory.packages.filter((entry) => entry.ecosystem === 'npm');
  const npm = await fetchNpmFacts(npmPackages);

  if (!npm.available && npmPackages.length > 0) {
    notes.push('El registro de npm no respondió: DEPS-LIB-DEPRECATED no se pudo evaluar.');
  }

  const repositories = [
    ...new Set(
      Object.values(npm.facts)
        .map((fact) => fact.repository)
        .filter((repository): repository is string => repository !== undefined),
    ),
  ].sort();

  const scorecard = await fetchScorecards(repositories);

  if (!scorecard.available && repositories.length > 0) {
    notes.push('OpenSSF Scorecard no respondió: DEPS-LIB-UNMAINTAINED no se pudo evaluar.');
  }

  const products = [...new Set(repo.runtimes.map((runtime) => runtime.product))].sort();
  const eol = await fetchEolProducts(products);

  if (!eol.available && products.length > 0) {
    notes.push('endoflife.date no respondió: DEPS-RUNTIME-EOL no se pudo evaluar.');
  }

  const cves = cvesOfReport(osv.report);
  const [kev, epss] = await Promise.all([fetchKev(cves), fetchEpss(cves)]);

  const eslint = await eslintScanOrDegrade(repo.root);
  notes.push(...eslint.errors);

  return {
    repo,
    osv,
    syft,
    inventory,
    npm,
    scorecard,
    eol,
    eslint,
    kev,
    epss,
    now: options.now ?? new Date(),
    notes,
  };
};
