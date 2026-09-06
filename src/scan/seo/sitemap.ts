/**
 * The sitemap check: find it, validate it against the published schema, and
 * measure it against the published limits.
 *
 * The ticket asks for `xmllint` specifically, and that is the right call: the
 * alternative is a hand-written "does it look like a sitemap" heuristic that
 * agrees with sitemaps.org right up to the point where a client's generator
 * emits something subtly wrong, which is exactly the case worth catching. So
 * the schema is authoritative and this module only decides *which* schema and
 * what the exit status meant.
 *
 * `--nonet` is not optional. Without it `xmllint` will resolve remote schema
 * references, and a validation that reaches the network is a validation that
 * can be made to say anything by whoever controls that host.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSameSite } from '../net/address-guard.ts';
import { fetchText, MAX_BODY_BYTES, type TraceOptions } from './http.ts';
import { SITEINDEX_XSD, SITEMAP_XSD } from './sitemap-schema.ts';

/** sitemaps.org: 50,000 URLs and 50 MB uncompressed, per file. */
export const MAX_SITEMAP_URLS = 50_000;
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

/**
 * How long `xmllint` may take over one document. Validation of a 2 MB file is
 * a matter of milliseconds; anything approaching this is a hang, not a slow
 * run, and a hung validator must not stall the whole axis.
 */
export const XMLLINT_TIMEOUT_MS = 15_000;

export type SitemapValidation = {
  readonly valid: boolean;
  readonly schema: 'sitemap' | 'siteindex';
  readonly errors: readonly string[];
};

export type SitemapReport = {
  /** Every candidate that was tried, in the order it was tried. */
  readonly candidates: readonly string[];
  readonly url: string | undefined;
  readonly status: number | undefined;
  readonly found: boolean;
  /** True when `robots.txt` names the sitemap that was found. */
  readonly declaredInRobots: boolean;
  readonly root: 'urlset' | 'sitemapindex' | 'unknown' | undefined;
  /** Entries counted in the bytes that were read. A lower bound when `truncated`. */
  readonly entryCount: number;
  /**
   * The size of the document. From `content-length` when the server declared
   * one; otherwise the bytes read, which is at least the fetch cap when the
   * body was cut there.
   */
  readonly byteLength: number;
  /**
   * True when the document was longer than the fetch cap and only a prefix was
   * read. Schema validation is skipped in that case: validating half a file
   * would report a broken sitemap that is merely large.
   */
  readonly truncated: boolean;
  readonly validation: SitemapValidation | undefined;
  /** Set when the check could not run at all — a missing `xmllint`, say. */
  readonly toolError: string | undefined;
  /**
   * The page URLs the sitemap declares, bounded. Empty in `quick`: reading them
   * only pays for itself once something cross-page is going to use them, and
   * `followIndex` is what asks for that.
   */
  readonly locs: readonly string[];
  /**
   * Candidates that were declared but not fetched because they point off the
   * scanned site. A `Sitemap:` line is written by the site being scanned, and a
   * scanner that follows it anywhere can be pointed at anything.
   */
  readonly refused: readonly string[];
};

export type SitemapOptions = TraceOptions & {
  readonly runXmllint?: XmllintRunner;
  /**
   * Whether to read `<loc>` values, and to follow a sitemap index one level
   * down to reach real page URLs. `deep` sets it; `quick` has no use for the
   * list and should not spend two extra round trips collecting it.
   */
  readonly followIndex?: boolean;
};

export type XmllintRunner = (
  schema: string,
  document: string,
) => Promise<{ readonly ok: boolean; readonly stderr: string }>;

function rootElementOf(body: string): SitemapReport['root'] {
  // The first element name after the prolog, comments and the doctype.
  const match = body
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .match(/<\s*([A-Za-z_][\w.:-]*)/);

  const name = match?.[1]?.split(':').pop()?.toLowerCase();

  if (name === 'urlset' || name === 'sitemapindex') {
    return name;
  }
  return name === undefined ? undefined : 'unknown';
}

function countEntries(body: string, root: SitemapReport['root']): number {
  const tag = root === 'sitemapindex' ? 'sitemap' : 'url';
  return body.match(new RegExp(`<\\s*(?:[\\w.-]+:)?${tag}(?:\\s|>)`, 'gi'))?.length ?? 0;
}

/** A `deep` run reads this many sitemap URLs at most, and no more child files. */
export const MAX_COLLECTED_LOCS = 500;
const MAX_CHILD_SITEMAPS = 2;

/** `&amp;` and friends, which a `<loc>` is required to use. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The `<loc>` values of a sitemap document, in document order.
 *
 * A regex over the raw XML rather than a parser: the only thing being extracted
 * is the text of one element name, the document has already been validated
 * against the published schema by `xmllint`, and pulling in an XML DOM to read a
 * flat list of strings would be a dependency bought with nothing.
 */
export function extractLocs(body: string): readonly string[] {
  const matches = body.matchAll(
    /<\s*(?:[\w.-]+:)?loc\s*>([\s\S]*?)<\s*\/\s*(?:[\w.-]+:)?loc\s*>/gi,
  );
  const out: string[] = [];

  for (const match of matches) {
    const value = decodeXmlEntities((match[1] ?? '').trim());

    if (value !== '' && /^https?:\/\//i.test(value)) {
      out.push(value);
    }

    if (out.length >= MAX_COLLECTED_LOCS) {
      break;
    }
  }

  return [...new Set(out)];
}

/**
 * Turns the `<loc>` list of a sitemap index into page URLs.
 *
 * Bounded to two child files on purpose. The point is a representative sample
 * for the deep checks, not a mirror of the site: a news site with 400 monthly
 * sitemaps would otherwise turn one check into 400 round trips.
 */
async function collectIndexedLocs(
  childUrls: readonly string[],
  options: SitemapOptions,
): Promise<readonly string[]> {
  const out: string[] = [];

  const scanHost = options.scanHost;
  const sameSite =
    scanHost === undefined ? childUrls : childUrls.filter((child) => isSameSite(child, scanHost));

  for (const child of sameSite.slice(0, MAX_CHILD_SITEMAPS)) {
    try {
      const response = await fetchText(child, options);

      if (response.status >= 200 && response.status < 300) {
        out.push(...extractLocs(response.body));
      }
    } catch {
      // A child sitemap that will not load narrows the sample; it is not a
      // finding of its own, and the parent's own validation already ran.
    }

    if (out.length >= MAX_COLLECTED_LOCS) {
      break;
    }
  }

  return [...new Set(out)].slice(0, MAX_COLLECTED_LOCS);
}

async function locsFor(
  body: string,
  root: SitemapReport['root'],
  options: SitemapOptions,
): Promise<readonly string[]> {
  if (options.followIndex !== true) {
    return [];
  }

  const declared = extractLocs(body);

  return root === 'sitemapindex' ? collectIndexedLocs(declared, options) : declared;
}

/**
 * Writes both files into a private temp directory, runs `xmllint` under a
 * timeout, and always removes the directory again.
 *
 * `mkdtemp` rather than a timestamp-and-random name: the directory is created
 * atomically with a name nobody else holds, so two concurrent runs cannot
 * collide and nothing can be pre-placed at the path.
 */
export async function runXmllintValidation(
  schema: string,
  document: string,
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'webdiag-sitemap-'));
  const schemaPath = join(directory, 'schema.xsd');
  const documentPath = join(directory, 'document.xml');

  try {
    await Bun.write(schemaPath, schema);
    await Bun.write(documentPath, document);

    const child = Bun.spawn(
      ['xmllint', '--noout', '--nonet', '--schema', schemaPath, documentPath],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        // Bun sends SIGTERM at `timeout` and escalates to SIGKILL if the process
        // is still alive after `killSignal` handling — the same shape every other
        // subprocess wrapper in this codebase uses.
        timeout: XMLLINT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );

    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    // `killed` is true whenever a `timeout` was configured, so it says nothing;
    // a process that died to a signal has no exit code and a signal name.
    if (child.signalCode !== null) {
      throw new Error(`xmllint exceeded ${XMLLINT_TIMEOUT_MS} ms and was stopped`);
    }

    return { ok: exitCode === 0, stderr: stderr === '' ? stdout : stderr };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `xmllint: using libxml version 20913` → `20913`. */
export async function xmllintVersion(): Promise<string | undefined> {
  try {
    const process = Bun.spawn(['xmllint', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    if (exitCode !== 0) {
      return undefined;
    }
    return stderr.match(/libxml version (\S+)/)?.[1];
  } catch {
    return undefined;
  }
}

/** Trims a validator's stderr to the lines a report can show without a scroll bar. */
function schemaErrors(stderr: string): readonly string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('xmllint:'))
    .slice(0, 10);
}

/**
 * Tries the sitemaps `robots.txt` declares, then the conventional location.
 * The first candidate that answers with a 2xx and an XML root wins.
 */
export async function inspectSitemap(
  origin: string,
  declared: readonly string[],
  options: SitemapOptions,
): Promise<SitemapReport> {
  const conventional = new URL('/sitemap.xml', origin).toString();
  const scanHost = options.scanHost ?? new URL(origin).hostname;
  const refused = declared.filter((candidate) => !isSameSite(candidate, scanHost));
  const candidates = [...new Set([...declared, conventional])].filter(
    (candidate) => !refused.includes(candidate),
  );
  const runner = options.runXmllint ?? runXmllintValidation;

  const empty: SitemapReport = {
    candidates,
    url: undefined,
    status: undefined,
    found: false,
    declaredInRobots: false,
    root: undefined,
    entryCount: 0,
    byteLength: 0,
    truncated: false,
    validation: undefined,
    toolError: undefined,
    locs: [],
    refused,
  };

  for (const candidate of candidates) {
    let response: Awaited<ReturnType<typeof fetchText>>;

    try {
      response = await fetchText(candidate, options);
    } catch {
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      continue;
    }

    const root = rootElementOf(response.body);

    if (root === undefined) {
      continue;
    }

    const readBytes = new TextEncoder().encode(response.body).length;
    const truncated = response.truncated;
    const byteLength =
      response.contentLength ?? (truncated ? Math.max(readBytes, MAX_BODY_BYTES) : readBytes);
    const entryCount = countEntries(response.body, root);
    const declaredInRobots = declared.includes(candidate);
    const locs = await locsFor(response.body, root, options);

    if (root === 'unknown') {
      return {
        ...empty,
        url: candidate,
        status: response.status,
        found: true,
        declaredInRobots,
        root,
        entryCount,
        byteLength,
        truncated,
        locs,
        validation: {
          valid: false,
          schema: 'sitemap',
          errors: ['the document root is not <urlset> nor <sitemapindex>'],
        },
      };
    }

    if (truncated) {
      // Only a prefix was read. Validating it would fail on the cut, and that
      // failure would be about the fetch cap, not about the sitemap.
      return {
        ...empty,
        url: candidate,
        status: response.status,
        found: true,
        declaredInRobots,
        root,
        entryCount,
        byteLength,
        truncated,
        locs,
      };
    }

    const schema = root === 'sitemapindex' ? SITEINDEX_XSD : SITEMAP_XSD;

    try {
      const result = await runner(schema, response.body);

      return {
        ...empty,
        url: candidate,
        status: response.status,
        found: true,
        declaredInRobots,
        root,
        entryCount,
        byteLength,
        truncated,
        locs,
        validation: {
          valid: result.ok,
          schema: root === 'sitemapindex' ? 'siteindex' : 'sitemap',
          errors: result.ok ? [] : schemaErrors(result.stderr),
        },
      };
    } catch (cause) {
      // A missing validator degrades the check; it does not invent a finding.
      return {
        ...empty,
        url: candidate,
        status: response.status,
        found: true,
        declaredInRobots,
        root,
        entryCount,
        byteLength,
        truncated,
        locs,
        toolError: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  return empty;
}
