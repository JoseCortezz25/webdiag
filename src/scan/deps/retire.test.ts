import { describe, expect, test } from 'bun:test';
import { parseRetireReport, RETIRE_VERSION, scanWithRetire } from './retire.ts';
import { withWorkspace } from './workspace.ts';

/** A banner is all retire.js needs, and all a minified vendor bundle keeps. */
const VULNERABLE_JQUERY =
  '/*! jQuery v3.4.1 | (c) JS Foundation and other contributors | jquery.org/license */\nwindow.jQuery=function(){};\n';

describe('parseRetireReport', () => {
  test('fills in what an older report leaves out', () => {
    const report = parseRetireReport({ version: '5.7.0' });

    expect(report).toEqual({
      version: '5.7.0',
      data: [],
      messages: [],
      errors: [],
      vulnerabilityRepositories: [],
    });
  });

  test('keeps the fields the mapping decides on', () => {
    const report = parseRetireReport({
      version: '5.7.0',
      data: [
        {
          file: '/tmp/x/000-vendor.js',
          results: [
            {
              component: 'jquery',
              version: '3.4.1',
              npmname: 'jquery',
              detection: 'filecontent',
              vulnerabilities: [
                {
                  below: '3.5.0',
                  severity: 'medium',
                  identifiers: { CVE: ['CVE-2020-11022'] },
                },
              ],
            },
          ],
        },
      ],
    });

    const [result] = report.data[0]?.results ?? [];
    expect(result?.version).toBe('3.4.1');
    expect(result?.vulnerabilities[0]?.severity).toBe('medium');
    expect(result?.vulnerabilities[0]?.below).toBe('3.5.0');
  });

  test('an unrated advisory is kept rather than dropped', () => {
    const report = parseRetireReport({
      version: '5.7.0',
      data: [
        {
          file: '/tmp/x/000-vendor.js',
          results: [{ component: 'x', version: '1.0.0', vulnerabilities: [{ identifiers: {} }] }],
        },
      ],
    });

    expect(report.data[0]?.results[0]?.vulnerabilities[0]?.severity).toBe('none');
    expect(report.data[0]?.results[0]?.detection).toBe('unknown');
  });

  test('refuses a report it cannot read instead of returning an empty axis', () => {
    expect(() => parseRetireReport({ data: [] })).toThrow();
  });
});

/**
 * The real subprocess. It downloads the advisory repository on a cold cache, so
 * it is the one test here that needs the network — which is also what makes it
 * worth having: it proves the CLI contract this build depends on still holds.
 */
describe('scanWithRetire', () => {
  test('finds a known vulnerable library in a directory of bundles', async () => {
    const report = await withWorkspace(async (workspace) => {
      await Bun.write(`${workspace.directory}/000-vendor.js`, VULNERABLE_JQUERY);
      return scanWithRetire(workspace.directory);
    });

    expect(report.version).toBe(RETIRE_VERSION);

    const result = report.data[0]?.results[0];
    expect(result?.component).toBe('jquery');
    expect(result?.version).toBe('3.4.1');
    expect(result?.vulnerabilities.length).toBeGreaterThan(0);
    expect(result?.vulnerabilities.flatMap((entry) => entry.identifiers.CVE ?? [])).toContain(
      'CVE-2020-11022',
    );
  }, 180_000);

  test('reports the libraries it recognised even when they are clean', async () => {
    const report = await withWorkspace(async (workspace) => {
      // Nothing recognisable: `--verbose` must still produce a readable report.
      await Bun.write(`${workspace.directory}/000-app.js`, 'export const total = 1;\n');
      return scanWithRetire(workspace.directory);
    });

    expect(report.errors).toEqual([]);
    expect(report.data.flatMap((file) => file.results)).toEqual([]);
  }, 180_000);
});
