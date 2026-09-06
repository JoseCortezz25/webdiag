/**
 * Who `robots.txt` lets in.
 *
 * The catalogue is unusually explicit about this check: `AGENT-AI-BOTS-BLOCKED`
 * is `info`, "nunca un problema", because blocking AI crawlers is a legitimate
 * business decision and we have no standing to grade it. So this module reports
 * a fact — these agents are disallowed at the root — and stops there. It never
 * decides whether that is good.
 *
 * The parse follows the de-facto rules the crawlers themselves implement:
 * consecutive `User-agent` lines share the group that follows, matching is
 * case-insensitive, and an explicit group for a bot replaces the `*` group
 * rather than adding to it.
 */

/** The crawlers this axis is about. Names as their operators publish them. */
export const AI_USER_AGENTS: readonly string[] = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'PerplexityBot',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'meta-externalagent',
];

export type RobotsAnalysis = {
  /** False when robots.txt is absent or unreadable: nothing can be concluded. */
  readonly available: boolean;
  /** Agents disallowed at `/` by a group naming them, or by `*`. */
  readonly blocked: readonly string[];
  /** True when the catch-all group disallows the root for everyone. */
  readonly wildcardBlocksRoot: boolean;
  readonly groups: number;
};

type Group = {
  readonly agents: readonly string[];
  readonly disallow: readonly string[];
  readonly allow: readonly string[];
};

function parseLine(line: string): { readonly field: string; readonly value: string } | undefined {
  const withoutComment = line.split('#')[0] ?? '';
  const separator = withoutComment.indexOf(':');

  if (separator < 0) {
    return undefined;
  }

  return {
    field: withoutComment.slice(0, separator).trim().toLowerCase(),
    value: withoutComment.slice(separator + 1).trim(),
  };
}

/** Splits the file into groups. Consecutive `User-agent` lines share one group. */
export function parseGroups(body: string): readonly Group[] {
  const groups: Group[] = [];
  let agents: string[] = [];
  let disallow: string[] = [];
  let allow: string[] = [];
  let collectingAgents = false;

  const flush = (): void => {
    if (agents.length > 0) {
      groups.push({ agents, disallow, allow });
    }

    agents = [];
    disallow = [];
    allow = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const parsed = parseLine(line);

    if (parsed === undefined) {
      continue;
    }

    if (parsed.field === 'user-agent') {
      if (!collectingAgents) {
        flush();
        collectingAgents = true;
      }

      agents.push(parsed.value.toLowerCase());
      continue;
    }

    collectingAgents = false;

    if (parsed.field === 'disallow') {
      disallow.push(parsed.value);
    } else if (parsed.field === 'allow') {
      allow.push(parsed.value);
    }
  }

  flush();

  return groups;
}

/** True when the group forbids `/` and does not re-open it with an `Allow`. */
function blocksRoot(group: Group): boolean {
  const forbidsRoot = group.disallow.some((path) => path === '/');
  const reopensRoot = group.allow.some((path) => path === '/');

  return forbidsRoot && !reopensRoot;
}

function groupFor(groups: readonly Group[], agent: string): Group | undefined {
  const wanted = agent.toLowerCase();
  return groups.find((group) => group.agents.includes(wanted));
}

/**
 * Resolves each AI agent against the file. An agent with its own group is judged
 * by that group alone; the rest inherit `*`.
 */
export function analyzeRobots(body: string): RobotsAnalysis {
  const groups = parseGroups(body);
  const wildcard = groupFor(groups, '*');
  const wildcardBlocksRoot = wildcard !== undefined && blocksRoot(wildcard);

  const blocked = AI_USER_AGENTS.filter((agent) => {
    const own = groupFor(groups, agent);
    return own === undefined ? wildcardBlocksRoot : blocksRoot(own);
  });

  return {
    available: true,
    blocked,
    wildcardBlocksRoot,
    groups: groups.length,
  };
}

/** What we know when robots.txt could not be read: nothing. */
export function unavailableRobots(): RobotsAnalysis {
  return { available: false, blocked: [], wildcardBlocksRoot: false, groups: 0 };
}
