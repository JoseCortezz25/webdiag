/**
 * The probe set a real run uses.
 *
 * Phase 1 replaces the stub one axis at a time (spec §8), so this is where the
 * seam between "measured" and "still invented" lives, in one list rather than
 * scattered across the orchestrator. Today Performance is real and the other
 * five are still fixtures; a reader of `meta.json` can tell which is which
 * without reading this file, because the tool name says `webdiag-stub`.
 */
import type { Axis } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import { lighthouseProbe } from './perf/index.ts';
import type { Probe } from './probe.ts';
import { stubProbe } from './stub-probe.ts';

/** Axes with a real probe. Everything else falls back to the fixture. */
const REAL_PROBES: Readonly<Partial<Record<Axis, () => Probe>>> = {
  PERF: lighthouseProbe,
};

export function defaultProbes(): readonly Probe[] {
  return AXES.map((axis) => REAL_PROBES[axis]?.() ?? stubProbe(axis));
}
