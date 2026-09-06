/**
 * The runtime contract for one finding occurrence.
 *
 * A `CatalogEntry` says what an ID means; a `Finding` says that a specific run
 * observed it on a specific site. This schema is what probes emit and what the
 * normalizer validates before anything reaches `findings.json`.
 *
 * Source: `docs/inbox/findings-catalog.md` §2.
 */
import { z } from 'zod';
import { CATALOG_VERSION, isCatalogId, requireEntry } from './catalog.ts';
import {
  type Confidence,
  confidenceSchema,
  type Mode,
  modeSchema,
  type Severity,
  severitySchema,
} from './taxonomy.ts';

/**
 * Free-form structured proof, shaped by whatever produced the finding. Kept
 * open on purpose: pinning it per ID would make every probe change a schema
 * change, and the report renders it as key/value pairs anyway.
 */
export const evidenceSchema = z.record(z.string(), z.unknown());

export const findingSchema = z
  .object({
    /** A published catalogue ID. Anything else means a probe drifted. */
    id: z.string().refine(isCatalogId, {
      message: 'id is not a published catalog ID',
    }),
    /** Pins the finding to the contract version it was produced under. */
    catalog_version: z.literal(CATALOG_VERSION),
    severity: severitySchema,
    /** Separate from severity: how sure we are, not how bad it is. */
    confidence: confidenceSchema,
    /** How many places this one finding covers. Never split into N findings. */
    count: z.number().int().min(1),
    /** The URLs (or paths) it was observed on. May be a sample of `count`. */
    affected: z.array(z.string()).readonly(),
    evidence: evidenceSchema,
    /** Which probe produced it, e.g. `probe:seo`. */
    source: z.string().min(1),
    /** Which tool detected it, so a tool version bump is traceable. */
    tool: z.string().min(1),
    mode: modeSchema,
    remediation: z.string().min(1),
    /** Authoritative reference backing the remediation, when one exists. */
    doc_ref: z.url().optional(),
    /** Human-facing headline. Falls back to the catalogue meaning when absent. */
    title: z.string().min(1).optional(),
  })
  .refine((finding) => finding.affected.length <= finding.count, {
    message: 'affected lists more entries than count claims',
    path: ['count'],
  });

export type Finding = z.infer<typeof findingSchema>;

export function parseFinding(input: unknown): Finding {
  return findingSchema.parse(input);
}

export function safeParseFinding(input: unknown) {
  return findingSchema.safeParse(input);
}

type FindingInput = {
  readonly id: string;
  readonly confidence: Confidence;
  readonly count: number;
  readonly affected: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly tool: string;
  readonly mode: Mode;
  readonly remediation: string;
  /** Only pass this to deviate from the catalogue's base severity. */
  readonly severity?: Severity;
  readonly doc_ref?: string;
  readonly title?: string;
};

/**
 * Builds a validated finding, defaulting `severity` to the catalogue base and
 * stamping the current `catalog_version`. Probes should use this rather than
 * assembling the object literal, so those two fields can never drift.
 *
 * The ID must be one a new run may still emit: select from `ACTIVE_CATALOG_IDS`,
 * not `CATALOG_IDS`. The schema stays deliberately permissive about deprecated
 * IDs so historical `findings.json` files can still be parsed and compared.
 */
export function createFinding(input: FindingInput): Finding {
  const entry = requireEntry(input.id);

  return parseFinding({
    id: entry.id,
    catalog_version: CATALOG_VERSION,
    severity: input.severity ?? entry.baseSeverity,
    confidence: input.confidence,
    count: input.count,
    affected: input.affected,
    evidence: input.evidence,
    source: input.source,
    tool: input.tool,
    mode: input.mode,
    remediation: input.remediation,
    ...(input.doc_ref === undefined ? {} : { doc_ref: input.doc_ref }),
    ...(input.title === undefined ? {} : { title: input.title }),
  });
}
