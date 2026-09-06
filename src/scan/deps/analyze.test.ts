import { describe, expect, test } from 'bun:test';
import { scanOrDegrade } from './analyze.ts';
import { RETIRE_VERSION } from './retire.ts';

describe('scanOrDegrade', () => {
  test('a retire.js that cannot run degrades to an empty report instead of throwing', async () => {
    const report = await scanOrDegrade('/tmp/webdiag-deps-no-such-directory-for-a-test');

    expect(report.data).toEqual([]);
    expect(report.version).toBe(RETIRE_VERSION);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('retire.js no pudo ejecutarse');
  });

  test('the degraded report still names the reason, so the axis can publish it', async () => {
    const report = await scanOrDegrade('/tmp/webdiag-deps-no-such-directory-for-a-test');

    expect(report.errors[0]).not.toBe('retire.js no pudo ejecutarse en este entorno: ');
  });
});
