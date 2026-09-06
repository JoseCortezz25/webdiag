/**
 * The SEO probe (spec §5.1: "SEO técnico → probe propio + lychee + xmllint").
 *
 * It wires three things that each know one job — `collect.ts` does the I/O,
 * `checks.ts` decides what the bytes mean, and the catalogue (reached later, in
 * the normalizer) decides what any of it is worth — and stamps the tool
 * identity. There is no logic of its own here on purpose: everything worth
 * testing lives on one side or the other of the `SeoAnalysis` seam.
 *
 * `collect` is a constructor parameter so a test can drive the probe from a
 * literal analysis, without a socket, a subprocess or a fixture server.
 */
import type { Axis } from '../../catalog/index.ts';
import { VERSION } from '../../version.ts';
import type { Probe, ProbeContext } from '../probe.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type ToolVersion } from '../raw.ts';
import type { SeoAnalysis } from './analysis.ts';
import { toObservations } from './checks.ts';
import { collect } from './collect.ts';
import { lycheeVersion } from './links.ts';
import { xmllintVersion } from './sitemap.ts';

const AXIS: Axis = 'SEO';

/**
 * The identity before the external tools have been asked their version. This is
 * what `meta.json` records when the probe fails outright, which is honest: at
 * that point neither lychee nor xmllint contributed anything.
 */
export const SEO_TOOL: ToolVersion = { name: 'webdiag-seo', version: VERSION };

export type SeoCollector = (context: ProbeContext) => Promise<SeoAnalysis>;

/**
 * Spec §6 requires the version of *every* tool in `meta.json`. `ToolVersion` is
 * one name and one version, so the two helpers ride along as semver build
 * metadata — one string, three facts, and `meta.json` keeps its shape. A tool
 * that was not found is recorded as `absent` rather than omitted, because "we
 * did not check your links" and "your links are fine" are different reports.
 */
export async function resolveToolVersion(): Promise<ToolVersion> {
  const [lychee, xmllint] = await Promise.all([lycheeVersion(), xmllintVersion()]);

  return {
    name: SEO_TOOL.name,
    version: `${VERSION}+lychee-${lychee ?? 'absent'}+libxml-${xmllint ?? 'absent'}`,
  };
}

export function seoProbe(gather: SeoCollector = (context) => collect(context.url)): Probe {
  return {
    axis: AXIS,
    tool: SEO_TOOL,
    async run(context: ProbeContext): Promise<RawDocument> {
      const [analysis, tool] = await Promise.all([gather(context), resolveToolVersion()]);

      return {
        schema: RAW_SCHEMA_VERSION,
        axis: AXIS,
        tool,
        target: { url: context.url, mode: context.mode },
        observations: toObservations(analysis),
      };
    },
  };
}
