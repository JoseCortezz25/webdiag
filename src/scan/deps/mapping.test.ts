import { describe, expect, test } from 'bun:test';
import { isCatalogId } from '../../catalog/index.ts';
import { retireVulnerability } from './fixture.ts';
import {
  advisoryId,
  classify,
  confidenceFor,
  cvesOf,
  EPSS_HIGH_THRESHOLD,
  isMajorBehind,
  majorOf,
  npmNameFor,
} from './mapping.ts';

describe('classify', () => {
  test('every ID it can produce is published in the catalog', () => {
    const ids = [
      classify({ severity: 'critical', kev: true, epss: 0.9 }).id,
      classify({ severity: 'critical', kev: false, epss: undefined }).id,
      classify({ severity: 'high', kev: false, epss: undefined }).id,
      classify({ severity: 'medium', kev: false, epss: 0.5 }).id,
      classify({ severity: 'medium', kev: false, epss: undefined }).id,
      classify({ severity: 'low', kev: false, epss: undefined }).id,
    ];

    expect(ids.every(isCatalogId)).toBe(true);
  });

  test('a KEV hit outranks the CVSS score, however low it is', () => {
    expect(classify({ severity: 'low', kev: true, epss: undefined })).toEqual({
      id: 'DEPS-VULN-KEV',
      reason: 'kev',
    });
  });

  test('maps CVSS bands onto their own IDs', () => {
    expect(classify({ severity: 'critical', kev: false, epss: undefined }).id).toBe(
      'DEPS-VULN-CRITICAL',
    );
    expect(classify({ severity: 'high', kev: false, epss: undefined }).id).toBe('DEPS-VULN-HIGH');
    expect(classify({ severity: 'medium', kev: false, epss: undefined }).id).toBe(
      'DEPS-VULN-MEDIUM',
    );
  });

  test('a high EPSS promotes a moderate CVSS, and only a moderate one', () => {
    expect(classify({ severity: 'medium', kev: false, epss: EPSS_HIGH_THRESHOLD }).id).toBe(
      'DEPS-VULN-HIGH-EPSS',
    );
    // Already high: the catalog reserves the EPSS ID for the understated case.
    expect(classify({ severity: 'high', kev: false, epss: 0.97 }).id).toBe('DEPS-VULN-HIGH');
  });

  test('an EPSS just under the threshold changes nothing', () => {
    expect(
      classify({ severity: 'medium', kev: false, epss: EPSS_HIGH_THRESHOLD - 0.0001 }).id,
    ).toBe('DEPS-VULN-MEDIUM');
  });

  test('a low advisory is kept, with its severity stated rather than dropped', () => {
    expect(classify({ severity: 'low', kev: false, epss: undefined })).toEqual({
      id: 'DEPS-VULN-MEDIUM',
      reason: 'cvss-low',
      severity: 'low',
    });
    expect(classify({ severity: 'none', kev: false, epss: undefined }).severity).toBe('low');
  });
});

describe('confidenceFor', () => {
  test('only a byte-exact match is high: a vendored copy may carry a backport', () => {
    expect(confidenceFor('hash')).toBe('high');
    expect(confidenceFor('filecontent')).toBe('medium');
    expect(confidenceFor('filename')).toBe('medium');
    expect(confidenceFor('unknown')).toBe('medium');
  });
});

describe('version comparison', () => {
  test('reads the leading major, and refuses what is not a version', () => {
    expect(majorOf('3.4.1')).toBe(3);
    expect(majorOf('v10.0.0-beta.2')).toBe(10);
    expect(majorOf('unknown')).toBeUndefined();
  });

  test('outdated means at least one major behind, never a minor or a patch', () => {
    expect(isMajorBehind('2.9.9', '3.0.0')).toBe(true);
    expect(isMajorBehind('3.4.1', '3.7.1')).toBe(false);
    expect(isMajorBehind('3.7.1', '3.4.1')).toBe(false);
    expect(isMajorBehind('3.4.1', 'unknown')).toBe(false);
  });
});

describe('advisory identifiers', () => {
  test('deduplicates and orders the CVEs', () => {
    const vulnerability = retireVulnerability({
      identifiers: { CVE: ['CVE-2020-11023', 'CVE-2020-11022', 'CVE-2020-11023'] },
    });

    expect(cvesOf(vulnerability)).toEqual(['CVE-2020-11022', 'CVE-2020-11023']);
  });

  test('falls back to the GitHub advisory when there is no CVE', () => {
    const vulnerability = retireVulnerability({ identifiers: { githubID: 'GHSA-gxr4-xjj5-5px2' } });

    expect(advisoryId(vulnerability)).toBe('GHSA-gxr4-xjj5-5px2');
  });

  test('prefers the npm name retire.js reports over the component name', () => {
    expect(npmNameFor({ component: 'angular.js', npmname: 'angular' })).toBe('angular');
    expect(npmNameFor({ component: 'lodash' })).toBe('lodash');
  });
});
