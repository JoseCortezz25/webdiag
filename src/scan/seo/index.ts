/**
 * The SEO axis. Import from here rather than reaching into the modules.
 */
export type { CanonicalTarget, SeoAnalysis } from './analysis.ts';
export {
  canonicalObservations,
  headObservations,
  hreflangObservations,
  isValidLanguageTag,
  jsonLdObservations,
  linkObservations,
  noindexObservations,
  renderingObservations,
  robotsObservations,
  sitemapObservations,
  statusObservations,
  toObservations,
} from './checks.ts';
export { BUDGET, type CollectOptions, collect } from './collect.ts';
export {
  type Fetcher,
  type FetchTrace,
  fetchText,
  type Hop,
  traceUrl,
  USER_AGENT,
} from './http.ts';
export {
  type BrokenLink,
  checkLinks,
  type LinkReport,
  lycheeVersion,
  parseLycheeOutput,
} from './links.ts';
export {
  countBodyWords,
  findEmptyMountRoot,
  type HreflangLink,
  type MetaTag,
  metaContent,
  type PageDocument,
  parsePage,
  type ResourceRef,
  resolveUrl,
} from './page.ts';
export { resolveToolVersion, SEO_TOOL, type SeoCollector, seoProbe } from './probe.ts';
export {
  groupFor,
  parseRobots,
  pathOf,
  type RobotsFile,
  type RobotsGroup,
  type RobotsRule,
  type RobotsSyntaxError,
  type RobotsVerdict,
  verdictFor,
} from './robots.ts';
export {
  inspectSitemap,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_URLS,
  runXmllintValidation,
  type SitemapReport,
  type SitemapValidation,
  type XmllintRunner,
  xmllintVersion,
} from './sitemap.ts';
export { SITEINDEX_XSD, SITEMAP_XSD } from './sitemap-schema.ts';
