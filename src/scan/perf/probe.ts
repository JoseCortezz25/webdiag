/**
 * The Performance probe (spec §5.1: Lighthouse, CrUX opcional).
 *
 * It is the first real probe, so it is also the first to test the promise in
 * spec §7 that "ningún probe puede tumbar la corrida". It keeps that promise by
 * doing nothing about it: `runProbe` already contains a throw to one axis, so
 * this module is free to throw loudly when the browser will not start or the
 * page will not paint, instead of returning a half-report that reads like a
 * measurement.
 *
 * The declared `tool` carries the pinned versions before anything runs, so a
 * failed probe still records *what would have measured it* in `meta.json`. On
 * success the raw document carries the versions actually used, which is what the
 * comparison against last quarter has to trust.
 */
import type { Probe, ProbeContext } from '../probe.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type ToolVersion } from '../raw.ts';
import { CHROME_TOOL_NAME, PINNED_CHROME_BUILD, type ResolvedChrome } from './chrome.ts';
import { type FieldData, fetchFieldData } from './crux.ts';
import { perfDetail } from './detail.ts';
import { type LighthouseRun, PINNED_LIGHTHOUSE_VERSION, runLighthouse } from './lighthouse.ts';
import { perfObservations } from './observations.ts';

export const LIGHTHOUSE_TOOL_NAME = 'lighthouse';

/** What the probe claims it will use, before it has confirmed anything. */
export const PINNED_PERF_TOOL: ToolVersion = {
  name: LIGHTHOUSE_TOOL_NAME,
  version: PINNED_LIGHTHOUSE_VERSION,
  components: [{ name: CHROME_TOOL_NAME, version: PINNED_CHROME_BUILD }],
};

export type PerfProbeOptions = {
  /** Injected in tests so the probe can be exercised without a browser. */
  readonly run?: (url: string) => Promise<LighthouseRun>;
  readonly field?: (url: string) => Promise<FieldData>;
  readonly env?: { readonly WEBDIAG_CRUX_API_KEY?: string | undefined };
};

/** `https://site.com/a/b?q=1` → `/a/b`. Falls back to the raw string. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function toolOf(chrome: ResolvedChrome, lighthouseVersion: string): ToolVersion {
  return {
    name: LIGHTHOUSE_TOOL_NAME,
    version: lighthouseVersion,
    components: [{ name: CHROME_TOOL_NAME, version: chrome.version }],
  };
}

export function lighthouseProbe(options: PerfProbeOptions = {}): Probe {
  const env = options.env ?? process.env;
  const execute = options.run ?? ((url: string) => runLighthouse(url));
  const field =
    options.field ?? ((url: string) => fetchFieldData({ url, apiKey: env.WEBDIAG_CRUX_API_KEY }));

  return {
    axis: 'PERF',
    tool: PINNED_PERF_TOOL,
    async run(context: ProbeContext): Promise<RawDocument> {
      // Started together: the CrUX lookup is a single HTTP call and has no
      // reason to sit behind a 40s page load.
      const [run, fieldData] = await Promise.all([execute(context.url), field(context.url)]);

      return {
        schema: RAW_SCHEMA_VERSION,
        axis: 'PERF',
        tool: toolOf(run.chrome, run.report.lighthouseVersion),
        target: { url: context.url, mode: context.mode },
        observations: perfObservations({
          report: run.report,
          path: pathOf(run.report.finalDisplayedUrl ?? context.url),
          field: fieldData,
        }),
        detail: perfDetail(run.report),
      };
    },
  };
}
