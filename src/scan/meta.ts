/**
 * `meta.json` — what this run was, and with what.
 *
 * Spec §6 makes one requirement non-negotiable: every run records the catalogue
 * version and the version of *every* tool. Without it a comparison against last
 * quarter is not a comparison, it is two unrelated numbers — and Chrome drifting
 * a minor version is enough to move a CLS reading (spec §9).
 *
 * This is the only artifact that carries wall-clock time. `findings.json` must
 * be byte-identical across runs, so nothing time-dependent is allowed to leak
 * into it; the timestamps live here instead.
 */
import type { Axis, Mode } from '../catalog/index.ts';
import { CATALOG_VERSION } from '../catalog/index.ts';
import { VERSION } from '../version.ts';
import type { ProbeOutcome } from './probe.ts';
import { RAW_SCHEMA_VERSION } from './raw.ts';
import { SUMMARY_SCHEMA_VERSION } from './summary.ts';

export const META_SCHEMA_VERSION = 'webdiag.meta/1';

export type ToolRecord = {
  readonly axis: Axis;
  readonly name: string;
  readonly version: string;
  readonly status: ProbeOutcome['status'];
  readonly error: string | undefined;
};

export type Meta = {
  readonly schema: typeof META_SCHEMA_VERSION;
  readonly webdiag: string;
  readonly catalogVersion: string;
  readonly schemas: {
    readonly raw: string;
    readonly summary: string;
  };
  readonly target: {
    readonly url: string;
    readonly mode: Mode;
    readonly pages: number;
    readonly repo: string | undefined;
    readonly axes: readonly Axis[];
  };
  readonly run: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
  };
  readonly runtime: {
    readonly engine: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly tools: readonly ToolRecord[];
  readonly artifacts: readonly string[];
};

export type MetaInput = {
  readonly url: string;
  readonly mode: Mode;
  readonly pages: number;
  readonly repo?: string | undefined;
  readonly axes: readonly Axis[];
  readonly outcomes: readonly ProbeOutcome[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly artifacts: readonly string[];
  readonly runtime: Meta['runtime'];
};

export function buildMeta(input: MetaInput): Meta {
  return {
    schema: META_SCHEMA_VERSION,
    webdiag: VERSION,
    catalogVersion: CATALOG_VERSION,
    schemas: {
      raw: RAW_SCHEMA_VERSION,
      summary: SUMMARY_SCHEMA_VERSION,
    },
    target: {
      url: input.url,
      mode: input.mode,
      pages: input.pages,
      repo: input.repo,
      axes: input.axes,
    },
    run: {
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    },
    runtime: input.runtime,
    tools: input.outcomes.map((outcome) => ({
      axis: outcome.axis,
      name: outcome.tool.name,
      version: outcome.tool.version,
      status: outcome.status,
      error: outcome.status === 'failed' ? outcome.error : undefined,
    })),
    artifacts: input.artifacts,
  };
}
