/**
 * Which probe answers for which axis.
 *
 * Phase 0 wired every axis to `stubProbe`; phase 1 replaced them one at a time
 * (spec §8), and this table is the single record of how far that migration has
 * got — so "is the SEC number real?" is answered by reading one file instead of
 * grepping the orchestrator. Keeping the choice here also keeps the
 * orchestrator free of any knowledge about Chrome, Lighthouse, axe, testssl,
 * lychee, retire.js or robots.txt.
 *
 * Every axis in the catalogue now has a real probe, but the fixture fallback
 * stays: it is what keeps `report.html` complete and the pipeline exercised end
 * to end if an axis is ever added to the catalogue ahead of its probe. Nothing
 * is disguised by it, because `meta.json` names the tool per axis and a fixture
 * says `webdiag-stub@0.0.0-fixture`.
 */
import type { Axis } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import { a11yProbe } from './a11y/index.ts';
import { agentProbe } from './agent/index.ts';
import { depsProbe } from './deps/index.ts';
import { lighthouseProbe } from './perf/index.ts';
import type { Probe } from './probe.ts';
import { type SecurityProbeOptions, securityProbe } from './sec/index.ts';
import { seoProbe } from './seo/index.ts';
import { stubProbe } from './stub-probe.ts';

/**
 * Per-probe knobs the caller may pass down. Only the security probe takes any
 * today; the rest are constructed from their own pinned defaults, so this stays
 * one optional object rather than a parameter per axis.
 */
export type ProbeRegistryOptions = {
  readonly security?: SecurityProbeOptions;
};

/**
 * Axes with a real probe. Adding one is a single line here; every axis absent
 * from this table falls back to the fixture.
 */
const REAL_PROBES: Readonly<Partial<Record<Axis, (options: ProbeRegistryOptions) => Probe>>> = {
  PERF: () => lighthouseProbe(),
  A11Y: () => a11yProbe(),
  SEO: () => seoProbe(),
  SEC: (options) => securityProbe(options.security),
  DEPS: () => depsProbe(),
  AGENT: () => agentProbe(),
};

/** Axes whose probe measures the real site, in catalogue order. */
export const REAL_PROBE_AXES: readonly Axis[] = AXES.filter(
  (axis) => REAL_PROBES[axis] !== undefined,
);

/** True when the axis is measured rather than invented. */
export function isMeasured(axis: Axis): boolean {
  return REAL_PROBES[axis] !== undefined;
}

/** The probe for one axis: the real one when it exists, the fixture otherwise. */
export function probeFor(axis: Axis, options: ProbeRegistryOptions = {}): Probe {
  return REAL_PROBES[axis]?.(options) ?? stubProbe(axis);
}

/** One probe per axis, in catalogue axis order. */
export function defaultProbes(options: ProbeRegistryOptions = {}): readonly Probe[] {
  return AXES.map((axis) => probeFor(axis, options));
}
