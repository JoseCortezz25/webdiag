/**
 * The closed vocabularies the finding catalogue is built from.
 *
 * These are contract values: they appear verbatim in `findings.json`, so a
 * consumer that pinned a catalogue version can rely on them. Adding a member is
 * a breaking change for anything that exhaustively switches over them.
 *
 * Source: `docs/inbox/findings-catalog.md` v1.0.0 §1–§3.
 */
import { z } from 'zod';

/** Diagnostic axes. Each one is scored and reported independently. */
export const AXES = ['PERF', 'A11Y', 'SEO', 'DEPS', 'SEC', 'AGENT'] as const;
export type Axis = (typeof AXES)[number];
export const axisSchema = z.enum(AXES);

/**
 * Roadmap phase a check ships in. `M` is the MVP (phase 1), `2`/`3`/`4` are the
 * later phases described in the spec §8.
 */
export const PHASES = ['M', '2', '3', '4'] as const;
export type Phase = (typeof PHASES)[number];
export const phaseSchema = z.enum(PHASES);

/** How badly the finding breaks the site. Ordered from worst to mildest. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severitySchema = z.enum(SEVERITIES);

/**
 * How sure the probe is that the finding is real. Deliberately separate from
 * `severity`: it is the valve against false positives, not a second severity.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);

/** Which run mode produced the finding, so a report can say what it could see. */
export const MODES = ['quick', 'deep', 'whitebox'] as const;
export type Mode = (typeof MODES)[number];
export const modeSchema = z.enum(MODES);

/**
 * Points subtracted from an axis score per severity (catalogue §3).
 *
 * `critical` has no number on purpose: it does not subtract, it zeroes the axis.
 * See `scoreAxis` for the override rule.
 */
export const SEVERITY_DEDUCTION: Readonly<Record<Exclude<Severity, 'critical'>, number>> = {
  high: 15,
  medium: 5,
  low: 1,
  info: 0,
};

/** Every axis score starts here and is deducted downwards, never below zero. */
export const MAX_AXIS_SCORE = 100;
