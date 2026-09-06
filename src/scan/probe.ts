/**
 * The probe contract (spec §4, layer 1).
 *
 * Probes are idempotent, stateless and know nothing about scoring. The one rule
 * that shapes this file is "ningún fallo de probe tumba la corrida" (spec §7): a
 * probe that throws must degrade the diagnostic, never end it. That is why the
 * orchestrator never calls `Probe.run` directly — it calls `runProbe`, which
 * turns a rejection into a `failed` outcome the report can show honestly.
 */
import type { Axis, Mode } from '../catalog/index.ts';
import type { RawDocument, ToolVersion } from './raw.ts';

export type ProbeContext = {
  readonly url: string;
  readonly mode: Mode;
  /** Number of pages a `deep` run is allowed to sample. Always 1 in `quick`. */
  readonly pages: number;
  /** Path to the checkout, when the run is white-box. */
  readonly repo?: string | undefined;
};

export type Probe = {
  readonly axis: Axis;
  readonly tool: ToolVersion;
  run(context: ProbeContext): Promise<RawDocument>;
};

export type ProbeOutcome =
  | {
      readonly status: 'ok';
      readonly axis: Axis;
      readonly tool: ToolVersion;
      readonly raw: RawDocument;
    }
  | {
      readonly status: 'failed';
      readonly axis: Axis;
      readonly tool: ToolVersion;
      readonly error: string;
    };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Runs one probe and contains its failure to that probe's axis.
 *
 * On success the tool identity comes from the raw document, not from
 * `probe.tool`: a probe that drives an external binary only learns the exact
 * version that measured — the browser build, say — by running it, and spec §6
 * wants that one recorded. `probe.tool` is the declared identity and is what a
 * failed outcome reports, because at that point nothing ran and there is no
 * better answer.
 */
export async function runProbe(probe: Probe, context: ProbeContext): Promise<ProbeOutcome> {
  try {
    const raw = await probe.run(context);

    return {
      status: 'ok',
      axis: probe.axis,
      tool: raw.tool,
      raw,
    };
  } catch (cause) {
    return {
      status: 'failed',
      axis: probe.axis,
      tool: probe.tool,
      error: messageOf(cause),
    };
  }
}
