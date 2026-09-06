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
  mergeObservations,
  noindexObservations,
  pageObservations,
  renderingObservations,
  robotsObservations,
  sitemapObservations,
  statusObservations,
  toObservations,
} from './checks.ts';
export { BUDGET, type CollectOptions, collect, collectSite } from './collect.ts';
export {
  CRAWL_BUDGET,
  type CrawlOptions,
  crawlSite,
  internalLinksOf,
  isCrawlable,
  MAX_DEEP_PAGES,
  MIN_DEEP_PAGES,
  sampleUrls,
} from './crawl.ts';
export {
  canonicalChainObservations,
  type DeepObservations,
  hreflangReturnObservations,
  metaDescriptionDuplicateObservations,
  nearDuplicateObservations,
  type OrphanResult,
  orphanPageObservations,
  sitemapDirtyObservations,
  siteObservations,
  titleDuplicateObservations,
} from './deep-checks.ts';
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
  bodyText,
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
export {
  resolveToolVersion,
  SEO_TOOL,
  type SeoCollector,
  type SeoSiteCollector,
  seoProbe,
} from './probe.ts';
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
  hammingDistance,
  MIN_WORDS_FOR_SIMHASH,
  NEAR_DUPLICATE_DISTANCE,
  simhash,
  words,
} from './simhash.ts';
export type { SamplePage, SiteAnalysis } from './site.ts';
export {
  extractLocs,
  inspectSitemap,
  MAX_COLLECTED_LOCS,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_URLS,
  runXmllintValidation,
  type SitemapReport,
  type SitemapValidation,
  type XmllintRunner,
  xmllintVersion,
} from './sitemap.ts';
export { SITEINDEX_XSD, SITEMAP_XSD } from './sitemap-schema.ts';
