import { describe, expect, test } from 'bun:test';
import { ACTIVE_CATALOG_IDS } from '../../catalog/index.ts';
import { parseRawDocument, RAW_SCHEMA_VERSION } from '../raw.ts';
import type { HeaderBlock } from './curl.ts';
import { analyzeHeaders, cookieProblems, parseCsp, parseSetCookie } from './headers.ts';

function block(headers: readonly (readonly [string, string])[], status = 200): HeaderBlock {
  return { status, headers };
}

function idsFor(headers: readonly (readonly [string, string])[]): readonly string[] {
  return analyzeHeaders({
    finalUrl: 'https://example.com/',
    blocks: [block(headers)],
  }).observations.map((observation) => observation.id);
}

/** A site with nothing to report, so each test can add exactly one problem. */
const HARDENED: readonly (readonly [string, string])[] = [
  ['content-security-policy', "default-src 'self'; frame-ancestors 'self'"],
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-frame-options', 'SAMEORIGIN'],
  ['server', 'cloudflare'],
];

describe('parseSetCookie', () => {
  test('reads the name and the attributes that matter', () => {
    expect(parseSetCookie('sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax')).toEqual({
      name: 'sid',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
  });

  test('rejects a header with no cookie name', () => {
    expect(parseSetCookie('   ; Secure')).toBeUndefined();
  });
});

describe('cookieProblems', () => {
  test('finds nothing wrong with a hardened cookie', () => {
    const cookie = { name: 'sid', secure: true, httpOnly: true, sameSite: 'lax' };

    expect(cookieProblems(cookie, true)).toEqual([]);
  });

  test('does not ask for Secure over plain HTTP', () => {
    const cookie = { name: 'sid', secure: false, httpOnly: true, sameSite: 'lax' };

    expect(cookieProblems(cookie, false)).toEqual([]);
  });

  test('flags SameSite=None without Secure even though SameSite is present', () => {
    const cookie = { name: 'sid', secure: false, httpOnly: true, sameSite: 'none' };

    expect(cookieProblems(cookie, false)).toEqual(['SameSite=None sin Secure']);
  });
});

describe('parseCsp', () => {
  test('splits directives and lowercases their names', () => {
    expect(parseCsp("Default-Src 'self'; script-src 'unsafe-inline' cdn.example")).toEqual([
      { name: 'default-src', values: ["'self'"] },
      { name: 'script-src', values: ["'unsafe-inline'", 'cdn.example'] },
    ]);
  });
});

describe('analyzeHeaders', () => {
  test('reports nothing on a hardened response', () => {
    expect(idsFor(HARDENED)).toEqual([]);
  });

  test('SEC-CSP-MISSING when there is no policy at all', () => {
    const headers = HARDENED.filter(([name]) => name !== 'content-security-policy');

    expect(idsFor(headers)).toContain('SEC-CSP-MISSING');
  });

  test('a report-only CSP is still a missing CSP, and says so in evidence', () => {
    const headers = [
      ...HARDENED.filter(([name]) => name !== 'content-security-policy'),
      ['content-security-policy-report-only', "default-src 'self'"] as const,
    ];

    const missing = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [block(headers)],
    }).observations.find((observation) => observation.id === 'SEC-CSP-MISSING');

    expect(missing?.evidence.report_only_present).toBe(true);
  });

  test("SEC-CSP-UNSAFE names the directives carrying 'unsafe-*'", () => {
    const headers = [
      ...HARDENED.filter(([name]) => name !== 'content-security-policy'),
      [
        'content-security-policy',
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-eval'; frame-ancestors 'self'",
      ] as const,
    ];

    const unsafe = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [block(headers)],
    }).observations.find((observation) => observation.id === 'SEC-CSP-UNSAFE');

    expect(unsafe?.count).toBe(2);
    expect(unsafe?.evidence.directives).toEqual([
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-eval'",
    ]);
  });

  test('a substring like unsafe-inlined does not count as a source expression', () => {
    const headers = [
      ...HARDENED.filter(([name]) => name !== 'content-security-policy'),
      ['content-security-policy', "default-src 'self' https://unsafe-inline.example"] as const,
    ];

    expect(idsFor(headers)).not.toContain('SEC-CSP-UNSAFE');
  });

  test('SEC-HSTS-MISSING when the header is absent', () => {
    const headers = HARDENED.filter(([name]) => name !== 'strict-transport-security');

    expect(idsFor(headers)).toContain('SEC-HSTS-MISSING');
  });

  test('max-age=0 counts as missing: it switches HSTS off', () => {
    const headers = [
      ...HARDENED.filter(([name]) => name !== 'strict-transport-security'),
      ['strict-transport-security', 'max-age=0'] as const,
    ];

    expect(idsFor(headers)).toContain('SEC-HSTS-MISSING');
  });

  test('HSTS is not evaluated over plain HTTP, and the run says why', () => {
    const analysis = analyzeHeaders({
      finalUrl: 'http://example.com/',
      blocks: [block([['x-frame-options', 'DENY']])],
    });

    expect(analysis.observations.map((observation) => observation.id)).not.toContain(
      'SEC-HSTS-MISSING',
    );
    expect(analysis.notes.join(' ')).toContain('not HTTPS');
  });

  test('CSP frame-ancestors satisfies the clickjacking check without X-Frame-Options', () => {
    const headers = HARDENED.filter(([name]) => name !== 'x-frame-options');

    expect(idsFor(headers)).not.toContain('SEC-XFO-MISSING');
  });

  test('SEC-XFO-MISSING when neither X-Frame-Options nor frame-ancestors is set', () => {
    const headers = [
      ...HARDENED.filter(
        ([name]) => name !== 'x-frame-options' && name !== 'content-security-policy',
      ),
      ['content-security-policy', "default-src 'self'"] as const,
    ];

    expect(idsFor(headers)).toContain('SEC-XFO-MISSING');
  });

  test('a versionless Server header discloses nothing', () => {
    expect(idsFor(HARDENED)).not.toContain('SEC-SERVER-VERSION-DISCLOSED');
  });

  test('SEC-SERVER-VERSION-DISCLOSED counts every disclosing header', () => {
    const headers = [
      ...HARDENED.filter(([name]) => name !== 'server'),
      ['server', 'nginx/1.18.0'] as const,
      ['x-powered-by', 'PHP/8.1.2'] as const,
    ];

    const disclosure = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [block(headers)],
    }).observations.find((observation) => observation.id === 'SEC-SERVER-VERSION-DISCLOSED');

    expect(disclosure?.count).toBe(2);
    expect(disclosure?.confidence).toBe('high');
  });

  test('cookies are collected from every hop, not only the final response', () => {
    const analysis = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [
        block([['set-cookie', 'session=1; Path=/']], 302),
        block([...HARDENED, ['set-cookie', 'ok=1; Secure; HttpOnly; SameSite=Lax']]),
      ],
    });

    const cookies = analysis.observations.find(
      (observation) => observation.id === 'SEC-COOKIE-INSECURE',
    );

    expect(cookies?.affected).toEqual(['session']);
    expect(cookies?.confidence).toBe('medium');
  });

  test('never claims more affected entries than the count it reports', () => {
    const analysis = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [
        block([
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
          ['set-cookie', 'a=3'],
        ]),
      ],
    });

    for (const observation of analysis.observations) {
      expect(observation.affected.length).toBeLessThanOrEqual(observation.count);
    }
  });

  test('says so when curl returned no headers at all', () => {
    const analysis = analyzeHeaders({ finalUrl: 'https://example.com/', blocks: [] });

    expect(analysis.observations).toEqual([]);
    expect(analysis.notes).toHaveLength(1);
  });

  test('every observation is a catalog ID a new run may emit', () => {
    const active = new Set(ACTIVE_CATALOG_IDS);
    const analysis = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [
        block([
          ['content-security-policy-report-only', "script-src 'unsafe-eval'"],
          ['server', 'Apache/2.4.41'],
          ['set-cookie', 'sid=1'],
        ]),
      ],
    });

    expect(analysis.observations.length).toBeGreaterThan(0);

    for (const observation of analysis.observations) {
      expect(active.has(observation.id)).toBe(true);
    }
  });

  test('produces a document the raw schema accepts', () => {
    const analysis = analyzeHeaders({
      finalUrl: 'https://example.com/',
      blocks: [block([['server', 'nginx/1.18.0']])],
    });

    expect(() =>
      parseRawDocument({
        schema: RAW_SCHEMA_VERSION,
        axis: 'SEC',
        tool: { name: 'webdiag-sec', version: '0.1.0' },
        target: { url: 'https://example.com/', mode: 'quick' },
        observations: analysis.observations,
        notes: analysis.notes,
      }),
    ).not.toThrow();
  });
});
