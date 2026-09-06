/**
 * The TLS half of the security probe: `testssl.sh` (spec §5.1).
 *
 * `testssl.sh` is an external, unpinnable-by-`bun install` dependency, and this
 * module is built around that fact rather than in spite of it. Three consequences
 * shape the code:
 *
 *  - **Absence is a normal outcome, not an error.** `locateTestssl` returning
 *    `undefined` degrades the probe to headers-only and says so in a note. A run
 *    where the SEC axis is silently missing a third of its checks would be worse
 *    than one that admits it.
 *  - **The verdict is read from the tool's own words, never recomputed.** The
 *    expiry state comes from `cert_expirationStatus`, not from comparing
 *    `cert_notAfter` against our clock. Clocks would make `findings.json`
 *    time-dependent, and the spec's "¿mejoró desde la última auditoría?" promise
 *    rests on it not being.
 *  - **The whole scan is under a wall-clock ceiling.** A TLS handshake against an
 *    unresponsive host can block for a very long time; a `quick` run is budgeted
 *    at 40–60s per axis (spec §5.2), so the subprocess is killed rather than
 *    waited on.
 */
import { tmpdir } from 'node:os';
import type { RawObservation } from '../raw.ts';
import { type CommandRunner, runCommand } from './curl.ts';

/** One row of `testssl.sh --jsonfile`, which is a flat array of these. */
export type TestsslEntry = {
  readonly id: string;
  readonly ip: string;
  readonly port: string;
  readonly severity: string;
  readonly finding: string;
};

export const DEFAULT_TESTSSL_TIMEOUT_MS = 300_000;

/** Protocols no current configuration should still offer. */
const WEAK_PROTOCOLS: Readonly<Record<string, string>> = {
  SSLv2: 'SSLv2',
  SSLv3: 'SSLv3',
  TLS1: 'TLS 1.0',
  TLS1_1: 'TLS 1.1',
};

/** `testssl.sh` cipher categories that are a finding by themselves. */
const WEAK_CIPHERLISTS: Readonly<Record<string, string>> = {
  cipherlist_NULL: 'cifrados NULL (sin cifrado)',
  cipherlist_aNULL: 'cifrados anonimos (sin autenticacion)',
  cipherlist_EXPORT: 'cifrados EXPORT',
  cipherlist_LOW: 'cifrados LOW (64/56 bit)',
  cipherlist_3DES_IDEA: '3DES / IDEA',
  cipherlist_OBSOLETED: 'cifrados obsoletos',
};

/** The catalogue's threshold for `SEC-TLS-EXPIRING`: "menos de 30 días". */
export const EXPIRING_THRESHOLD_DAYS = 30;

/**
 * SGR escape sequences. Built from a char code rather than written as a literal
 * so this source file stays free of control characters. `--color 0` suppresses
 * them during a scan, but `--version` prints them regardless.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/**
 * Finds `testssl.sh`, in the order an operator would expect: an explicit
 * override, then whatever is on `PATH`, then the copy `bun run install:testssl`
 * drops in `vendor/`.
 */
export async function locateTestssl(): Promise<string | undefined> {
  const override = Bun.env.WEBDIAG_TESTSSL;

  if (override !== undefined && override !== '' && (await exists(override))) {
    return override;
  }

  const onPath = Bun.which('testssl.sh');

  if (onPath !== null) {
    return onPath;
  }

  const vendored = `${import.meta.dir}/../../../vendor/testssl.sh/testssl.sh`;

  return (await exists(vendored)) ? vendored : undefined;
}

/** `version 3.2.1 from https://testssl.sh/` → `3.2.1`. Recorded in `meta.json`. */
export async function testsslVersion(
  path: string,
  runner: CommandRunner = runCommand,
): Promise<string | undefined> {
  try {
    const result = await runner([path, '--version'], { timeoutMs: 30_000 });
    const match = /version\s+(\d\S*)\s+from/i.exec(stripAnsi(result.stdout));
    return match?.[1];
  } catch {
    return undefined;
  }
}

function isEntry(value: unknown): value is TestsslEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.id === 'string' && typeof candidate.finding === 'string';
}

export function parseTestsslJson(text: string): readonly TestsslEntry[] {
  const parsed: unknown = JSON.parse(text);

  if (!Array.isArray(parsed)) {
    throw new Error('testssl.sh JSON output is not an array.');
  }

  return parsed.filter(isEntry).map((entry) => ({
    id: entry.id,
    ip: typeof entry.ip === 'string' ? entry.ip : '',
    port: typeof entry.port === 'string' ? entry.port : '',
    severity: typeof entry.severity === 'string' ? entry.severity : 'INFO',
    finding: entry.finding,
  }));
}

export type TestsslRun = {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
  /** Overrides the `timeout(1)` probe. Injected so the flag set is testable. */
  readonly connectTimeouts?: boolean;
};

/**
 * Whether `testssl.sh` may be given `--connect-timeout` / `--openssl-timeout`.
 *
 * It may not, unless GNU `timeout` is on `PATH` under exactly that name: passing
 * either flag without it makes `testssl.sh` `fatal` out *before running a single
 * check*, and it still exits 0 having written a JSON file whose only content is
 * the complaint. That failure mode is silent — the axis simply loses its three
 * TLS findings — and it is the default on macOS, where coreutils is not
 * installed and Homebrew's copy is called `gtimeout`.
 *
 * Dropping the flags costs nothing that matters: they bound one connection,
 * while `runCommand`'s `timeoutMs` bounds the whole subprocess, and that is the
 * ceiling the spec's per-axis budget actually needs.
 */
export function hasTimeoutBinary(): boolean {
  return Bun.which('timeout') !== null;
}

/**
 * Runs the scan.
 *
 * The flag set is the minimum that answers the three catalogue IDs this probe
 * owns: `-p` for protocols, `-s` for the cipher categories, `-S` for the
 * certificate. A full `testssl.sh` run tests far more and takes far longer, and
 * everything extra would be data nothing reads. `--ip one` halves the work on
 * multi-homed hosts, which for a CDN answer the same configuration twice.
 */
export async function runTestssl(options: TestsslRun): Promise<readonly TestsslEntry[]> {
  const runner = options.runner ?? runCommand;
  const jsonPath = `${tmpdir()}/webdiag-testssl-${crypto.randomUUID()}.json`;
  const timeouts = options.connectTimeouts ?? hasTimeoutBinary();

  const result = await runner(
    [
      options.path,
      '--quiet',
      '--color',
      '0',
      '--warnings',
      'batch',
      '--ip',
      'one',
      ...(timeouts ? ['--connect-timeout', '10', '--openssl-timeout', '10'] : []),
      '--jsonfile',
      jsonPath,
      '-p',
      '-s',
      '-S',
      `${options.host}:${options.port}`,
    ],
    { timeoutMs: options.timeoutMs ?? DEFAULT_TESTSSL_TIMEOUT_MS },
  );

  const file = Bun.file(jsonPath);

  // The exit code is not the signal here: `testssl.sh` can finish a useful scan
  // and still exit non-zero. The JSON file is the contract.
  if (!(await file.exists())) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new Error(
      `testssl.sh wrote no JSON output (exit code ${result.exitCode}): ${detail.slice(0, 400)}`,
    );
  }

  try {
    return parseTestsslJson(await file.text());
  } finally {
    await file.delete().catch(() => undefined);
  }
}

function offered(entry: TestsslEntry): boolean {
  return /^offered/i.test(entry.finding.trim());
}

export type TestsslAnalysis = {
  readonly observations: readonly RawObservation[];
  readonly notes: readonly string[];
};

/** Days left, read out of `expires < N days (D)`. */
export function daysToExpiry(finding: string): number | undefined {
  const match = /\((-?\d+)\)/.exec(finding);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function weakness(entries: readonly TestsslEntry[], target: string): RawObservation | undefined {
  const protocols = entries
    .filter((entry) => WEAK_PROTOCOLS[entry.id] !== undefined && offered(entry))
    .map((entry) => WEAK_PROTOCOLS[entry.id] ?? entry.id);

  const ciphers = entries
    .filter((entry) => WEAK_CIPHERLISTS[entry.id] !== undefined && offered(entry))
    .map((entry) => WEAK_CIPHERLISTS[entry.id] ?? entry.id);

  if (protocols.length === 0 && ciphers.length === 0) {
    return undefined;
  }

  return {
    id: 'SEC-TLS-WEAK',
    confidence: 'high',
    count: protocols.length + ciphers.length,
    affected: [target],
    evidence: {
      protocols,
      cipher_suites: ciphers,
    },
    remediation:
      'Dejar solo TLS 1.2 y TLS 1.3, y retirar los conjuntos de cifrado NULL, EXPORT, LOW, 3DES/IDEA y RC4 de la configuracion del servidor o del CDN.',
  };
}

/**
 * Reads the certificate verdict.
 *
 * Expired wins over expiring even when several certificates are served (an RSA
 * and an ECC chain is the common case): one expired certificate is enough to
 * interpose a browser warning, so reporting the healthier one would be wrong.
 */
function expiry(entries: readonly TestsslEntry[], target: string): RawObservation | undefined {
  const statuses = entries.filter((entry) => entry.id.startsWith('cert_expirationStatus'));
  const notAfter = entries
    .filter((entry) => entry.id.startsWith('cert_notAfter'))
    .map((entry) => entry.finding);

  if (statuses.some((entry) => /^expired/i.test(entry.finding.trim()))) {
    return {
      id: 'SEC-TLS-EXPIRED',
      confidence: 'high',
      count: 1,
      affected: [target],
      evidence: {
        status: 'expired',
        not_after: notAfter,
        source: 'testssl.sh cert_expirationStatus',
      },
      remediation:
        'Renovar el certificado y desplegarlo de inmediato: mientras siga vencido, todo navegador interpone una advertencia a pantalla completa antes del sitio.',
      title: 'El certificado TLS esta vencido',
    };
  }

  const remaining = statuses
    .map((entry) => daysToExpiry(entry.finding))
    .filter((days): days is number => days !== undefined);

  const soonest = remaining.length === 0 ? undefined : Math.min(...remaining);

  if (soonest === undefined || soonest > EXPIRING_THRESHOLD_DAYS) {
    return undefined;
  }

  return {
    id: 'SEC-TLS-EXPIRING',
    confidence: 'high',
    count: 1,
    affected: [target],
    evidence: {
      days_to_expiry: soonest,
      threshold_days: EXPIRING_THRESHOLD_DAYS,
      not_after: notAfter,
      source: 'testssl.sh cert_expirationStatus',
    },
    remediation:
      'Renovar el certificado antes del vencimiento y automatizar la renovacion (ACME) para que no dependa de un recordatorio.',
  };
}

/** Translates a `testssl.sh` run into catalogue observations. */
export function analyzeTestssl(entries: readonly TestsslEntry[], target: string): TestsslAnalysis {
  const notes: string[] = [];

  for (const entry of entries.filter((candidate) => /^(FATAL|ERROR)$/i.test(candidate.severity))) {
    notes.push(`testssl.sh reported ${entry.id}: ${entry.finding}`);
  }

  const sawProtocols = entries.some((entry) => WEAK_PROTOCOLS[entry.id] !== undefined);
  const sawCertificate = entries.some((entry) => entry.id.startsWith('cert_expirationStatus'));

  if (!sawProtocols) {
    notes.push('testssl.sh returned no protocol results, so SEC-TLS-WEAK could not be evaluated.');
  }

  if (!sawCertificate) {
    notes.push(
      'testssl.sh returned no certificate expiry status, so SEC-TLS-EXPIRING and SEC-TLS-EXPIRED could not be evaluated.',
    );
  }

  const observations = [weakness(entries, target), expiry(entries, target)].filter(
    (observation): observation is RawObservation => observation !== undefined,
  );

  return { observations, notes };
}
