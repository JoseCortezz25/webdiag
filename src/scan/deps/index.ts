/**
 * The dependency probe. Import from here rather than reaching into the modules.
 */
export {
  type DepsAnalysis,
  type LibraryHit,
  toObservations,
} from './adapter.ts';
export { analyzeServedBundles, detectLibraryHits, scanOrDegrade } from './analyze.ts';
export {
  type AssetCollection,
  displayPath,
  type JsAsset,
  type SkippedAsset,
  type SkipReason,
} from './assets.ts';
export { collectServedScripts, diskName, LIMITS } from './collector.ts';
export {
  EMPTY_ENRICHMENT,
  type Enrichment,
  EPSS_API_URL,
  type EpssLookup,
  fetchEpss,
  fetchKev,
  fetchLatestVersions,
  KEV_FEED_URL,
  type KevLookup,
  REGISTRY_URL,
  type RegistryLookup,
} from './enrichment.ts';
export {
  advisoryId,
  type Classification,
  classify,
  confidenceFor,
  cvesOf,
  EPSS_HIGH_THRESHOLD,
  isMajorBehind,
  majorOf,
  npmNameFor,
  type Signals,
  type VulnerabilityReason,
} from './mapping.ts';
export { type DepsAnalyzer, depsProbe } from './probe.ts';
export {
  parseRetireReport,
  RETIRE_TOOL,
  RETIRE_VERSION,
  type RetireDetection,
  type RetireReport,
  type RetireResult,
  type RetireSeverity,
  type RetireVulnerability,
  retireReportSchema,
  scanWithRetire,
} from './retire.ts';
export { detectLibraries, LIBRARY_SIGNATURES, type LibrarySignature } from './signatures.ts';
export {
  conventionalMapUrl,
  extractSourceMappingUrl,
  type Fetcher,
  findExposedSourcemaps,
  httpFetcher,
  readSourcemapPayload,
  type SourcemapFinding,
  type SourcemapKind,
} from './sourcemaps.ts';
export { WORKSPACE_PREFIX, type Workspace, withWorkspace } from './workspace.ts';
