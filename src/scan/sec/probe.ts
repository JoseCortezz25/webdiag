/**
 * The SEC probe: `testssl.sh` for the transport, `curl` for the headers.
 *
 * It is assembled from four pieces that each already know how to fail: robots,
 * headers, TLS and the throttle. What this file adds is the policy that binds
 * them, and the policy is one sentence — **a check that cannot run says so and
 * the other checks continue.**
 *
 * That is why almost every step is wrapped. `testssl.sh` not being installed,
 * robots.txt disallowing the URL, a plain-HTTP target: none of these are errors
 * in the sense that should end an axis. They are limits on what was observed,
 * and the report's job is to carry them, not to hide them behind a shorter list
 * of findings. `runProbe` still catches anything genuinely unexpected.
 *
 * Ordering is deliberate: robots.txt is fetched first and its answer gates the
 * header request. Asking for permission after taking what you came for is not
 * asking for permission.
 */
import { VERSION } from '../../version.ts';
import type { Probe, ProbeContext } from '../probe.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type RawObservation } from '../raw.ts';
import {
  type CommandRunner,
  type CurlOptions,
  curlVersion,
  fetchHeaders,
  runCommand,
} from './curl.ts';
import { analyzeHeaders } from './headers.ts';
import { checkRobots } from './robots.ts';
import {
  analyzeTestssl,
  hasTimeoutBinary,
  locateTestssl,
  runTestssl,
  type TestsslEntry,
  type TestsslRun,
  testsslVersion,
} from './testssl.ts';
import { createThrottle, type Throttle } from './throttle.ts';

export const SECURITY_TOOL_NAME = 'webdiag-sec';

const DEFAULT_PORT: Readonly<Record<string, number>> = { 'https:': 443, 'http:': 80 };

/**
 * Every collaborator is injectable. Not for symmetry: this probe's whole surface
 * is the network and two subprocesses, and a test that cannot replace them is a
 * test that either hits a live site or does not exist.
 */
export type SecurityProbeOptions = {
  readonly throttle?: Throttle;
  readonly runner?: CommandRunner;
  readonly contact?: string;
  readonly robots?: typeof checkRobots;
  readonly headers?: typeof fetchHeaders;
  readonly locate?: typeof locateTestssl;
  readonly testssl?: (options: TestsslRun) => Promise<readonly TestsslEntry[]>;
  readonly version?: typeof testsslVersion;
  readonly testsslTimeoutMs?: number;
  readonly timeoutBinary?: typeof hasTimeoutBinary;
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function portOf(url: URL): number {
  return url.port === '' ? (DEFAULT_PORT[url.protocol] ?? 443) : Number(url.port);
}

export function securityProbe(options: SecurityProbeOptions = {}): Probe {
  const runner = options.runner ?? runCommand;
  const throttle = options.throttle ?? createThrottle();
  const robots = options.robots ?? checkRobots;
  const headers = options.headers ?? fetchHeaders;
  const locate = options.locate ?? locateTestssl;
  const testssl = options.testssl ?? runTestssl;
  const version = options.version ?? testsslVersion;
  const timeoutBinary = options.timeoutBinary ?? hasTimeoutBinary;
  const curl: CurlOptions = {
    runner,
    ...(options.contact === undefined ? {} : { contact: options.contact }),
  };

  async function collectHeaders(
    context: ProbeContext,
    host: string,
    notes: string[],
  ): Promise<readonly RawObservation[]> {
    const decision = await throttle.run(host, () => robots(context.url, curl));

    notes.push(`robots.txt: ${decision.reason}`);

    if (!decision.allowed) {
      notes.push(
        'Header checks were skipped: robots.txt does not allow this user-agent to fetch the target URL.',
      );
      return [];
    }

    try {
      const transcript = await throttle.run(host, () => headers(context.url, curl));
      const analysis = analyzeHeaders(transcript);

      notes.push(...analysis.notes);

      if (transcript.finalUrl !== context.url) {
        notes.push(`Headers were read from ${transcript.finalUrl} after following redirects.`);
      }

      return analysis.observations;
    } catch (cause) {
      notes.push(`Header checks did not run: ${messageOf(cause)}`);
      return [];
    }
  }

  async function collectTls(
    url: URL,
    notes: string[],
  ): Promise<{ readonly observations: readonly RawObservation[]; readonly tool: string }> {
    if (url.protocol !== 'https:') {
      notes.push(
        `The target is ${url.protocol}//, so there is no TLS to inspect: SEC-TLS-WEAK, SEC-TLS-EXPIRING and SEC-TLS-EXPIRED were not evaluated.`,
      );
      return { observations: [], tool: 'not applicable' };
    }

    const path = await locate();

    if (path === undefined) {
      notes.push(
        'testssl.sh was not found, so SEC-TLS-WEAK, SEC-TLS-EXPIRING and SEC-TLS-EXPIRED were not evaluated. Install it with `bun run install:testssl`, put it on PATH, or point WEBDIAG_TESTSSL at it.',
      );
      return { observations: [], tool: 'not installed' };
    }

    const port = portOf(url);
    const found = (await version(path, runner)) ?? 'unknown';
    const connectTimeouts = timeoutBinary();

    if (!connectTimeouts) {
      notes.push(
        'GNU `timeout` is not on PATH, so testssl.sh ran without per-connection timeouts; the scan is still bounded by this run’s own wall-clock ceiling.',
      );
    }

    try {
      const entries = await throttle.run(url.hostname, () =>
        testssl({
          host: url.hostname,
          port,
          path,
          runner,
          connectTimeouts,
          ...(options.testsslTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.testsslTimeoutMs }),
        }),
      );

      const analysis = analyzeTestssl(entries, `${url.hostname}:${port}`);
      notes.push(...analysis.notes);

      return { observations: analysis.observations, tool: found };
    } catch (cause) {
      notes.push(`testssl.sh did not complete: ${messageOf(cause)}`);
      return { observations: [], tool: `${found} (failed)` };
    }
  }

  return {
    axis: 'SEC',
    tool: { name: SECURITY_TOOL_NAME, version: VERSION },
    async run(context: ProbeContext): Promise<RawDocument> {
      const url = new URL(context.url);
      const notes: string[] = [];

      if (context.mode === 'deep') {
        notes.push(
          'The SEC axis inspects only the target URL: security headers can differ per route, and this run did not sample others.',
        );
      }

      const headerObservations = await collectHeaders(context, url.hostname, notes);
      const tls = await collectTls(url, notes);
      const curlFound = (await curlVersion(curl)) ?? 'unknown';

      return {
        schema: RAW_SCHEMA_VERSION,
        axis: 'SEC',
        tool: {
          name: SECURITY_TOOL_NAME,
          // Spec §6 requires `meta.json` to record the version of every tool a
          // run used. This probe drives two, so both travel in the one slot the
          // raw schema gives it rather than one of them going unrecorded.
          version: `${VERSION} (curl ${curlFound}, testssl.sh ${tls.tool})`,
        },
        target: { url: context.url, mode: context.mode },
        observations: [...headerObservations, ...tls.observations],
        notes,
      };
    },
  };
}
