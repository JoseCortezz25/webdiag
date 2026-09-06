import { describe, expect, test } from 'bun:test';
import { scoreAxis } from '../../catalog/index.ts';
import { normalize } from '../normalize.ts';
import type { ProbeContext } from '../probe.ts';
import { parseRawDocument } from '../raw.ts';
import type { HeaderTranscript } from './curl.ts';
import { type SecurityProbeOptions, securityProbe } from './probe.ts';
import type { RobotsDecision } from './robots.ts';
import type { TestsslEntry } from './testssl.ts';
import { createThrottle } from './throttle.ts';

const QUICK: ProbeContext = { url: 'https://example.com/', mode: 'quick', pages: 1 };

const ALLOWED: RobotsDecision = {
  allowed: true,
  reason: 'robots.txt returned 404: no rules published, so nothing is disallowed.',
  status: 404,
  matchedAgent: undefined,
};

const BARE_RESPONSE: HeaderTranscript = {
  finalUrl: 'https://example.com/',
  blocks: [{ status: 200, headers: [['server', 'nginx/1.18.0']] }],
};

const EXPIRED_CERT: readonly TestsslEntry[] = [
  { id: 'TLS1_2', ip: 'x', port: '443', severity: 'OK', finding: 'offered' },
  {
    id: 'cert_expirationStatus <hostCert#1>',
    ip: 'x',
    port: '443',
    severity: 'CRITICAL',
    finding: 'expired',
  },
];

/** Every collaborator stubbed: no network, no subprocess, no `testssl.sh`. */
function options(overrides: SecurityProbeOptions = {}): SecurityProbeOptions {
  return {
    throttle: createThrottle({ minIntervalMs: 0 }),
    runner: () => Promise.resolve({ exitCode: 0, stdout: 'curl 8.7.1 (test)', stderr: '' }),
    robots: () => Promise.resolve(ALLOWED),
    headers: () => Promise.resolve(BARE_RESPONSE),
    locate: () => Promise.resolve('/opt/testssl.sh'),
    version: () => Promise.resolve('3.2.1'),
    testssl: () => Promise.resolve(EXPIRED_CERT),
    // Pinned: otherwise every note assertion below would depend on whether the
    // machine running the suite happens to have GNU `timeout` installed.
    timeoutBinary: () => true,
    ...overrides,
  };
}

function idsOf(document: Awaited<ReturnType<ReturnType<typeof securityProbe>['run']>>) {
  return document.observations.map((observation) => observation.id);
}

describe('security probe', () => {
  test('emits a document the raw schema accepts', async () => {
    const document = await securityProbe(options()).run(QUICK);

    expect(() => parseRawDocument(document)).not.toThrow();
    expect(document.axis).toBe('SEC');
  });

  test('combines the header findings and the TLS findings', async () => {
    const ids = idsOf(await securityProbe(options()).run(QUICK));

    expect(ids).toContain('SEC-CSP-MISSING');
    expect(ids).toContain('SEC-HSTS-MISSING');
    expect(ids).toContain('SEC-XFO-MISSING');
    expect(ids).toContain('SEC-SERVER-VERSION-DISCLOSED');
    expect(ids).toContain('SEC-TLS-EXPIRED');
  });

  test('SEC-TLS-EXPIRED fixes the SEC axis at 0 instead of averaging', () => {
    const { findings } = normalize([
      {
        schema: 'webdiag.raw/1',
        axis: 'SEC',
        tool: { name: 'webdiag-sec', version: 'test' },
        target: { url: 'https://example.com/', mode: 'quick' },
        observations: [
          {
            id: 'SEC-TLS-EXPIRED',
            confidence: 'high',
            count: 1,
            affected: ['example.com:443'],
            evidence: { status: 'expired' },
            remediation: 'Renovar el certificado.',
          },
        ],
      },
    ]);

    const score = scoreAxis('SEC', findings);

    expect(score.score).toBe(0);
    expect(score.zeroed).toBe(true);
    expect(score.coverPage).toEqual(['SEC-TLS-EXPIRED']);
  });

  test('records both tool versions, because meta.json has to carry them', async () => {
    const document = await securityProbe(options()).run(QUICK);

    expect(document.tool.version).toContain('curl 8.7.1');
    expect(document.tool.version).toContain('testssl.sh 3.2.1');
  });

  test('robots.txt is consulted before the headers are fetched', async () => {
    const order: string[] = [];

    await securityProbe(
      options({
        robots: () => {
          order.push('robots');
          return Promise.resolve(ALLOWED);
        },
        headers: () => {
          order.push('headers');
          return Promise.resolve(BARE_RESPONSE);
        },
      }),
    ).run(QUICK);

    expect(order).toEqual(['robots', 'headers']);
  });

  test('a disallowing robots.txt skips the headers and says so', async () => {
    const document = await securityProbe(
      options({
        robots: () =>
          Promise.resolve({
            allowed: false,
            reason: "robots.txt group '*' disallows /.",
            status: 200,
            matchedAgent: '*',
          }),
        headers: () => Promise.reject(new Error('robots.txt was ignored')),
      }),
    ).run(QUICK);

    expect(idsOf(document)).toEqual(['SEC-TLS-EXPIRED']);
    expect(document.notes?.join(' ')).toContain('robots.txt does not allow');
  });

  test('a missing testssl.sh degrades to headers only, naming what went unchecked', async () => {
    const document = await securityProbe(options({ locate: () => Promise.resolve(undefined) })).run(
      QUICK,
    );

    expect(idsOf(document)).not.toContain('SEC-TLS-EXPIRED');
    expect(idsOf(document)).toContain('SEC-CSP-MISSING');
    expect(document.notes?.join(' ')).toContain('SEC-TLS-EXPIRED');
    expect(document.tool.version).toContain('not installed');
  });

  test('a testssl.sh crash does not take the header findings with it', async () => {
    const document = await securityProbe(
      options({ testssl: () => Promise.reject(new Error('handshake timed out')) }),
    ).run(QUICK);

    expect(idsOf(document)).toContain('SEC-CSP-MISSING');
    expect(document.notes?.join(' ')).toContain('handshake timed out');
  });

  test('a curl failure does not take the TLS findings with it', async () => {
    const document = await securityProbe(
      options({ headers: () => Promise.reject(new Error('Could not resolve host')) }),
    ).run(QUICK);

    expect(idsOf(document)).toEqual(['SEC-TLS-EXPIRED']);
    expect(document.notes?.join(' ')).toContain('Could not resolve host');
  });

  test('a plain-HTTP target skips TLS rather than inventing a verdict', async () => {
    const document = await securityProbe(options()).run({
      ...QUICK,
      url: 'http://example.com/',
    });

    expect(idsOf(document)).not.toContain('SEC-TLS-EXPIRED');
    expect(document.notes?.join(' ')).toContain('there is no TLS to inspect');
  });

  test('a missing timeout(1) is noted, not left to silently gut the TLS scan', async () => {
    const document = await securityProbe(options({ timeoutBinary: () => false })).run(QUICK);

    expect(document.notes?.join('\n')).toContain('GNU `timeout` is not on PATH');
    // The scan still ran: dropping the flags is a degradation, not a skip.
    expect(idsOf(document)).toContain('SEC-TLS-EXPIRED');
  });

  test('a deep run declares that it still only looked at one URL', async () => {
    const document = await securityProbe(options()).run({ ...QUICK, mode: 'deep', pages: 5 });

    expect(document.notes?.[0]).toContain('only the target URL');
  });

  test('every request to a host goes through the throttle', async () => {
    const hosts: string[] = [];
    const inner = createThrottle({ minIntervalMs: 0 });

    const document = await securityProbe(
      options({
        throttle: {
          run(host, task) {
            hosts.push(host);
            return inner.run(host, task);
          },
        },
      }),
    ).run(QUICK);

    expect(hosts).toEqual(['example.com', 'example.com', 'example.com']);
    expect(document.axis).toBe('SEC');
  });
});
