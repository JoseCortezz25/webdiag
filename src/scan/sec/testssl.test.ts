import { describe, expect, test } from 'bun:test';
import { ACTIVE_CATALOG_IDS, isBlocking, requireEntry } from '../../catalog/index.ts';
import type { CommandRunner } from './curl.ts';
import {
  analyzeTestssl,
  daysToExpiry,
  EXPIRING_THRESHOLD_DAYS,
  parseTestsslJson,
  runTestssl,
  type TestsslEntry,
} from './testssl.ts';

const TARGET = 'example.com:443';

function entry(id: string, finding: string, severity = 'INFO'): TestsslEntry {
  return { id, ip: 'example.com/93.184.216.34', port: '443', severity, finding };
}

/** A modern configuration: everything weak declined, certificate healthy. */
const CLEAN: readonly TestsslEntry[] = [
  entry('SSLv2', 'not offered', 'OK'),
  entry('SSLv3', 'not offered', 'OK'),
  entry('TLS1', 'not offered', 'OK'),
  entry('TLS1_1', 'not offered', 'OK'),
  entry('TLS1_2', 'offered', 'OK'),
  entry('TLS1_3', 'offered with final', 'OK'),
  entry('cipherlist_NULL', 'not offered', 'OK'),
  entry('cipherlist_3DES_IDEA', 'not offered', 'OK'),
  entry('cert_expirationStatus <hostCert#1>', '312 >= 60 days', 'OK'),
  entry('cert_notAfter <hostCert#1>', '2027-07-14 12:00', 'OK'),
];

function idsFor(entries: readonly TestsslEntry[]): readonly string[] {
  return analyzeTestssl(entries, TARGET).observations.map((observation) => observation.id);
}

describe('parseTestsslJson', () => {
  test('reads the flat array testssl.sh --jsonfile writes', () => {
    const parsed = parseTestsslJson(
      '[{"id":"TLS1","ip":"a/1.2.3.4","port":"443","severity":"LOW","finding":"offered (deprecated)"}]',
    );

    expect(parsed).toEqual([
      {
        id: 'TLS1',
        ip: 'a/1.2.3.4',
        port: '443',
        severity: 'LOW',
        finding: 'offered (deprecated)',
      },
    ]);
  });

  test('drops rows that are not findings instead of failing the whole scan', () => {
    expect(parseTestsslJson('[{"id":"TLS1","finding":"offered"},{"nope":1},null]')).toHaveLength(1);
  });

  test('rejects output that is not an array', () => {
    expect(() => parseTestsslJson('{"id":"TLS1"}')).toThrow(/not an array/);
  });
});

describe('daysToExpiry', () => {
  test('reads the day count out of the status line', () => {
    expect(daysToExpiry('expires < 30 days (12)')).toBe(12);
  });

  test('returns undefined when there is no count to read', () => {
    expect(daysToExpiry('312 >= 60 days')).toBeUndefined();
  });
});

describe('analyzeTestssl', () => {
  test('reports nothing on a modern configuration', () => {
    expect(idsFor(CLEAN)).toEqual([]);
  });

  test('"not offered" is not "offered": a clean scan must not read as weak', () => {
    expect(idsFor([entry('SSLv2', 'not offered', 'OK')])).not.toContain('SEC-TLS-WEAK');
  });

  test('SEC-TLS-WEAK counts every deprecated protocol and cipher category', () => {
    const weak = analyzeTestssl(
      [
        ...CLEAN.filter(
          (candidate) => !candidate.id.startsWith('TLS1') || candidate.id === 'TLS1_2',
        ),
        entry('TLS1', 'offered (deprecated)', 'LOW'),
        entry('TLS1_1', 'offered (deprecated)', 'LOW'),
        entry('cipherlist_3DES_IDEA', 'offered', 'MEDIUM'),
      ],
      TARGET,
    ).observations.find((observation) => observation.id === 'SEC-TLS-WEAK');

    expect(weak?.count).toBe(3);
    expect(weak?.evidence.protocols).toEqual(['TLS 1.0', 'TLS 1.1']);
    expect(weak?.evidence.cipher_suites).toEqual(['3DES / IDEA']);
  });

  test('SEC-TLS-EXPIRING at the catalog threshold of 30 days', () => {
    const entries = [
      ...CLEAN.filter((candidate) => !candidate.id.startsWith('cert_expirationStatus')),
      entry(
        'cert_expirationStatus <hostCert#1>',
        `expires < 60 days (${EXPIRING_THRESHOLD_DAYS})`,
        'MEDIUM',
      ),
    ];

    expect(idsFor(entries)).toContain('SEC-TLS-EXPIRING');
  });

  test('one day past the threshold is not a finding', () => {
    const entries = [
      ...CLEAN.filter((candidate) => !candidate.id.startsWith('cert_expirationStatus')),
      entry(
        'cert_expirationStatus <hostCert#1>',
        `expires < 60 days (${EXPIRING_THRESHOLD_DAYS + 1})`,
        'MEDIUM',
      ),
    ];

    expect(idsFor(entries)).not.toContain('SEC-TLS-EXPIRING');
  });

  test('SEC-TLS-EXPIRED when testssl.sh says the certificate expired', () => {
    const entries = [
      ...CLEAN.filter((candidate) => !candidate.id.startsWith('cert_expirationStatus')),
      entry('cert_expirationStatus <hostCert#1>', 'expired', 'CRITICAL'),
    ];

    expect(idsFor(entries)).toEqual(['SEC-TLS-EXPIRED']);
  });

  test('SEC-TLS-EXPIRED is blocking and critical, so it fixes the SEC axis at 0', () => {
    expect(isBlocking('SEC-TLS-EXPIRED')).toBe(true);
    expect(requireEntry('SEC-TLS-EXPIRED').baseSeverity).toBe('critical');
  });

  test('an expired certificate outranks a healthy second chain', () => {
    const entries = [
      entry('cert_expirationStatus <hostCert#1>', 'expired', 'CRITICAL'),
      entry('cert_expirationStatus <hostCert#2>', '312 >= 60 days', 'OK'),
      entry('TLS1_2', 'offered', 'OK'),
    ];

    expect(idsFor(entries)).toEqual(['SEC-TLS-EXPIRED']);
  });

  test('the soonest expiry wins when several certificates are served', () => {
    const entries = [
      entry('TLS1_2', 'offered', 'OK'),
      entry('cert_expirationStatus <hostCert#1>', 'expires < 60 days (25)', 'MEDIUM'),
      entry('cert_expirationStatus <hostCert#2>', 'expires < 60 days (9)', 'HIGH'),
    ];

    const expiring = analyzeTestssl(entries, TARGET).observations.find(
      (observation) => observation.id === 'SEC-TLS-EXPIRING',
    );

    expect(expiring?.evidence.days_to_expiry).toBe(9);
  });

  test('an empty scan produces no findings and two explicit notes', () => {
    const analysis = analyzeTestssl([], TARGET);

    expect(analysis.observations).toEqual([]);
    expect(analysis.notes).toHaveLength(2);
  });

  test('a fatal row from testssl.sh becomes a note, not a silent gap', () => {
    const analysis = analyzeTestssl([entry('scanProblem', 'Can not connect', 'FATAL')], TARGET);

    expect(analysis.notes[0]).toContain('Can not connect');
  });

  test('only claims IDs a new run is allowed to emit', () => {
    const active = new Set(ACTIVE_CATALOG_IDS);
    const entries = [
      entry('TLS1', 'offered (deprecated)', 'LOW'),
      entry('cert_expirationStatus <hostCert#1>', 'expired', 'CRITICAL'),
    ];

    for (const observation of analyzeTestssl(entries, TARGET).observations) {
      expect(active.has(observation.id)).toBe(true);
    }
  });
});

/**
 * `--connect-timeout` and `--openssl-timeout` are the two flags that can cost
 * this probe its entire TLS half. `testssl.sh` refuses to start when either is
 * passed without GNU `timeout` on PATH, and it refuses *quietly*: exit 0, a JSON
 * file holding one `scanProblem` row, and an axis that has silently stopped
 * measuring TLS. macOS ships no `timeout`, so that is the default there.
 */
describe('runTestssl', () => {
  /** Answers like `testssl.sh`: writes the JSON file the run reads back. */
  function recordingRunner(): CommandRunner & { argv: string[] } {
    const argv: string[] = [];

    const runner: CommandRunner = async (command) => {
      argv.push(...command);
      const jsonPath = command[command.indexOf('--jsonfile') + 1] ?? '';
      await Bun.write(jsonPath, JSON.stringify([{ id: 'TLS1', finding: 'not offered' }]));
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    return Object.assign(runner, { argv });
  }

  test('passes the per-connection timeouts when timeout(1) is available', async () => {
    const runner = recordingRunner();

    await runTestssl({
      host: 'example.com',
      port: 443,
      path: '/bin/testssl.sh',
      runner,
      connectTimeouts: true,
    });

    expect(runner.argv).toContain('--connect-timeout');
    expect(runner.argv).toContain('--openssl-timeout');
  });

  test('drops them when it is not, rather than losing the whole TLS scan', async () => {
    const runner = recordingRunner();
    const entries = await runTestssl({
      host: 'example.com',
      port: 443,
      path: '/bin/testssl.sh',
      runner,
      connectTimeouts: false,
    });

    expect(runner.argv).not.toContain('--connect-timeout');
    expect(runner.argv).not.toContain('--openssl-timeout');
    expect(runner.argv).toContain('example.com:443');
    expect(entries.map((entry) => entry.id)).toEqual(['TLS1']);
  });

  test('a run that writes no JSON file is an error, whatever it exited with', async () => {
    const runner: CommandRunner = () =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: 'Fatal error: no openssl' });

    expect(
      runTestssl({ host: 'example.com', port: 443, path: '/bin/testssl.sh', runner }),
    ).rejects.toThrow('no openssl');
  });
});
