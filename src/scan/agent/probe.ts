/**
 * The AGENT probe (spec §5.1: "Agent-readiness → probe propio").
 *
 * It gathers four things over HTTP — the page as served, `robots.txt`,
 * `/llms.txt` and a short list of `/.well-known/` endpoints — and hands them to
 * `toObservations`, which owns every rule. The split is what keeps the axis
 * testable: this file has the network and no judgement, `observations.ts` has
 * the judgement and no network.
 *
 * The page fetch is the only hard dependency. If the site does not answer there
 * is nothing to evaluate, so the probe throws and `runProbe` turns that into a
 * `failed` outcome: the axis still appears in the report, marked as unmeasured,
 * and the other five axes are untouched (spec §7).
 *
 * `mode` and `pages` are recorded but do not change the measurement: this axis
 * has no crawler yet, so a `deep` run inspects the same single URL a `quick` run
 * does. Claiming otherwise in the raw document would be the one thing the
 * pipeline cannot recover from.
 */
import type { Axis } from '../../catalog/index.ts';
import type { Probe, ProbeContext } from '../probe.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type ToolVersion } from '../raw.ts';
import { analyzeHtml } from './html.ts';
import { type Fetcher, httpFetcher, isPresent, resolveFromRoot } from './http.ts';
import { type AgentSignals, toObservations } from './observations.ts';
import { LLMS_TXT_PATH, probeResource, probeResources, WELL_KNOWN_PATHS } from './resources.ts';
import { analyzeRobots, type RobotsAnalysis, unavailableRobots } from './robots.ts';

const AXIS: Axis = 'AGENT';

/**
 * The probe is its own tool, so it carries its own version. It is bumped when a
 * rule or a threshold changes, independently of the CLI: two runs that report
 * the same tool version must have applied the same rules.
 */
export const AGENT_TOOL: ToolVersion = { name: 'webdiag-agent', version: '1.0.0' };

/** Path the finding is attributed to, so `affected` reads like the site's map. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

async function readRobots(fetcher: Fetcher, url: string): Promise<RobotsAnalysis> {
  const response = await fetcher(resolveFromRoot(url, '/robots.txt'));

  return isPresent(response) ? analyzeRobots(response.body) : unavailableRobots();
}

/** Collects every signal the observation rules need. One round trip per resource. */
export async function collectSignals(
  fetcher: Fetcher,
  context: ProbeContext,
): Promise<AgentSignals> {
  const page = await fetcher(context.url);

  if (page.status === null) {
    throw new Error(`No se pudo obtener ${context.url}: ${page.error ?? 'error desconocido'}`);
  }

  if (page.status >= 400) {
    throw new Error(`${context.url} respondio ${page.status}: no hay pagina que evaluar.`);
  }

  const [robots, llmsTxt, wellKnown] = await Promise.all([
    readRobots(fetcher, context.url),
    probeResource(fetcher, context.url, LLMS_TXT_PATH),
    probeResources(fetcher, context.url, WELL_KNOWN_PATHS),
  ]);

  return {
    page: {
      path: pathOf(context.url),
      status: page.status,
      analysis: analyzeHtml(page.body),
    },
    robots,
    llmsTxt,
    wellKnown,
  };
}

/** The fetcher is injectable: the same seam a test uses, no test-only branch. */
export function agentProbe(fetcher: Fetcher = httpFetcher()): Probe {
  return {
    axis: AXIS,
    tool: AGENT_TOOL,
    async run(context: ProbeContext): Promise<RawDocument> {
      const signals = await collectSignals(fetcher, context);

      return {
        schema: RAW_SCHEMA_VERSION,
        axis: AXIS,
        tool: AGENT_TOOL,
        target: { url: context.url, mode: context.mode },
        observations: toObservations(signals),
      };
    },
  };
}
