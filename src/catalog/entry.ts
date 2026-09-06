/**
 * The shape of one catalogue row: the stable definition of a finding *kind*,
 * as opposed to `Finding`, which is one occurrence of that kind in a run.
 */
import { AXES, type Axis, type Phase, type Severity } from './taxonomy.ts';

export type CatalogEntry = {
  /** `<AXIS>-<OBJECT>-<PROBLEM>`. Once published it never changes meaning. */
  readonly id: string;
  /** Axis the ID belongs to, derived from its prefix. */
  readonly axis: Axis;
  /** Roadmap phase this check ships in. */
  readonly phase: Phase;
  /** Severity before any run-specific escalation. */
  readonly baseSeverity: Severity;
  /**
   * Marked 🚫 in the catalogue: promoted to the report cover on top of the
   * axis-zeroing that any `critical` already causes.
   */
  readonly blocking: boolean;
  /**
   * Emitted on every run where it applies, even when nothing is wrong. These
   * exist so the report cannot be read as a certificate of compliance.
   */
  readonly alwaysEmitted: boolean;
  /**
   * The single axis that scores this finding. Differs from `axis` for findings
   * that legitimately surface in two axes; the other axis only mentions it.
   */
  readonly ownerAxis: Axis;
  /** Axes that mention this finding informatively, without deducting. */
  readonly mentionedIn: readonly Axis[];
  /** What the check detects, transcribed from the normative catalogue. */
  readonly detects: string;
  /**
   * Retired. The ID stays here forever so historical `findings.json` keeps
   * resolving, but new runs must not emit it. This is the other half of the
   * golden rule (spec §6): a check that evolves gets a new ID and the old one is
   * marked deprecated, rather than being redefined in place.
   */
  readonly deprecated: boolean;
  /** The ID that replaced a deprecated entry, when one did. */
  readonly supersededBy?: string;
  /** Interpretation the report must carry, when the catalogue states one. */
  readonly note?: string;
};

type EntryInput = {
  readonly id: string;
  readonly phase: Phase;
  readonly baseSeverity: Severity;
  readonly detects: string;
  readonly blocking?: true;
  readonly alwaysEmitted?: true;
  readonly ownedBy?: Axis;
  readonly mentionedIn?: readonly Axis[];
  readonly deprecated?: true;
  readonly supersededBy?: string;
  readonly note?: string;
};

function axisOf(id: string): Axis {
  const prefix = id.split('-')[0];
  const axis = AXES.find((candidate) => candidate === prefix);

  if (axis === undefined) {
    throw new Error(`Catalog ID '${id}' does not start with a known axis prefix.`);
  }

  return axis;
}

/**
 * Expands a compact catalogue row into a fully defaulted entry. Defaults exist
 * so the data file reads like the source table: only the exceptions are stated.
 */
export function defineEntry(input: EntryInput): CatalogEntry {
  const axis = axisOf(input.id);

  const entry: CatalogEntry = {
    id: input.id,
    axis,
    phase: input.phase,
    baseSeverity: input.baseSeverity,
    blocking: input.blocking ?? false,
    alwaysEmitted: input.alwaysEmitted ?? false,
    ownerAxis: input.ownedBy ?? axis,
    mentionedIn: input.mentionedIn ?? [],
    detects: input.detects,
    deprecated: input.deprecated ?? false,
  };

  return {
    ...entry,
    ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}
