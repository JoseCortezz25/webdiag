/**
 * The scan pipeline. Import from here rather than reaching into the modules.
 */
export {
  AGENT_TOOL,
  type AgentSignals,
  agentProbe,
  analyzeHtml,
  analyzeRobots,
  type HtmlAnalysis,
} from './agent/index.ts';
export { DEFAULT_OUT_DIR, type ParsedScan, type ParseError, parseScanArgs } from './args.ts';
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
export { type Probe, type ProbeContext, type ProbeOutcome, runProbe } from './probe.ts';
export { defaultProbes, isMeasured, probeFor } from './probes.ts';
export {
  parseRawDocument,
  RAW_SCHEMA_VERSION,
  type RawDocument,
  type RawObservation,
  rawDocumentSchema,
  type ToolVersion,
} from './raw.ts';
export { escapeHtml, renderReport } from './report.ts';
export { STUB_TOOL, stubProbe, stubProbes } from './stub-probe.ts';
export {
  type AxisSummary,
  buildSummary,
  DISCLAIMERS,
  type FindingSummary,
  SUMMARY_SCHEMA_VERSION,
  type Summary,
} from './summary.ts';
