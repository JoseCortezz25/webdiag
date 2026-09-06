/**
 * The agent skill lives outside the type system.
 *
 * `.agents/skills/webdiag-report/scripts/build_report.py` restates three things
 * this codebase owns — the summary schema version, the axis list and the
 * severity list — because a Python script cannot import a TypeScript enum.
 * Nothing else notices when they drift, and the failure is silent: a renamed
 * axis simply stops being labelled in the client report.
 *
 * So the duplication is checked here rather than trusted. These tests read the
 * script as text and compare the literals against the source of truth.
 */
import { describe, expect, test } from 'bun:test';
import { AXES, SEVERITIES } from '../catalog/index.ts';
import { SUMMARY_SCHEMA_VERSION } from './summary.ts';

const SKILL_DIR = new URL('../../.agents/skills/webdiag-report/', import.meta.url).pathname;

async function read(name: string): Promise<string> {
  return await Bun.file(`${SKILL_DIR}${name}`).text();
}

function pythonTuple(source: string, name: string): readonly string[] {
  const match = source.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'));

  if (match?.[1] === undefined) {
    throw new Error(`build_report.py no declara la tupla ${name}`);
  }

  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1] as string);
}

describe('webdiag-report skill contract', () => {
  test('build_report.py pins the summary schema this CLI emits', async () => {
    const script = await read('scripts/build_report.py');

    expect(script).toContain(`SUMMARY_SCHEMA = "${SUMMARY_SCHEMA_VERSION}"`);
  });

  test('build_report.py knows exactly the six axes, in catalog order', async () => {
    const script = await read('scripts/build_report.py');

    expect(pythonTuple(script, 'AXES')).toEqual([...AXES]);
  });

  test('build_report.py knows exactly the five severities, worst first', async () => {
    const script = await read('scripts/build_report.py');

    expect(pythonTuple(script, 'SEVERITIES')).toEqual([...SEVERITIES]);
  });

  test('every axis has a client-facing label', async () => {
    const script = await read('scripts/build_report.py');
    const labelled = [...script.matchAll(/^ {4}"([A-Z0-9]+)": "/gm)].map((entry) => entry[1]);

    for (const axis of AXES) {
      expect(labelled).toContain(axis);
    }
  });

  test('the example summary is a real artifact of the current contract', async () => {
    const summary = JSON.parse(await read('examples/summary.example.json'));

    expect(summary.schema).toBe(SUMMARY_SCHEMA_VERSION);
    expect(summary.scoring.composite).toBeNull();
    expect(summary.byAxis.map((axis: { axis: string }) => axis.axis)).toEqual([...AXES]);
  });

  test('the example narrative cites only findings the example summary measured', async () => {
    const summary = JSON.parse(await read('examples/summary.example.json'));
    const narrative = JSON.parse(await read('examples/narrative.example.json'));

    type FindingLike = { readonly id: string };
    const measured = new Set<string>(
      summary.byAxis.flatMap((axis: { findings: FindingLike[]; lowConfidence: FindingLike[] }) =>
        [...axis.findings, ...axis.lowConfidence].map((finding) => finding.id),
      ),
    );

    const cited = narrative.priorities.flatMap(
      (priority: { findingIds: string[] }) => priority.findingIds,
    );

    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) {
      expect(measured).toContain(id);
    }
  });

  test('every blocking finding on the cover page is ranked by the example narrative', async () => {
    const summary = JSON.parse(await read('examples/summary.example.json'));
    const narrative = JSON.parse(await read('examples/narrative.example.json'));

    const cited = new Set<string>(
      narrative.priorities.flatMap((priority: { findingIds: string[] }) => priority.findingIds),
    );

    expect(summary.coverPage.length).toBeGreaterThan(0);
    for (const finding of summary.coverPage as { id: string }[]) {
      expect(cited).toContain(finding.id);
    }
  });

  test('the skill states that it reads summary.json and nothing else', async () => {
    const skill = await read('SKILL.md');

    expect(skill).toContain('summary.json');
    expect(skill).toMatch(/raw\/\*\.json/);
  });
});
