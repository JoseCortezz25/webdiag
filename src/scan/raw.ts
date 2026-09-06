/**
 * The intermediate raw format, `webdiag.raw/1`.
 *
 * Spec §4 says layer 1 writes `raw/<axis>.json` in "the native format of each
 * tool". In phase 0 there is exactly one tool — the stub — so its native format
 * *is* this document, and the normalizer reads it directly.
 *
 * When the real probes land (phase 1) each one keeps writing whatever Lighthouse
 * or axe-core actually produces, and ships an adapter that maps it onto this
 * same shape. That is the seam: the normalizer never learns a second vocabulary,
 * and this schema is the only thing it has to trust.
 *
 * An observation is deliberately *not* a `Finding`: it carries no
 * `catalog_version`, no resolved severity and no `source`. Those are stamped by
 * the normalizer, which is the only layer allowed to speak for the catalogue.
 */
import { z } from 'zod';
import { axisSchema, confidenceSchema, modeSchema, severitySchema } from '../catalog/index.ts';

/** Bumped only when the shape changes in a way an adapter would have to notice. */
export const RAW_SCHEMA_VERSION = 'webdiag.raw/1';

export const toolComponentSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

export type ToolComponent = z.infer<typeof toolComponentSchema>;

export const toolVersionSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  /**
   * Sub-tools whose version moves the numbers as much as the tool's own does.
   * Lighthouse without its Chrome build is not a reproducible measurement, and
   * spec §6 requires `meta.json` to record "cada herramienta, incluida la de
   * Chrome" — this is where that second version travels.
   */
  components: z.array(toolComponentSchema).readonly().optional(),
});

export type ToolVersion = z.infer<typeof toolVersionSchema>;

export const rawObservationSchema = z.object({
  /** Claimed catalogue ID. Unvalidated here on purpose: the normalizer rejects
   *  anything unknown, so a drifting probe produces a rejection, not a crash. */
  id: z.string().min(1),
  confidence: confidenceSchema,
  /** How many places the probe saw it. Never split one kind into N observations. */
  count: z.number().int().min(1),
  affected: z.array(z.string()).readonly(),
  evidence: z.record(z.string(), z.unknown()),
  remediation: z.string().min(1),
  /** Only when the run justifies deviating from the catalogue base severity. */
  severity: severitySchema.optional(),
  doc_ref: z.url({ protocol: /^https?$/ }).optional(),
  title: z.string().min(1).optional(),
});

export type RawObservation = z.infer<typeof rawObservationSchema>;

export const rawDocumentSchema = z.object({
  schema: z.literal(RAW_SCHEMA_VERSION),
  axis: axisSchema,
  tool: toolVersionSchema,
  target: z.object({
    url: z.string().min(1),
    mode: modeSchema,
  }),
  observations: z.array(rawObservationSchema).readonly(),
  /**
   * What the probe could *not* see, in plain language. A probe that skipped a
   * check because a tool was missing or robots.txt refused must say so: a
   * shorter finding list would otherwise read as a cleaner site.
   */
  notes: z.array(z.string()).readonly().optional(),
  /**
   * Extra files a probe produces alongside its observations, keyed by the
   * artifact's own name under the run's output directory (e.g. `sbom.cdx.json`
   * for the white-box DEPS probe's Syft SBOM). The orchestrator writes these
   * without needing to know what any of them mean — same reason it never
   * learns retire.js, Lighthouse or osv-scanner's vocabulary.
   */
  artifacts: z.record(z.string(), z.string()).readonly().optional(),
});

export type RawDocument = z.infer<typeof rawDocumentSchema>;

export function parseRawDocument(input: unknown): RawDocument {
  return rawDocumentSchema.parse(input);
}
