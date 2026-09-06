/**
 * The orchestrator: probes → normalizer → artifacts.
 *
 * It owns the order and the I/O, and nothing else. No scoring lives here (that
 * is `scoring.ts`), no catalogue knowledge (that is `normalize.ts`), no markup
 * (that is `report.ts`). What it does own are the two guarantees the ticket is
 * actually about:
 *
 *  - **A failing probe narrows the run, it does not end it.** Probes are awaited
 *    with `runProbe`, which converts a throw into a `failed` outcome; the axis
 *    still appears in the report, with its tool marked failed.
 *  - **`findings.json` is a function of the raw data alone.** The clock, the
 *    machine and the probe completion order are kept out of it. Everything
 *    time-dependent is confined to `meta.json`.
 */
import { mkdir } from 'node:fs/promises';
import type { Axis, Finding, Mode } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import { buildMeta, type Meta } from './meta.ts';
import { normalize } from './normalize.ts';
import { type Probe, type ProbeContext, type ProbeOutcome, runProbe } from './probe.ts';
import { defaultProbes } from './probes.ts';
import type { RawDocument } from './raw.ts';
import { renderReport } from './report.ts';
import { buildSummary, type Summary } from './summary.ts';

export type ScanRequest = {
  readonly url: string;
  readonly mode: Mode;
  readonly axes: readonly Axis[];
  readonly pages: number;
  readonly out: string;
  readonly repo?: string | undefined;
};

/**
 * Where the artifacts go. Injected as one object rather than as loose callbacks
 * so a test cannot substitute the writer and still hit the real filesystem
 * through the directory call.
 */
export type ArtifactWriter = {
  ensureDir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
};

export type ScanOptions = {
  /** Injected so tests can drive a fixture, a failing probe or a partial set. */
  readonly probes?: readonly Probe[];
  /** Injected so `meta.json` is assertable. */
  readonly clock?: () => Date;
  readonly writer?: ArtifactWriter;
};

export type ScanResult = {
  readonly outDir: string;
  readonly artifacts: readonly string[];
  readonly findings: readonly Finding[];
  readonly summary: Summary;
  readonly meta: Meta;
};

/** Two spaces and a trailing newline: diffable, and stable across runs. */
export function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function joinPath(...segments: readonly string[]): string {
  return segments.join('/').replace(/\/{2,}/g, '/');
}

const FILESYSTEM_WRITER: ArtifactWriter = {
  async ensureDir(path) {
    await mkdir(path, { recursive: true });
  },
  async writeFile(path, contents) {
    await Bun.write(path, contents);
  },
};

function runtimeInfo(): Meta['runtime'] {
  return {
    engine: `bun@${Bun.version}`,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Runs every requested axis. Probes are started together because they are
 * independent by contract (spec §4: "paralelos"), and the results are re-ordered
 * into catalogue axis order afterwards so completion timing cannot reach the
 * artifacts.
 */
async function collect(
  probes: readonly Probe[],
  axes: readonly Axis[],
  context: ProbeContext,
): Promise<readonly ProbeOutcome[]> {
  const requested = new Set(axes);
  const selected = probes.filter((probe) => requested.has(probe.axis));
  const outcomes = await Promise.all(selected.map((probe) => runProbe(probe, context)));

  return [...outcomes].sort((left, right) => AXES.indexOf(left.axis) - AXES.indexOf(right.axis));
}

export async function runScan(
  request: ScanRequest,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const clock = options.clock ?? (() => new Date());
  const writer = options.writer ?? FILESYSTEM_WRITER;
  const probes = options.probes ?? defaultProbes();
  const startedAt = clock();

  const context: ProbeContext = {
    url: request.url,
    mode: request.mode,
    pages: request.pages,
    repo: request.repo,
  };

  const outcomes = await collect(probes, request.axes, context);
  const documents: readonly RawDocument[] = outcomes.flatMap((outcome) =>
    outcome.status === 'ok' ? [outcome.raw] : [],
  );

  const { findings, rejected } = normalize(documents);

  const summary = buildSummary({
    url: request.url,
    mode: request.mode,
    pages: request.pages,
    repo: request.repo,
    requestedAxes: request.axes,
    outcomes,
    findings,
    rejected,
  });

  const rawArtifacts = documents.map((document) => joinPath('raw', `${document.axis}.json`));
  const extraArtifacts = documents.flatMap((document) => Object.keys(document.artifacts ?? {}));
  const artifacts = [
    ...rawArtifacts,
    ...extraArtifacts,
    'findings.json',
    'summary.json',
    'meta.json',
    'report.html',
  ];

  const meta = buildMeta({
    url: request.url,
    mode: request.mode,
    pages: request.pages,
    repo: request.repo,
    axes: request.axes,
    outcomes,
    startedAt,
    finishedAt: clock(),
    artifacts,
    runtime: runtimeInfo(),
  });

  const files: readonly (readonly [string, string])[] = [
    ...documents.map(
      (document) => [joinPath('raw', `${document.axis}.json`), encodeJson(document)] as const,
    ),
    ...documents.flatMap((document) =>
      Object.entries(document.artifacts ?? {}).map(([name, contents]) => [name, contents] as const),
    ),
    ['findings.json', encodeJson(findings)] as const,
    ['summary.json', encodeJson(summary)] as const,
    ['meta.json', encodeJson(meta)] as const,
    ['report.html', renderReport(summary, meta)] as const,
  ];

  // `raw/` is part of the published output contract, so it exists even when
  // every probe failed and there is nothing to put in it.
  await writer.ensureDir(joinPath(request.out, 'raw'));

  for (const [name, contents] of files) {
    await writer.writeFile(joinPath(request.out, name), contents);
  }

  return {
    outDir: request.out,
    artifacts,
    findings,
    summary,
    meta,
  };
}
