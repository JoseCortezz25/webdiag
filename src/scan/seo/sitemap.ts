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
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fetchText, type TraceOptions } from './http.ts';
import { SITEINDEX_XSD, SITEMAP_XSD } from './sitemap-schema.ts';

/** sitemaps.org: 50,000 URLs and 50 MB uncompressed, per file. */
export const MAX_SITEMAP_URLS = 50_000;
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

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
  readonly entryCount: number;
  readonly byteLength: number;
  readonly validation: SitemapValidation | undefined;
  /** Set when the check could not run at all — a missing `xmllint`, say. */
  readonly toolError: string | undefined;
};

export type SitemapOptions = TraceOptions & {
  readonly runXmllint?: XmllintRunner;
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

/** Writes both files, runs `xmllint`, and always removes them again. */
export async function runXmllintValidation(
  schema: string,
  document: string,
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const schemaPath = `${tmpdir()}/webdiag-sitemap-${stamp}.xsd`;
  const documentPath = `${tmpdir()}/webdiag-sitemap-${stamp}.xml`;

  await Bun.write(schemaPath, schema);
  await Bun.write(documentPath, document);

  try {
    const process = Bun.spawn(
      ['xmllint', '--noout', '--nonet', '--schema', schemaPath, documentPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    return { ok: exitCode === 0, stderr };
  } finally {
    await Promise.all([
      unlink(schemaPath).catch(() => undefined),
      unlink(documentPath).catch(() => undefined),
    ]);
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
  const candidates = [...new Set([...declared, conventional])];
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
    validation: undefined,
    toolError: undefined,
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

    const byteLength = new TextEncoder().encode(response.body).length;
    const entryCount = countEntries(response.body, root);
    const declaredInRobots = declared.includes(candidate);

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
        validation: {
          valid: false,
          schema: 'sitemap',
          errors: ['the document root is not <urlset> nor <sitemapindex>'],
        },
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
        toolError: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  return empty;
}
