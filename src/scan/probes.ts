/**
 * Which probe answers for which axis.
 *
 * Phase 0 wired every axis to the fixture. Phase 1 replaces them one at a time
 * (spec §8), and this table is the single record of how far that has got — so
 * "is the AGENT number real?" is answered by reading one file instead of
 * grepping the orchestrator.
 *
 * Axes still on the stub keep returning invented data on purpose: `report.html`
 * stays complete and the pipeline keeps being exercised end to end. Nothing is
 * disguised by it, because `meta.json` names the tool per axis and a fixture
 * says `webdiag-stub@0.0.0-fixture`.
 */
import type { Axis } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import { agentProbe } from './agent/index.ts';
import type { Probe } from './probe.ts';
import { stubProbe } from './stub-probe.ts';

/**
 * Axes with a real probe. Adding one is a single line here; every axis absent
 * from this table falls back to the fixture.
 */
const REAL_PROBES: Readonly<Partial<Record<Axis, () => Probe>>> = {
  AGENT: agentProbe,
};

/** The probe for one axis: the real one when it exists, the fixture otherwise. */
export function probeFor(axis: Axis): Probe {
  return REAL_PROBES[axis]?.() ?? stubProbe(axis);
}

/** True when the axis is measured rather than invented. */
export function isMeasured(axis: Axis): boolean {
  return REAL_PROBES[axis] !== undefined;
}

/** One probe per axis, in catalogue axis order. */
export function defaultProbes(): readonly Probe[] {
  return AXES.map(probeFor);
}
