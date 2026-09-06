import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { AGENT_TOOL } from './agent/index.ts';
import { defaultProbes, isMeasured, probeFor } from './probes.ts';
import { STUB_TOOL } from './stub-probe.ts';

describe('probeFor', () => {
  test('AGENT is measured by its own probe', () => {
    const probe = probeFor('AGENT');

    expect(probe.axis).toBe('AGENT');
    expect(probe.tool).toEqual(AGENT_TOOL);
    expect(isMeasured('AGENT')).toBe(true);
  });

  test('every other axis still falls back to the fixture, and says so', () => {
    for (const axis of AXES.filter((candidate) => candidate !== 'AGENT')) {
      expect(probeFor(axis).tool).toEqual(STUB_TOOL);
      expect(isMeasured(axis)).toBe(false);
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
