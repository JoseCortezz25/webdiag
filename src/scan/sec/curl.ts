/**
 * The HTTP half of the security probe, done with `curl` (spec §5.1: "headers vía
 * curl").
 *
 * Shelling out rather than using `fetch` is a deliberate choice, not a habit.
 * `fetch` hands back a `Headers` object that has already normalised the wire:
 * duplicate `Set-Cookie` lines are folded, redirect hops are invisible, and the
 * exact bytes a server sent are gone. This probe's whole job is to report what
 * the server actually sends, so it reads the raw header stream instead.
 *
 * Nothing here interprets a header. Parsing is separated from judging so the
 * analysis in `headers.ts` can be tested against captured transcripts without a
 * network, a subprocess, or a live site that changes between runs.
 */
import { userAgent } from './agent.ts';

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandOptions = {
  /** Hard wall-clock ceiling. An external tool that hangs must not hang the run. */
  readonly timeoutMs?: number;
  /**
   * Working directory for the child. Only tools that resolve configuration
   * relative to the project they inspect need it; ESLint is the reason it
   * exists.
   */
  readonly cwd?: string;
};

/** Injected so tests can drive the parser without spawning anything. */
export type CommandRunner = (
  command: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, options = {}) => {
  const [executable, ...rest] = command;

  if (executable === undefined) {
    throw new Error('runCommand was given an empty command.');
  }

  const child = Bun.spawn([executable, ...rest], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
};

export type HeaderPair = readonly [name: string, value: string];

/** One response in a redirect chain, exactly as it came off the wire. */
export type HeaderBlock = {
  readonly status: number;
  readonly headers: readonly HeaderPair[];
};

export type HeaderTranscript = {
  readonly blocks: readonly HeaderBlock[];
  /** Where the chain ended. Not necessarily the URL that was requested. */
  readonly finalUrl: string;
};

export type CurlOptions = {
  readonly runner?: CommandRunner;
  readonly timeoutSeconds?: number;
  readonly maxRedirects?: number;
  readonly contact?: string;
};

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_MAX_REDIRECTS = 5;

const FINAL_URL_MARKER = 'x-webdiag-final-url:';
const STATUS_MARKER = 'x-webdiag-status:';

/** Reads the first header value with this name, case-insensitively. */
export function headerValue(block: HeaderBlock, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return block.headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Reads every header with this name. `Set-Cookie` is the reason this exists. */
export function headerValues(block: HeaderBlock, name: string): readonly string[] {
  const wanted = name.toLowerCase();
  return block.headers.filter(([key]) => key.toLowerCase() === wanted).map(([, value]) => value);
}

function statusOf(line: string): number | undefined {
  const match = /^HTTP\/[\d.]+\s+(\d{3})/i.exec(line.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Splits a `curl -D -` dump into one block per response.
 *
 * Header order is preserved and duplicates are kept, because both carry meaning:
 * two `Set-Cookie` lines are two cookies, and folding them would hide one.
 */
export function parseHeaderDump(dump: string): readonly HeaderBlock[] {
  const blocks: HeaderBlock[] = [];
  let status: number | undefined;
  let headers: HeaderPair[] = [];

  const close = (): void => {
    if (status !== undefined) {
      blocks.push({ status, headers });
    }
    status = undefined;
    headers = [];
  };

  for (const raw of dump.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const nextStatus = statusOf(line);

    if (nextStatus !== undefined) {
      close();
      status = nextStatus;
      continue;
    }

    if (line.trim() === '') {
      close();
      continue;
    }

    const separator = line.indexOf(':');

    if (status === undefined || separator <= 0) {
      continue;
    }

    headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }

  close();

  return blocks;
}

/** Last wins: with `-L`, curl writes the marker once, after the final hop. */
function markerValue(text: string, marker: string): string | undefined {
  const found = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(marker))
    .at(-1);

  return found === undefined ? undefined : found.slice(marker.length).trim();
}

function baseArgs(options: CurlOptions): readonly string[] {
  return [
    '--silent',
    '--show-error',
    '--location',
    '--max-redirs',
    String(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS),
    '--max-time',
    String(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
    '--user-agent',
    userAgent(options.contact),
  ];
}

function failureOf(result: CommandResult, url: string): Error {
  const detail =
    result.stderr.trim() === '' ? `exit code ${result.exitCode}` : result.stderr.trim();
  return new Error(`curl could not reach ${url}: ${detail}`);
}

/**
 * Fetches only the response headers of `url`, following redirects.
 *
 * The body is discarded on purpose: none of the header checks need it, and not
 * downloading it is the cheapest courtesy this probe can extend to a host.
 */
export async function fetchHeaders(
  url: string,
  options: CurlOptions = {},
): Promise<HeaderTranscript> {
  const runner = options.runner ?? runCommand;
  const result = await runner([
    'curl',
    ...baseArgs(options),
    '--dump-header',
    '-',
    '--output',
    '/dev/null',
    '--write-out',
    `\n${FINAL_URL_MARKER} %{url_effective}\n`,
    url,
  ]);

  if (result.exitCode !== 0) {
    throw failureOf(result, url);
  }

  return {
    blocks: parseHeaderDump(result.stdout),
    finalUrl: markerValue(result.stdout, FINAL_URL_MARKER) ?? url,
  };
}

export type TextResponse = {
  readonly status: number;
  readonly body: string;
};

/** Fetches a small text resource. Used for `robots.txt` and nothing else. */
export async function fetchText(url: string, options: CurlOptions = {}): Promise<TextResponse> {
  const runner = options.runner ?? runCommand;
  const result = await runner([
    'curl',
    ...baseArgs(options),
    '--write-out',
    `\n${STATUS_MARKER} %{http_code}\n`,
    url,
  ]);

  if (result.exitCode !== 0) {
    throw failureOf(result, url);
  }

  const status = Number(markerValue(result.stdout, STATUS_MARKER) ?? '0');
  const cut = result.stdout.toLowerCase().lastIndexOf(`\n${STATUS_MARKER}`);

  return {
    status: Number.isFinite(status) ? status : 0,
    body: cut < 0 ? result.stdout : result.stdout.slice(0, cut),
  };
}

/** `curl 8.7.1 (x86_64-apple-darwin)` → `8.7.1`. Recorded in `meta.json`. */
export async function curlVersion(options: CurlOptions = {}): Promise<string | undefined> {
  const runner = options.runner ?? runCommand;

  try {
    const result = await runner(['curl', '--version']);
    const match = /^curl\s+(\S+)/.exec(result.stdout);
    return result.exitCode === 0 ? match?.[1] : undefined;
  } catch {
    return undefined;
  }
}
