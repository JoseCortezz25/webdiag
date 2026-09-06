/**
 * The scan pipeline. Import from here rather than reaching into the modules.
 */
export {
  A11Y_RULE_MAPPINGS,
  type A11yRuleMapping,
  AXE_TOOL,
  AXE_VERSION,
  type AxeAnalysis,
  type AxeAnalyzer,
  type AxeReport,
  a11yProbe,
  analyzeWithBrowser,
  axeReportSchema,
  MANUAL_REVIEW_ID,
  mappedAxeRules,
  mappingForAxeRule,
  parseAxeReport,
  toObservations as toA11yObservations,
} from './a11y/index.ts';
export { DEFAULT_OUT_DIR, type ParsedScan, type ParseError, parseScanArgs } from './args.ts';
export {
  type AssetCollection,
  type DepsAnalysis,
  type DepsAnalyzer,
  depsProbe,
  type Enrichment,
  type JsAsset,
  type LibraryHit,
  RETIRE_TOOL,
  RETIRE_VERSION,
  type RetireReport,
  type SourcemapFinding,
  toObservations as toDepsObservations,
} from './deps/index.ts';
export { buildMeta, META_SCHEMA_VERSION, type Meta, type ToolRecord } from './meta.ts';
export {
  type NormalizedRun,
  normalize,
  type RejectedObservation,
  type RejectionReason,
} from './normalize.ts';
export {
  type ArtifactWriter,
  encodeJson,
  runScan,
  type ScanOptions,
  type ScanRequest,
  type ScanResult,
} from './orchestrator.ts';
export {
  CHROME_TOOL_NAME,
  lighthouseProbe,
  PINNED_CHROME_BUILD,
  PINNED_LIGHTHOUSE_VERSION,
  PINNED_PERF_TOOL,
} from './perf/index.ts';
export { type Probe, type ProbeContext, type ProbeOutcome, runProbe } from './probe.ts';
export {
  defaultProbes,
  isMeasured,
  type ProbeRegistryOptions,
  probeFor,
  REAL_PROBE_AXES,
} from './probes.ts';
export {
  parseRawDocument,
  RAW_SCHEMA_VERSION,
  type RawDocument,
  type RawObservation,
  rawDocumentSchema,
  type ToolComponent,
  type ToolVersion,
} from './raw.ts';
export { escapeHtml, renderReport } from './report.ts';
export {
  analyzeHeaders,
  analyzeTestssl,
  checkRobots,
  createThrottle,
  SECURITY_TOOL_NAME,
  type SecurityProbeOptions,
  securityProbe,
  userAgent,
} from './sec/index.ts';
export {
  BUDGET,
  type CanonicalTarget,
  type CollectOptions,
  checkLinks,
  collect,
  type FetchTrace,
  inspectSitemap,
  type LinkReport,
  type PageDocument,
  parsePage,
  parseRobots,
  type RobotsFile,
  SEO_TOOL,
  type SeoAnalysis,
  type SeoCollector,
  type SitemapReport,
  seoProbe,
  toObservations as toSeoObservations,
  traceUrl,
  verdictFor,
} from './seo/index.ts';
export { STUB_TOOL, stubProbe, stubProbes } from './stub-probe.ts';
export {
  type AxisSummary,
  buildSummary,
  DISCLAIMERS,
  type FindingSummary,
  type ProbeSummary,
  SUMMARY_SCHEMA_VERSION,
  type Summary,
} from './summary.ts';
