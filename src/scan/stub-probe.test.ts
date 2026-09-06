import { describe, expect, test } from 'bun:test';
import { ACTIVE_CATALOG_IDS, ALWAYS_EMITTED_IDS, AXES } from '../catalog/index.ts';
import { normalize } from './normalize.ts';
import type { ProbeContext } from './probe.ts';
import { parseRawDocument } from './raw.ts';
import { stubProbe, stubProbes } from './stub-probe.ts';

const QUICK: ProbeContext = { url: 'https://example.com', mode: 'quick', pages: 1 };

async function documentsFor(context: ProbeContext) {
  return Promise.all(stubProbes().map((probe) => probe.run(context)));
}

describe('stub probe', () => {
  test('covers every axis', async () => {
    const documents = await documentsFor(QUICK);

    expect(documents.map((document) => document.axis)).toEqual([...AXES]);
  });

  test('emits documents that satisfy the raw schema', async () => {
    for (const document of await documentsFor(QUICK)) {
      expect(() => parseRawDocument(document)).not.toThrow();
    }
  });

  test('only claims IDs a new run is allowed to emit', async () => {
    const active = new Set(ACTIVE_CATALOG_IDS);

    for (const document of await documentsFor(QUICK)) {
      for (const observation of document.observations) {
        expect(active.has(observation.id)).toBe(true);
      }
    }
  });

  test('always emits the three "we could not see this" findings', async () => {
    const { findings } = normalize(await documentsFor(QUICK));
    const ids = findings.map((finding) => finding.id);

    for (const id of ALWAYS_EMITTED_IDS) {
      expect(ids).toContain(id);
    }
  });

  test('does not claim a deep crawl found what a quick run found', async () => {
    const quick = await documentsFor(QUICK);
    const deep = await documentsFor({ ...QUICK, mode: 'deep', pages: 5 });

    const quickIds = normalize(quick).findings.map((finding) => finding.id);
    const deepIds = normalize(deep).findings.map((finding) => finding.id);

    expect(deepIds).not.toEqual(quickIds);
    expect(deepIds).toContain('SEO-REDIRECT-CHAIN');
    expect(quickIds).not.toContain('SEO-REDIRECT-CHAIN');
  });

  test('two calls cannot observe each other through the fixture', async () => {
    const first = await stubProbe('PERF').run(QUICK);
    const mutable = first.observations[0] as { count: number } | undefined;

    if (mutable !== undefined) {
      mutable.count = 999;
    }

    const second = await stubProbe('PERF').run(QUICK);

    expect(second.observations[0]?.count).toBe(1);
  });
});
