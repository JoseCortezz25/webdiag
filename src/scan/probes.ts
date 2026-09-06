/**
 * Which probe answers for which axis.
 *
 * Phase 0 wired every axis to the fixture probe. Phase 1 replaces them one at a
 * time, and this file is the single place that records how far that migration
 * has got — so "is the SEC number real?" is answered by reading one table
 * instead of grepping the orchestrator.
 *
 * The axes still on the stub keep returning invented data, and their `meta.json`
 * tool entry says `webdiag-stub@0.0.0-fixture`. That is the point: the report
 * names its source per axis, so a real number and a fixture number are never
 * presented as the same kind of thing.
 */
import type { Axis } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import type { Probe } from './probe.ts';
import { type SecurityProbeOptions, securityProbe } from './sec/index.ts';
import { stubProbe } from './stub-probe.ts';

export type ProbeRegistryOptions = {
  readonly security?: SecurityProbeOptions;
};

/** Axes whose probe measures the real site. Everything else is still fixture data. */
export const REAL_PROBE_AXES: readonly Axis[] = ['SEC'];

export function probeFor(axis: Axis, options: ProbeRegistryOptions = {}): Probe {
  return axis === 'SEC' ? securityProbe(options.security) : stubProbe(axis);
}

/** One probe per axis, in catalogue order. */
export function defaultProbes(options: ProbeRegistryOptions = {}): readonly Probe[] {
  return AXES.map((axis) => probeFor(axis, options));
}
