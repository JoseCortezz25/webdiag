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
import { mergeObservations, pageObservations, toObservations } from './checks.ts';
import { collect, collectSite } from './collect.ts';
import { siteObservations } from './deep-checks.ts';
import { lycheeVersion } from './links.ts';
import type { SiteAnalysis } from './site.ts';
import { xmllintVersion } from './sitemap.ts';

const AXIS: Axis = 'SEO';

/**
 * The identity before the external tools have been asked their version. This is
 * what `meta.json` records when the probe fails outright, which is honest: at
 * that point neither lychee nor xmllint contributed anything.
 */
export const SEO_TOOL: ToolVersion = { name: 'webdiag-seo', version: VERSION };

export type SeoCollector = (context: ProbeContext) => Promise<SeoAnalysis>;
export type SeoSiteCollector = (context: ProbeContext) => Promise<SiteAnalysis>;

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

/**
 * Everything a `deep` run says about one site.
 *
 * The composition is the whole design of the mode. Per-page checks run on every
 * sampled page and are folded by `mergeObservations`, so "eight pages have no
 * meta description" is one finding with `count: 8` (spec §6). Site-wide checks —
 * robots.txt, the sitemap, the link report — run once, on the seed, through the
 * unchanged `toObservations`. Cross-page checks are the eight IDs that could not
 * exist in `quick` at all.
 *
 * The coverage note is not decoration. A report that lists eight pages' worth of
 * findings without saying eight pages were read invites the reader to assume the
 * whole site was, and spec §7 is explicit that a narrowed run has to say so.
 */
function deepDocument(site: SiteAnalysis, context: ProbeContext, tool: ToolVersion): RawDocument {
  const deep = siteObservations(site);

  const observations = mergeObservations([
    toObservations(site.seed),
    ...site.pages.slice(1).map((page) => pageObservations(page.analysis)),
    deep.observations,
  ]);

  const coverage = `Crawl profundo: ${site.pages.length} página(s) analizada(s) de ${site.candidateCount + 1} candidata(s) del sitio.`;

  return {
    schema: RAW_SCHEMA_VERSION,
    axis: AXIS,
    tool,
    target: { url: context.url, mode: context.mode },
    observations,
    notes: [coverage, ...site.notes, ...deep.notes],
  };
}

export function seoProbe(
  gather: SeoCollector = (context) => collect(context.url),
  gatherSite: SeoSiteCollector = (context) => collectSite(context.url, context.pages),
): Probe {
  return {
    axis: AXIS,
    tool: SEO_TOOL,
    async run(context: ProbeContext): Promise<RawDocument> {
      if (context.mode === 'deep') {
        const [site, tool] = await Promise.all([gatherSite(context), resolveToolVersion()]);

        return deepDocument(site, context, tool);
      }

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
