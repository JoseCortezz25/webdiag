/**
 * The A11Y probe (spec §5.1: "Accesibilidad → axe-core").
 *
 * It composes three pieces that each know one thing: the browser layer renders
 * and runs axe, the adapter turns that report into observations, and the
 * catalogue — reached later, in the normalizer — decides what any of it is
 * worth. This file only wires them and stamps the tool identity.
 *
 * The analyzer is a constructor parameter so a test can drive the probe from a
 * fixture. That is not test-only sugar: it is the same seam that will let a
 * future white-box run reuse an already-open page instead of launching a second
 * Chrome.
 */
import type { Axis } from '../../catalog/index.ts';
import type { Probe, ProbeContext } from '../probe.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type ToolVersion } from '../raw.ts';
import { type AxeAnalysis, toObservations } from './adapter.ts';
import { AXE_VERSION, analyzeWithBrowser } from './browser-runner.ts';

const AXIS: Axis = 'A11Y';

/**
 * The tool identity before a browser exists. `meta.json` records this when the
 * probe fails to launch, which is honest: at that point Chrome never ran, so
 * there is no Chrome version to report.
 */
export const AXE_TOOL: ToolVersion = { name: 'axe-core', version: AXE_VERSION };

export type AxeAnalyzer = (context: ProbeContext) => Promise<AxeAnalysis>;

/**
 * Spec §6 requires every run to record the version of every tool, "incluida la
 * de Chrome". `ToolVersion` is a name and a version, so the browser build is
 * carried as semver build metadata on the axe version — one string, both facts,
 * and `meta.json` keeps its shape.
 */
function toolFor(analysis: AxeAnalysis): ToolVersion {
  return {
    name: AXE_TOOL.name,
    version: `${analysis.report.testEngine.version}+chrome-${analysis.browser.version}`,
  };
}

export function a11yProbe(analyze: AxeAnalyzer = analyzeWithBrowser): Probe {
  return {
    axis: AXIS,
    tool: AXE_TOOL,
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
