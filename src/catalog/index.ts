/**
 * The finding catalogue: the contract between probes, the normalizer and the
 * agent layer. Import from here rather than reaching into the modules.
 */
export {
  ACTIVE_CATALOG_IDS,
  ACTIVE_ENTRIES,
  ALWAYS_EMITTED_IDS,
  BLOCKING_IDS,
  CATALOG_ENTRIES,
  CATALOG_IDS,
  CATALOG_VERSION,
  type CatalogEntry,
  countByAxis,
  entriesForAxis,
  entriesForPhase,
  entriesMentionedIn,
  entriesOwnedBy,
  findEntry,
  isAlwaysEmitted,
  isBlocking,
  isCatalogId,
  isDeprecated,
  ownerAxisOf,
  requireEntry,
} from './catalog.ts';
export { CONTRACT_LOCK } from './contract-lock.ts';
export {
  createFinding,
  type Finding,
  findingSchema,
  parseFinding,
  safeParseFinding,
} from './finding.ts';
export { canonicalize, fingerprint, fingerprintAll } from './fingerprint.ts';
export {
  type AxisScore,
  coverPageFindings,
  type Deduction,
  lowConfidenceFindings,
  scoreAxes,
  scoreAxis,
} from './scoring.ts';
export {
  AXES,
  type Axis,
  CONFIDENCE_LEVELS,
  type Confidence,
  MAX_AXIS_SCORE,
  MODES,
  type Mode,
  PHASES,
  type Phase,
  SEVERITIES,
  SEVERITY_DEDUCTION,
  type Severity,
} from './taxonomy.ts';
