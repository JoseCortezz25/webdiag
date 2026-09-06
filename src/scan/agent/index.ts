/**
 * The AGENT probe. Import from here rather than reaching into the modules.
 */

export { analyzeHtml, type HtmlAnalysis } from './html.ts';
export {
  DEFAULT_TIMEOUT_MS,
  type Fetcher,
  type HttpResponse,
  httpFetcher,
  USER_AGENT,
} from './http.ts';
export {
  type AgentSignals,
  MIN_TEXT_CHARS,
  type PageSignals,
  toObservations,
} from './observations.ts';
export { AGENT_TOOL, agentProbe, collectSignals } from './probe.ts';
export {
  LLMS_TXT_PATH,
  type ResourceProbe,
  type ResourceState,
  WELL_KNOWN_PATHS,
} from './resources.ts';
export { AI_USER_AGENTS, analyzeRobots, type RobotsAnalysis, unavailableRobots } from './robots.ts';
