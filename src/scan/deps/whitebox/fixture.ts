/**
 * Builders for the values the white-box DEPS probe would have gathered.
 *
 * Same seam as `../fixture.ts`: anything that can build a `WhiteboxAnalysis`
 * drives the adapter without a checkout, a subprocess or a network. Defaults
 * describe a boring repo — one clean lockfile, nothing deprecated, nothing out
 * of support — so each test states only the fact it is about.
 */

import type { EpssLookup, KevLookup } from '../enrichment.ts';
import type { WhiteboxAnalysis } from './analyze.ts';
import type { EolLookup } from './eol.ts';
import type { EslintReport, EslintScan } from './eslint.ts';
import type { Inventory, PackageRef } from './inventory.ts';
import type { NpmLookup, NpmPackageFacts } from './npm.ts';
import type { OsvGroup, OsvPackage, OsvReport, OsvScan, OsvVulnerability } from './osv.ts';
import type { RepoInspection, RuntimeDeclaration } from './repo.ts';
import type { MaintenanceVerdict, ScorecardLookup } from './scorecard.ts';
import type { SyftScan } from './syft.ts';

export const FIXTURE_ROOT = '/tmp/webdiag-whitebox-fixture';

export function repoInspection(overrides: Partial<RepoInspection> = {}): RepoInspection {
  return {
    root: FIXTURE_ROOT,
    lockfiles: ['package-lock.json'],
    manifestName: 'demo-app',
    directDependencies: [],
    runtimes: [],
    notes: [],
    ...overrides,
  };
}

export function packageRef(overrides: Partial<PackageRef> = {}): PackageRef {
  return { ecosystem: 'npm', name: 'left-pad', version: '1.3.0', ...overrides };
}

export function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return { packages: [packageRef()], source: 'lockfile', ...overrides };
}

export function osvVulnerability(overrides: Partial<OsvVulnerability> = {}): OsvVulnerability {
  return {
    id: 'GHSA-demo-0001',
    aliases: ['CVE-2024-0001'],
    summary: 'Ejemplo de aviso para pruebas',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [
      {
        package: { ecosystem: 'npm', name: 'left-pad' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.3.1' }] }],
      },
    ],
    ...overrides,
  };
}

export function osvGroup(overrides: Partial<OsvGroup> = {}): OsvGroup {
  return { ids: ['GHSA-demo-0001'], aliases: ['CVE-2024-0001'], max_severity: '9.8', ...overrides };
}

export function osvPackage(overrides: Partial<OsvPackage> = {}): OsvPackage {
  return {
    package: { name: 'left-pad', version: '1.3.0', ecosystem: 'npm' },
    groups: [osvGroup()],
    vulnerabilities: [osvVulnerability()],
    ...overrides,
  };
}

export function osvReport(
  packages: readonly OsvPackage[] = [osvPackage()],
  source = 'package-lock.json',
): OsvReport {
  return {
    results:
      packages.length === 0
        ? []
        : [{ source: { path: source, type: 'lockfile' }, packages: [...packages] }],
  };
}

export function osvScan(overrides: Partial<OsvScan> = {}): OsvScan {
  return {
    available: true,
    version: '2.5.1',
    report: osvReport([]),
    errors: [],
    ...overrides,
  };
}

export function syftScan(overrides: Partial<SyftScan> = {}): SyftScan {
  return {
    available: true,
    version: '1.51.1',
    sbom: '{"bomFormat":"CycloneDX","components":[]}',
    components: 0,
    inventory: inventory(),
    errors: [],
    ...overrides,
  };
}

export function npmFacts(overrides: Partial<NpmPackageFacts> = {}): NpmPackageFacts {
  return {
    name: 'left-pad',
    version: '1.3.0',
    deprecated: undefined,
    repository: 'https://github.com/left-pad/left-pad',
    ...overrides,
  };
}

export function npmLookup(overrides: Partial<NpmLookup> = {}): NpmLookup {
  return { available: true, facts: {}, queried: 0, ...overrides };
}

export function maintenanceVerdict(
  overrides: Partial<MaintenanceVerdict> = {},
): MaintenanceVerdict {
  return {
    repository: 'https://github.com/left-pad/left-pad',
    score: 10,
    overall: 8.5,
    evaluatedAt: '2026-01-01',
    reason: 'Active commits and issue activity within the last 90 days.',
    ...overrides,
  };
}

export function scorecardLookup(overrides: Partial<ScorecardLookup> = {}): ScorecardLookup {
  return { available: true, verdicts: {}, queried: 0, ...overrides };
}

export function runtimeDeclaration(
  overrides: Partial<RuntimeDeclaration> = {},
): RuntimeDeclaration {
  return {
    product: 'nodejs',
    label: 'Node.js',
    declared: '20.11.1',
    source: 'package.json',
    ...overrides,
  };
}

export function eolLookup(overrides: Partial<EolLookup> = {}): EolLookup {
  return { available: true, products: {}, ...overrides };
}

export function eslintReport(overrides: EslintReport = []): EslintReport {
  return overrides;
}

export function eslintScan(overrides: Partial<EslintScan> = {}): EslintScan {
  return { available: true, version: '9.15.0', results: [], errors: [], ...overrides };
}

export function kevLookup(overrides: Partial<KevLookup> = {}): KevLookup {
  return { available: true, listed: [], catalogVersion: '2026.01.01', ...overrides };
}

export function epssLookup(overrides: Partial<EpssLookup> = {}): EpssLookup {
  return { available: true, scores: {}, ...overrides };
}

export function whiteboxAnalysis(overrides: Partial<WhiteboxAnalysis> = {}): WhiteboxAnalysis {
  return {
    repo: repoInspection(),
    osv: osvScan(),
    syft: syftScan(),
    inventory: inventory(),
    npm: npmLookup(),
    scorecard: scorecardLookup(),
    eol: eolLookup(),
    eslint: eslintScan(),
    kev: kevLookup(),
    epss: epssLookup(),
    now: new Date('2026-06-01T00:00:00.000Z'),
    notes: [],
    ...overrides,
  };
}

/** An analysis with nothing wrong in it at all. */
export function cleanWhiteboxAnalysis(): WhiteboxAnalysis {
  return whiteboxAnalysis();
}
