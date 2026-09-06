import { describe, expect, test } from 'bun:test';
import { isBlocking, isCatalogId, ownerAxisOf } from '../../catalog/index.ts';
import { normalize } from '../normalize.ts';
import { RAW_SCHEMA_VERSION } from '../raw.ts';
import { toObservations } from './adapter.ts';
import {
  assetCollection,
  cleanAnalysis,
  depsAnalysis,
  enrichment,
  FIXTURE_ORIGIN,
  jsAsset,
  retireReport,
  retireResult,
  retireVulnerability,
  sourcemapFinding,
} from './fixture.ts';

function idsOf(analysis: Parameters<typeof toObservations>[0]): readonly string[] {
  return toObservations(analysis).map((observation) => observation.id);
}

function observation(analysis: Parameters<typeof toObservations>[0], id: string) {
  const found = toObservations(analysis).find((candidate) => candidate.id === id);

  if (found === undefined) {
    throw new Error(`The adapter did not emit ${id}.`);
  }

  return found;
}

describe('toObservations', () => {
  test('emits only IDs the catalog publishes, all of them owned by DEPS', () => {
    const analysis = depsAnalysis({
      sourcemaps: [sourcemapFinding()],
      enrichment: enrichment({ registry: { available: true, latest: { jquery: '4.0.0' } } }),
    });

    for (const id of idsOf(analysis)) {
      expect(isCatalogId(id)).toBe(true);
      expect(ownerAxisOf(id)).toBe('DEPS');
    }
  });

  test('a page with nothing wrong still reports what black-box could not see', () => {
    expect(idsOf(cleanAnalysis())).toEqual(['DEPS-VERSION-UNDETERMINED']);
  });
});

describe('vulnerability mapping', () => {
  test('an exploited CVE becomes the blocking KEV finding', () => {
    const analysis = depsAnalysis({
      enrichment: enrichment({
        kev: { available: true, listed: ['CVE-2020-11022'], catalogVersion: '2026.09.01' },
      }),
    });

    expect(idsOf(analysis)).toContain('DEPS-VULN-KEV');
    expect(isBlocking('DEPS-VULN-KEV')).toBe(true);
  });

  test('a high EPSS promotes a medium advisory the CVSS alone would bury', () => {
    const analysis = depsAnalysis({
      enrichment: enrichment({ epss: { available: true, scores: { 'CVE-2020-11022': 0.42 } } }),
    });

    const emitted = observation(analysis, 'DEPS-VULN-HIGH-EPSS');
    expect(emitted.evidence.reason).toBe('epss-high');
  });

  test('one observation per ID carries every advisory behind it', () => {
    const analysis = depsAnalysis({
      retire: retireReport([
        {
          file: '/tmp/webdiag-deps-fixture/000-vendor.js',
          results: [
            retireResult({
              vulnerabilities: [
                retireVulnerability(),
                retireVulnerability({
                  identifiers: { CVE: ['CVE-2020-11023'] },
                  below: '3.5.0',
                }),
              ],
            }),
          ],
        },
      ]),
    });

    const emitted = observation(analysis, 'DEPS-VULN-MEDIUM');
    expect(emitted.count).toBe(2);
    expect(emitted.evidence.advisories).toHaveLength(2);
    expect(emitted.evidence.fixed_in).toEqual(['jquery@3.5.0']);
  });

  test('the first fixed version reaches the evidence, because it is the fix', () => {
    const emitted = observation(depsAnalysis(), 'DEPS-VULN-MEDIUM');
    const [first] = emitted.evidence.advisories as readonly { fixed_in?: string }[];

    expect(first?.fixed_in).toBe('3.5.0');
  });

  test('a bundle from a CDN is named by its full URL, a first-party one by path', () => {
    const cdn = 'https://cdn.example.net/jquery.js';
    const analysis = depsAnalysis({
      collection: assetCollection({
        assets: [jsAsset({ url: cdn, path: '/tmp/webdiag-deps-fixture/000-cdn.js' })],
      }),
      retire: retireReport([
        { file: '/tmp/webdiag-deps-fixture/000-cdn.js', results: [retireResult()] },
      ]),
    });

    expect(observation(analysis, 'DEPS-VULN-MEDIUM').affected).toEqual([cdn]);
    expect(observation(depsAnalysis(), 'DEPS-VULN-MEDIUM').affected).toEqual(['/assets/vendor.js']);
  });

  test('a lone low advisory keeps its severity; one real medium takes it back', () => {
    const low = depsAnalysis({
      retire: retireReport([
        {
          file: '/tmp/webdiag-deps-fixture/000-vendor.js',
          results: [retireResult({ vulnerabilities: [retireVulnerability({ severity: 'low' })] })],
        },
      ]),
    });

    expect(observation(low, 'DEPS-VULN-MEDIUM').severity).toBe('low');

    const mixed = depsAnalysis({
      retire: retireReport([
        {
          file: '/tmp/webdiag-deps-fixture/000-vendor.js',
          results: [
            retireResult({
              vulnerabilities: [retireVulnerability({ severity: 'low' }), retireVulnerability()],
            }),
          ],
        },
      ]),
    });

    expect(observation(mixed, 'DEPS-VULN-MEDIUM').severity).toBeUndefined();
  });

  test('a hash match is trusted more than a content match', () => {
    const hashed = depsAnalysis({
      retire: retireReport([
        {
          file: '/tmp/webdiag-deps-fixture/000-vendor.js',
          results: [retireResult({ detection: 'hash' })],
        },
      ]),
    });

    expect(observation(hashed, 'DEPS-VULN-MEDIUM').confidence).toBe('high');
    expect(observation(depsAnalysis(), 'DEPS-VULN-MEDIUM').confidence).toBe('medium');
  });
});

describe('DEPS-LIB-OUTDATED', () => {
  test('fires one major behind and stays quiet within the same major', () => {
    const behind = depsAnalysis({
      enrichment: enrichment({ registry: { available: true, latest: { jquery: '4.0.0' } } }),
    });
    const current = depsAnalysis({
      enrichment: enrichment({ registry: { available: true, latest: { jquery: '3.7.1' } } }),
    });

    expect(idsOf(behind)).toContain('DEPS-LIB-OUTDATED');
    expect(idsOf(current)).not.toContain('DEPS-LIB-OUTDATED');
  });

  test('says what was detected and what is current', () => {
    const analysis = depsAnalysis({
      enrichment: enrichment({ registry: { available: true, latest: { jquery: '4.0.0' } } }),
    });

    expect(observation(analysis, 'DEPS-LIB-OUTDATED').evidence.libraries).toEqual([
      {
        library: 'jquery',
        npm: 'jquery',
        detected: '3.4.1',
        latest: '4.0.0',
        assets: ['/assets/vendor.js'],
      },
    ]);
  });
});

describe('DEPS-SOURCEMAP-EXPOSED', () => {
  test('is owned by DEPS and only mentioned by SEC, as the catalog says', () => {
    const analysis = depsAnalysis({ sourcemaps: [sourcemapFinding()] });
    const { findings } = normalize([
      {
        schema: RAW_SCHEMA_VERSION,
        axis: 'DEPS',
        tool: { name: 'retire.js', version: '5.7.0' },
        target: { url: `${FIXTURE_ORIGIN}/`, mode: 'quick' },
        observations: toObservations(analysis),
      },
    ]);

    const finding = findings.find((candidate) => candidate.id === 'DEPS-SOURCEMAP-EXPOSED');
    expect(finding).toBeDefined();
    expect(ownerAxisOf('DEPS-SOURCEMAP-EXPOSED')).toBe('DEPS');
  });

  test('leads with the original source when the map ships it', () => {
    const withSource = observation(
      depsAnalysis({ sourcemaps: [sourcemapFinding()] }),
      'DEPS-SOURCEMAP-EXPOSED',
    );

    expect(withSource.title).toContain('código fuente original');
    expect(withSource.evidence.with_original_source).toBe(1);

    const withoutSource = observation(
      depsAnalysis({ sourcemaps: [sourcemapFinding({ sourcesContent: false })] }),
      'DEPS-SOURCEMAP-EXPOSED',
    );

    expect(withoutSource.title).toBeUndefined();
  });

  test('counts every exposed map, however it was found', () => {
    const analysis = depsAnalysis({
      sourcemaps: [
        sourcemapFinding(),
        sourcemapFinding({
          asset: `${FIXTURE_ORIGIN}/assets/vendor.js`,
          url: 'inline',
          kind: 'inline',
        }),
      ],
    });

    expect(observation(analysis, 'DEPS-SOURCEMAP-EXPOSED').count).toBe(2);
  });
});

describe('DEPS-VERSION-UNDETERMINED', () => {
  test('counts a library a signature saw and retire.js could not version', () => {
    const analysis = depsAnalysis({
      libraries: [{ assetUrl: `${FIXTURE_ORIGIN}/assets/vendor.js`, library: 'react' }],
    });

    const emitted = observation(analysis, 'DEPS-VERSION-UNDETERMINED');
    expect(emitted.count).toBe(1);
    expect(emitted.evidence.libraries).toEqual(['react']);
    expect(emitted.affected).toEqual(['/assets/vendor.js']);
  });

  test('does not claim a library is unversioned when retire.js versioned it', () => {
    const analysis = depsAnalysis({
      libraries: [{ assetUrl: `${FIXTURE_ORIGIN}/assets/vendor.js`, library: 'jquery' }],
    });

    const emitted = observation(analysis, 'DEPS-VERSION-UNDETERMINED');
    expect(emitted.evidence.undetermined).toBe(0);
    // Still emitted, and still count 1: reading bundles is itself the limit.
    expect(emitted.count).toBe(1);
  });

  test('says which public feeds answered, so a gap is never read as a clean result', () => {
    const analysis = depsAnalysis({
      enrichment: {
        kev: { available: false, listed: [], catalogVersion: undefined },
        epss: { available: false, scores: {} },
        registry: { available: true, latest: {} },
      },
    });

    expect(observation(analysis, 'DEPS-VERSION-UNDETERMINED').evidence.feeds).toEqual({
      kev: false,
      epss: false,
      npm_registry: true,
    });
  });

  test('reports the bundles it refused to scan', () => {
    const analysis = depsAnalysis({
      collection: assetCollection({
        skipped: [
          { url: `${FIXTURE_ORIGIN}/huge.js`, reason: 'too-large', detail: '20000000 bytes' },
        ],
      }),
    });

    const emitted = observation(analysis, 'DEPS-VERSION-UNDETERMINED');
    expect(emitted.evidence.assets_skipped).toBe(1);
    expect(emitted.evidence.skipped).toHaveLength(1);
  });
});

describe('determinism', () => {
  test('the same analysis produces the same bytes, whatever order it arrived in', () => {
    const forwards = depsAnalysis({
      collection: assetCollection({
        assets: [
          jsAsset({ url: `${FIXTURE_ORIGIN}/a.js`, path: '/tmp/f/a.js' }),
          jsAsset({ url: `${FIXTURE_ORIGIN}/b.js`, path: '/tmp/f/b.js' }),
        ],
      }),
      retire: retireReport([
        { file: '/tmp/f/a.js', results: [retireResult()] },
        {
          file: '/tmp/f/b.js',
          results: [retireResult({ component: 'lodash', version: '4.17.20' })],
        },
      ]),
      libraries: [
        { assetUrl: `${FIXTURE_ORIGIN}/b.js`, library: 'vue' },
        { assetUrl: `${FIXTURE_ORIGIN}/a.js`, library: 'react' },
      ],
    });

    const backwards = depsAnalysis({
      collection: assetCollection({
        assets: [
          jsAsset({ url: `${FIXTURE_ORIGIN}/b.js`, path: '/tmp/f/b.js' }),
          jsAsset({ url: `${FIXTURE_ORIGIN}/a.js`, path: '/tmp/f/a.js' }),
        ],
      }),
      retire: retireReport([
        {
          file: '/tmp/f/b.js',
          results: [retireResult({ component: 'lodash', version: '4.17.20' })],
        },
        { file: '/tmp/f/a.js', results: [retireResult()] },
      ]),
      libraries: [
        { assetUrl: `${FIXTURE_ORIGIN}/a.js`, library: 'react' },
        { assetUrl: `${FIXTURE_ORIGIN}/b.js`, library: 'vue' },
      ],
    });

    expect(JSON.stringify(toObservations(forwards))).toBe(
      JSON.stringify(toObservations(backwards)),
    );
  });
});
