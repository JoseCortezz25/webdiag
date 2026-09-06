/**
 * Which probe runs for which axis.
 *
 * Phase 0 wired every axis to `stubProbe`; phase 1 replaces them one at a time
 * (spec §8). Keeping the choice in one table means a landing probe is a one-line
 * change here and nothing else, and it keeps the orchestrator free of any
 * knowledge about lychee, xmllint or HTML parsing.
 *
 * Axes with no real probe yet still return the fixture, so `report.html` stays
 * complete and the pipeline keeps being exercised end to end. `meta.json` names
 * the tool per axis, so a stub is never mistaken for a measurement.
 */
import type { Axis } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import type { Probe } from './probe.ts';
import { seoProbe } from './seo/index.ts';
import { stubProbe } from './stub-probe.ts';

const REAL_PROBES: Readonly<Partial<Record<Axis, () => Probe>>> = {
  SEO: seoProbe,
};

/** The probe for one axis: the real one when it exists, the fixture otherwise. */
export function probeFor(axis: Axis): Probe {
  const build = REAL_PROBES[axis];
  return build === undefined ? stubProbe(axis) : build();
}

/** One probe per axis, in catalogue axis order. */
export function defaultProbes(): readonly Probe[] {
  return AXES.map(probeFor);
}
