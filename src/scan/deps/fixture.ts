/**
 * Builders for the values the DEPS probe would have gathered.
 *
 * Exported from `src/` rather than from a test file because they are the same
 * seam the probe itself uses: anything that can build a `DepsAnalysis` can drive
 * the whole adapter without a browser, a subprocess or a network. The defaults
 * describe a boring page — one clean bundle, no advisories — so each test states
 * only the fact it is about.
 */
import type { DepsAnalysis, LibraryHit } from './adapter.ts';
import type { AssetCollection, JsAsset } from './assets.ts';
import { EMPTY_ENRICHMENT, type Enrichment } from './enrichment.ts';
import type { RetireReport, RetireResult, RetireVulnerability } from './retire.ts';
import type { SourcemapFinding } from './sourcemaps.ts';

export const FIXTURE_ORIGIN = 'https://example.test';

export function jsAsset(overrides: Partial<JsAsset> = {}): JsAsset {
  const url = overrides.url ?? `${FIXTURE_ORIGIN}/assets/vendor.js`;

  return {
    url,
    path: `/tmp/webdiag-deps-fixture/000-vendor.js`,
    file: '000-vendor.js',
    bytes: 1024,
    status: 200,
    thirdParty: !url.startsWith(FIXTURE_ORIGIN),
    ...overrides,
  };
}

export function assetCollection(overrides: Partial<AssetCollection> = {}): AssetCollection {
  return {
    directory: '/tmp/webdiag-deps-fixture',
    assets: [jsAsset()],
    skipped: [],
    browser: { name: 'chrome', version: '152.0.7977.75' },
    pageUrl: `${FIXTURE_ORIGIN}/`,
    pageOrigin: FIXTURE_ORIGIN,
    navigationTimedOut: false,
    ...overrides,
  };
}

export function retireVulnerability(
  overrides: Partial<RetireVulnerability> = {},
): RetireVulnerability {
  return {
    below: '3.5.0',
    atOrAbove: '1.0.3',
    severity: 'medium',
    identifiers: {
      CVE: ['CVE-2020-11022'],
      summary: 'Regex in jQuery.htmlPrefilter may allow XSS',
    },
    info: ['https://blog.jquery.com/2020/04/10/jquery-3-5-0-released/'],
    cwe: ['CWE-79'],
    ...overrides,
  };
}

export function retireResult(overrides: Partial<RetireResult> = {}): RetireResult {
  return {
    component: 'jquery',
    version: '3.4.1',
    npmname: 'jquery',
    detection: 'filecontent',
    vulnerabilities: [retireVulnerability()],
    ...overrides,
  };
}

export function retireReport(
  files: readonly { file: string; results: readonly RetireResult[] }[] = [
    { file: '/tmp/webdiag-deps-fixture/000-vendor.js', results: [retireResult()] },
  ],
): RetireReport {
  return {
    version: '5.7.0',
    data: files.map((entry) => ({ file: entry.file, results: [...entry.results] })),
    messages: [],
    errors: [],
    vulnerabilityRepositories: ['https://retirejs.example/jsrepository-v5.json'],
  };
}

export function enrichment(overrides: Partial<Enrichment> = {}): Enrichment {
  return {
    kev: { available: true, listed: [], catalogVersion: '2026.09.01' },
    epss: { available: true, scores: {} },
    registry: { available: true, latest: {} },
    ...overrides,
  };
}

export function sourcemapFinding(overrides: Partial<SourcemapFinding> = {}): SourcemapFinding {
  return {
    asset: `${FIXTURE_ORIGIN}/assets/app.js`,
    url: `${FIXTURE_ORIGIN}/assets/app.js.map`,
    kind: 'linked',
    status: 200,
    sources: 42,
    sourcesContent: true,
    thirdParty: false,
    ...overrides,
  };
}

export function depsAnalysis(overrides: Partial<DepsAnalysis> = {}): DepsAnalysis {
  return {
    collection: assetCollection(),
    retire: retireReport(),
    libraries: [] as readonly LibraryHit[],
    sourcemaps: [],
    enrichment: enrichment(),
    ...overrides,
  };
}

/** An analysis with nothing wrong in it at all. */
export function cleanAnalysis(): DepsAnalysis {
  return depsAnalysis({
    retire: retireReport([{ file: '/tmp/webdiag-deps-fixture/000-vendor.js', results: [] }]),
    enrichment: {
      ...EMPTY_ENRICHMENT,
      kev: { available: true, listed: [], catalogVersion: undefined },
    },
  });
}
