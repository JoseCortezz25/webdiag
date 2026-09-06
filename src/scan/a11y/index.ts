/**
 * The accessibility probe. Import from here rather than reaching into the modules.
 */
export { type AxeAnalysis, toObservations } from './adapter.ts';
export {
  AXE_IMPACTS,
  type AxeImpact,
  type AxeNode,
  type AxeReport,
  type AxeRuleResult,
  type AxeTarget,
  axeReportSchema,
  formatTarget,
  parseAxeReport,
} from './axe.ts';
export { AXE_VERSION, analyzeWithBrowser } from './browser-runner.ts';
export {
  A11Y_RULE_MAPPINGS,
  type A11yRuleMapping,
  MANUAL_REVIEW_ID,
  mappedAxeRules,
  mappingForAxeRule,
} from './mapping.ts';
export { AXE_TOOL, type AxeAnalyzer, a11yProbe } from './probe.ts';
