import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { defaultProbes, probeFor } from './probes.ts';
import { STUB_TOOL } from './stub-probe.ts';

describe('defaultProbes', () => {
  test('covers every axis, in catalog order', () => {
    expect(defaultProbes().map((probe) => probe.axis)).toEqual([...AXES]);
  });

  test('DEPS runs retire.js, not the fixture', () => {
    expect(probeFor('DEPS').tool.name).toBe('retire.js');
  });

  test('the axes phase 1 has not reached yet stay on the fixture', () => {
    for (const axis of AXES.filter((candidate) => candidate !== 'DEPS')) {
      expect(probeFor(axis).tool).toEqual(STUB_TOOL);
    }
  });
});
