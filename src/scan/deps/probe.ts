/**
 * The DEPS probe (spec §5.1: "Dependencias → retire.js sobre los bundles").
 *
 * It wires three pieces that each know one thing — `analyze.ts` gathers, the
 * adapter interprets, and the catalogue (reached later, in the normalizer)
 * decides what any of it is worth — and stamps the tool identity.
 *
 * The analyzer is a constructor parameter, which is the same seam the A11Y
 * probe uses: it lets the whole probe be driven from bundles already on disk,
 * and it is where a future white-box run would inject an analysis built from
 * lockfiles instead of from downloads.
 */
import type { Axis } from '../../catalog/index.ts';
import type { Probe, ProbeContext } from '../probe.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type ToolVersion } from '../raw.ts';
import { type DepsAnalysis, toObservations } from './adapter.ts';
import { analyzeServedBundles } from './analyze.ts';
import { RETIRE_TOOL } from './retire.ts';

const AXIS: Axis = 'DEPS';

export type DepsAnalyzer = (context: ProbeContext) => Promise<DepsAnalysis>;

/**
 * Spec §6 requires the version of every tool that measured, "incluida la de
 * Chrome". The browser is carried as build metadata on the retire.js version:
 * one string, both facts, and `meta.json` keeps its shape.
 */
function toolFor(analysis: DepsAnalysis): ToolVersion {
  return {
    name: RETIRE_TOOL.name,
    version: `${RETIRE_TOOL.version}+chrome-${analysis.collection.browser.version}`,
  };
}

export function depsProbe(analyze: DepsAnalyzer = analyzeServedBundles): Probe {
  return {
    axis: AXIS,
    tool: RETIRE_TOOL,
    async run(context: ProbeContext): Promise<RawDocument> {
      const analysis = await analyze(context);

      return {
        schema: RAW_SCHEMA_VERSION,
        axis: AXIS,
        tool: toolFor(analysis),
        target: { url: context.url, mode: context.mode },
        observations: toObservations(analysis),
      };
    },
  };
}
