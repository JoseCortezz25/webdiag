import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { AXE_TOOL } from './a11y/index.ts';
import { AGENT_TOOL } from './agent/index.ts';
import { RETIRE_TOOL } from './deps/index.ts';
import { PINNED_PERF_TOOL } from './perf/index.ts';
import { defaultProbes, isMeasured, probeFor, REAL_PROBE_AXES } from './probes.ts';
import { SECURITY_TOOL_NAME } from './sec/index.ts';
import { SEO_TOOL } from './seo/index.ts';
import { STUB_TOOL } from './stub-probe.ts';

/** The tool name each measured axis must answer with. */
const REAL_TOOL_NAME: Partial<Record<(typeof AXES)[number], string>> = {
  PERF: PINNED_PERF_TOOL.name,
  A11Y: AXE_TOOL.name,
  SEO: SEO_TOOL.name,
  SEC: SECURITY_TOOL_NAME,
  DEPS: RETIRE_TOOL.name,
  AGENT: AGENT_TOOL.name,
};

describe('probe registry', () => {
  test('registers one probe per axis, in catalog order', () => {
    expect(defaultProbes().map((probe) => probe.axis)).toEqual([...AXES]);
  });

  test('each measured axis is answered by its own real probe', () => {
    for (const [axis, name] of Object.entries(REAL_TOOL_NAME)) {
      expect(probeFor(axis as (typeof AXES)[number]).tool.name).toBe(name);
    }
  });

  test('every axis in the catalogue is now measured, none left on the fixture', () => {
    expect([...REAL_PROBE_AXES]).toEqual([...AXES]);

    for (const axis of AXES) {
      expect(isMeasured(axis)).toBe(true);
    }
  });

  test('any axis outside the registry still falls back to the fixture, and admits it', () => {
    // Empty today because every axis is measured. It stays as the guard for the
    // next axis added to the catalogue ahead of its probe: the fixture must
    // answer, and it must answer under the fixture's own name.
    for (const axis of AXES.filter((candidate) => !REAL_PROBE_AXES.includes(candidate))) {
      expect(probeFor(axis).tool).toEqual(STUB_TOOL);
      expect(isMeasured(axis)).toBe(false);
    }
  });

  test('REAL_PROBE_AXES matches what the registry actually wires up', () => {
    const real = defaultProbes()
      .filter((probe) => probe.tool.name !== STUB_TOOL.name)
      .map((probe) => probe.axis);

    expect(real).toEqual([...REAL_PROBE_AXES]);
  });

  test('never reports a fixture under a real tool name', () => {
    // `meta.json` is how a reader tells a measurement from a placeholder, so the
    // two must never share a tool identity.
    for (const name of Object.values(REAL_TOOL_NAME)) {
      expect(STUB_TOOL.name).not.toBe(name);
    }
  });
});

describe('defaultProbes', () => {
  test('covers every axis exactly once, in catalogue order', () => {
    expect(defaultProbes().map((probe) => probe.axis)).toEqual([...AXES]);
  });

  test('returns fresh probes so two runs cannot share state', () => {
    expect(defaultProbes()[0]).not.toBe(defaultProbes()[0]);
  });
});
