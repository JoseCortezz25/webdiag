import { describe, expect, test } from 'bun:test';
import { normalize } from '../../normalize.ts';
import { RAW_SCHEMA_VERSION } from '../../raw.ts';
import { toWhiteboxObservations } from './adapter.ts';
import {
  cleanWhiteboxAnalysis,
  eolLookup,
  eslintScan,
  kevLookup,
  maintenanceVerdict,
  npmFacts,
  npmLookup,
  osvGroup,
  osvPackage,
  osvReport,
  osvScan,
  osvVulnerability,
  repoInspection,
  runtimeDeclaration,
  scorecardLookup,
  whiteboxAnalysis,
} from './fixture.ts';

describe('toWhiteboxObservations', () => {
  test('a clean repo produces no observations at all', () => {
    expect(toWhiteboxObservations(cleanWhiteboxAnalysis())).toEqual([]);
  });

  test('never emits DEPS-VERSION-UNDETERMINED: the version always comes from the lockfile', () => {
    const analysis = whiteboxAnalysis({
      osv: osvScan({
        report: osvReport([osvPackage({ groups: [osvGroup({ max_severity: '9.8' })] })]),
      }),
    });

    const ids = toWhiteboxObservations(analysis).map((observation) => observation.id);
    expect(ids).not.toContain('DEPS-VERSION-UNDETERMINED');
  });

  test('a CVSS >= 9.0 group becomes DEPS-VULN-CRITICAL, at high confidence', () => {
    const analysis = whiteboxAnalysis({
      osv: osvScan({
        report: osvReport([osvPackage({ groups: [osvGroup({ max_severity: '9.8' })] })]),
      }),
    });

    const observations = toWhiteboxObservations(analysis);
    const finding = observations.find((observation) => observation.id === 'DEPS-VULN-CRITICAL');

    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('high');
    expect(finding?.affected).toEqual(['package-lock.json']);
    expect(finding?.evidence.mode).toBe('white-box');
  });

  test('a CVE listed in KEV outranks CVSS and becomes DEPS-VULN-KEV', () => {
    const analysis = whiteboxAnalysis({
      osv: osvScan({
        report: osvReport([
          osvPackage({
            groups: [
              osvGroup({ max_severity: '9.8', ids: ['GHSA-x'], aliases: ['CVE-2024-9999'] }),
            ],
            vulnerabilities: [osvVulnerability({ id: 'GHSA-x', aliases: ['CVE-2024-9999'] })],
          }),
        ]),
      }),
      kev: kevLookup({ listed: ['CVE-2024-9999'] }),
    });

    const ids = toWhiteboxObservations(analysis).map((observation) => observation.id);
    expect(ids).toContain('DEPS-VULN-KEV');
    expect(ids).not.toContain('DEPS-VULN-CRITICAL');
  });

  test("reports the first fixed version among the group's advisories", () => {
    const analysis = whiteboxAnalysis({
      osv: osvScan({ report: osvReport([osvPackage()]) }),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-VULN-CRITICAL');
    expect(finding?.evidence.fixed_in).toEqual(['left-pad@1.3.1']);
  });

  test('DEPS-LIB-DEPRECATED: a package npm itself marks deprecated', () => {
    const analysis = whiteboxAnalysis({
      npm: npmLookup({
        facts: {
          'left-pad@1.3.0': npmFacts({ deprecated: 'use String.prototype.padStart instead' }),
        },
      }),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-LIB-DEPRECATED');
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('high');
    expect(finding?.affected).toEqual(['left-pad@1.3.0']);
    expect(finding?.evidence.packages).toEqual([
      { name: 'left-pad', version: '1.3.0', message: 'use String.prototype.padStart instead' },
    ]);
  });

  test('DEPS-LIB-UNMAINTAINED: Scorecard Maintained at or below the floor', () => {
    const analysis = whiteboxAnalysis({
      npm: npmLookup({ facts: { 'left-pad@1.3.0': npmFacts() } }),
      scorecard: scorecardLookup({
        verdicts: {
          'https://github.com/left-pad/left-pad': maintenanceVerdict({ score: 0 }),
        },
      }),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-LIB-UNMAINTAINED');
    expect(finding).toBeDefined();
    expect(finding?.affected).toEqual(['left-pad@1.3.0']);
    expect(finding?.count).toBe(1);
  });

  test('DEPS-LIB-UNMAINTAINED: one repository publishing three packages is accepted by the catalog', () => {
    // Regression: `count` used to be the number of repositories while
    // `affected` listed the packages, which tripped the finding schema's
    // `affected.length <= count` invariant and silently dropped the finding.
    const repository = 'https://github.com/left-pad/left-pad';
    const analysis = whiteboxAnalysis({
      npm: npmLookup({
        facts: {
          'left-pad@1.3.0': npmFacts({ name: 'left-pad', version: '1.3.0' }),
          'right-pad@1.0.0': npmFacts({ name: 'right-pad', version: '1.0.0' }),
          'center-pad@2.0.0': npmFacts({ name: 'center-pad', version: '2.0.0' }),
        },
      }),
      scorecard: scorecardLookup({ verdicts: { [repository]: maintenanceVerdict({ score: 0 }) } }),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-LIB-UNMAINTAINED');
    expect(finding?.count).toBe(3);
    expect(finding?.affected).toEqual(['center-pad@2.0.0', 'left-pad@1.3.0', 'right-pad@1.0.0']);
    expect(finding?.evidence.repository_count).toBe(1);

    const { findings, rejected } = normalize([
      {
        schema: RAW_SCHEMA_VERSION,
        axis: 'DEPS',
        tool: { name: 'osv-scanner', version: '2.0.0' },
        target: { url: 'https://example.test/', mode: 'quick' },
        observations: toWhiteboxObservations(analysis),
      },
    ]);

    expect(rejected).toEqual([]);
    expect(findings.map((finding) => finding.id)).toContain('DEPS-LIB-UNMAINTAINED');
  });

  test('DEPS-LIB-UNMAINTAINED: a repository no package points back to is listed by its URL', () => {
    const repository = 'https://github.com/orphan/orphan';
    const analysis = whiteboxAnalysis({
      npm: npmLookup({ facts: {} }),
      scorecard: scorecardLookup({
        verdicts: { [repository]: maintenanceVerdict({ repository, score: 0 }) },
      }),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-LIB-UNMAINTAINED');
    expect(finding?.count).toBe(1);
    expect(finding?.affected).toEqual([repository]);
  });

  test('a Scorecard verdict above the floor is not reported', () => {
    const analysis = whiteboxAnalysis({
      scorecard: scorecardLookup({
        verdicts: { 'https://github.com/left-pad/left-pad': maintenanceVerdict({ score: 9 }) },
      }),
    });

    const ids = toWhiteboxObservations(analysis).map((o) => o.id);
    expect(ids).not.toContain('DEPS-LIB-UNMAINTAINED');
  });

  test('DEPS-RUNTIME-EOL: a declared runtime whose cycle has already ended', () => {
    const analysis = whiteboxAnalysis({
      repo: repoInspection({ runtimes: [runtimeDeclaration({ declared: '16.20.0' })] }),
      eol: eolLookup({
        products: {
          nodejs: {
            product: 'nodejs',
            cycles: [{ cycle: '16', eol: '2023-09-11', latest: '16.20.2' }],
          },
        },
      }),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-RUNTIME-EOL');
    expect(finding).toBeDefined();
    expect(finding?.affected).toEqual(['package.json']);
  });

  test('a runtime still inside its support window is not reported', () => {
    const analysis = whiteboxAnalysis({
      repo: repoInspection({ runtimes: [runtimeDeclaration({ declared: '22.11.0' })] }),
      eol: eolLookup({
        products: {
          nodejs: {
            product: 'nodejs',
            cycles: [{ cycle: '22', eol: '2027-04-30', latest: '22.11.0' }],
          },
        },
      }),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const ids = toWhiteboxObservations(analysis).map((o) => o.id);
    expect(ids).not.toContain('DEPS-RUNTIME-EOL');
  });

  test('DEPS-LINT-ERRORS: only counts error-level ESLint messages, not warnings', () => {
    const analysis = whiteboxAnalysis({
      repo: repoInspection({ root: '/repo' }),
      eslint: eslintScan({
        results: [
          {
            filePath: '/repo/src/index.ts',
            errorCount: 1,
            warningCount: 2,
            messages: [
              {
                ruleId: 'no-unused-vars',
                severity: 2,
                message: 'x is never used',
                line: 3,
                column: 1,
              },
              {
                ruleId: 'no-console',
                severity: 1,
                message: 'unexpected console',
                line: 5,
                column: 1,
              },
            ],
          },
        ],
      }),
    });

    const finding = toWhiteboxObservations(analysis).find((o) => o.id === 'DEPS-LINT-ERRORS');
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(1);
    expect(finding?.affected).toEqual(['src/index.ts']);
    expect(finding?.evidence.total_warnings).toBe(2);
  });

  test('a file with only warnings does not trigger DEPS-LINT-ERRORS', () => {
    const analysis = whiteboxAnalysis({
      eslint: eslintScan({
        results: [
          {
            filePath: '/repo/src/index.ts',
            errorCount: 0,
            warningCount: 3,
            messages: [],
          },
        ],
      }),
    });

    const ids = toWhiteboxObservations(analysis).map((o) => o.id);
    expect(ids).not.toContain('DEPS-LINT-ERRORS');
  });

  test('ESLint unavailable produces no lint observation, not an empty-clean one', () => {
    const analysis = whiteboxAnalysis({ eslint: eslintScan({ available: false }) });
    const ids = toWhiteboxObservations(analysis).map((o) => o.id);
    expect(ids).not.toContain('DEPS-LINT-ERRORS');
  });
});
