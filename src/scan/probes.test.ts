import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { defaultProbes, probeFor, REAL_PROBE_AXES } from './probes.ts';
import { SECURITY_TOOL_NAME } from './sec/index.ts';
import { STUB_TOOL } from './stub-probe.ts';

describe('probe registry', () => {
  test('registers one probe per axis, in catalog order', () => {
    expect(defaultProbes().map((probe) => probe.axis)).toEqual([...AXES]);
  });

  test('SEC is answered by the real probe', () => {
    expect(probeFor('SEC').tool.name).toBe(SECURITY_TOOL_NAME);
  });

  test('every other axis still answers with the fixture probe, and admits it', () => {
    for (const axis of AXES.filter((candidate) => !REAL_PROBE_AXES.includes(candidate))) {
      expect(probeFor(axis).tool).toEqual(STUB_TOOL);
    }
  });

  test('REAL_PROBE_AXES matches what the registry actually wires up', () => {
    const real = defaultProbes()
      .filter((probe) => probe.tool.name !== STUB_TOOL.name)
      .map((probe) => probe.axis);

    expect(real).toEqual([...REAL_PROBE_AXES]);
  });
});
