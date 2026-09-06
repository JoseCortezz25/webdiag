import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { AXE_TOOL } from './a11y/index.ts';
import { defaultProbes, probeFor } from './probes.ts';
import { STUB_TOOL } from './stub-probe.ts';

describe('defaultProbes', () => {
  test('returns one probe per axis, in catalog order', () => {
    expect(defaultProbes().map((probe) => probe.axis)).toEqual([...AXES]);
  });

  test('wires A11Y to axe-core', () => {
    expect(probeFor('A11Y').tool).toEqual(AXE_TOOL);
  });

  test('keeps the phase 0 fixture on the axes with no real probe yet', () => {
    for (const axis of AXES.filter((candidate) => candidate !== 'A11Y')) {
      expect(probeFor(axis).tool).toEqual(STUB_TOOL);
    }
  });

  test('never reports a fixture under a real tool name', () => {
    // `meta.json` is how a reader tells a measurement from a placeholder, so the
    // two must never share a tool identity.
    expect(STUB_TOOL.name).not.toBe(AXE_TOOL.name);
  });
});
