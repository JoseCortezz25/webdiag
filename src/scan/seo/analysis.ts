/**
 * What one SEO run observed, before anyone decides what it means.
 *
 * This type is the seam of the whole axis. Everything above it does I/O —
 * sockets, subprocesses, a redirect chain — and everything below it (`checks.ts`)
 * is a pure function of this record. That is what makes twenty catalogue IDs
 * testable from a literal instead of from a live website.
 */
import type { FetchTrace } from './http.ts';
import type { LinkReport } from './links.ts';
import type { PageDocument } from './page.ts';
import type { RobotsFile } from './robots.ts';
import type { SitemapReport } from './sitemap.ts';

/** The result of following the page's own `rel=canonical` one step. */
export type CanonicalTarget = {
  readonly declared: string;
  readonly resolved: string;
  /** True when the canonical points at the page that declared it. */
  readonly selfReferencing: boolean;
  readonly status: number | undefined;
  readonly redirected: boolean;
  readonly finalUrl: string | undefined;
  readonly noindex: boolean;
  /** Set when the target could not be reached at all. */
  readonly error: string | undefined;
};

export type SeoAnalysis = {
  readonly url: string;
  readonly trace: FetchTrace;
  /** Absent when the response was not HTML, or when there was no body to read. */
  readonly page: PageDocument | undefined;
  readonly robots: RobotsFile | undefined;
  readonly sitemap: SitemapReport;
  readonly links: LinkReport;
  readonly canonical: CanonicalTarget | undefined;
};
