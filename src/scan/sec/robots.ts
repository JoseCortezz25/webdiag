/**
 * `robots.txt`, honoured rather than acknowledged (spec §10).
 *
 * The rules implemented here are RFC 9309's, including the two that are easy to
 * skip and expensive to get wrong:
 *
 *  - **A 5xx is not a 404.** An unreachable robots.txt means "assume complete
 *    disallow", while an absent one (4xx) means "allow all". Collapsing both
 *    into "allow" turns a site's outage into our permission slip.
 *  - **Longest match wins, and `Allow` breaks the tie.** `Disallow: /` plus
 *    `Allow: /public/` permits `/public/x`, and a first-match-wins reader would
 *    refuse it.
 *
 * Only the target URL is ever checked, because this probe only ever fetches the
 * target URL. There is no crawl here to constrain.
 */
import { ROBOTS_TOKEN } from './agent.ts';
import { type CurlOptions, fetchText } from './curl.ts';

export type RobotsRule = {
  readonly allow: boolean;
  readonly pattern: string;
};

export type RobotsGroup = {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
};

export type RobotsDecision = {
  readonly allowed: boolean;
  /** Why, in one line, so the artifacts can say it out loud. */
  readonly reason: string;
  readonly status: number | undefined;
  /** The `User-agent:` value whose group decided this, when one did. */
  readonly matchedAgent: string | undefined;
};

/**
 * Splits robots.txt into groups. A run of consecutive `User-agent` lines opens
 * one group; the first rule line closes the agent list, and the next
 * `User-agent` after a rule starts a new group.
 */
export function parseRobots(body: string): readonly RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];

  const close = (): void => {
    if (agents.length > 0) {
      groups.push({ agents, rules });
    }
    agents = [];
    rules = [];
  };

  for (const raw of body.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? '';
    const separator = line.indexOf(':');

    if (separator <= 0) {
      continue;
    }

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (rules.length > 0) {
        close();
      }
      agents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') {
      continue;
    }

    if (agents.length === 0) {
      // A rule before any `User-agent` belongs to nobody. Ignored, not guessed at.
      continue;
    }

    rules.push({ allow: field === 'allow', pattern: value });
  }

  close();

  return groups;
}

/**
 * Picks the group that speaks to us: the longest `User-agent` value that is a
 * prefix of our product token, falling back to `*`. Longest wins so a site can
 * write a specific rule for us next to a blanket one.
 */
export function selectGroup(
  groups: readonly RobotsGroup[],
  token: string = ROBOTS_TOKEN,
): { readonly group: RobotsGroup; readonly agent: string } | undefined {
  const lowered = token.toLowerCase();
  let best: { group: RobotsGroup; agent: string } | undefined;

  for (const group of groups) {
    for (const agent of group.agents) {
      const matches = agent === '*' || lowered.startsWith(agent);

      if (!matches) {
        continue;
      }

      // `*` is the fallback, so any named match outranks it regardless of length.
      const rank = agent === '*' ? 0 : agent.length + 1;
      const bestRank = best === undefined ? -1 : best.agent === '*' ? 0 : best.agent.length + 1;

      if (rank > bestRank) {
        best = { group, agent };
      }
    }
  }

  return best;
}

/** Translates a robots pattern into a regex: `*` is any run, `$` anchors the end. */
function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

/** Length in characters of the pattern, which is RFC 9309's specificity measure. */
function specificity(rule: RobotsRule): number {
  return rule.pattern.length;
}

/**
 * Applies a group's rules to one path. Longest matching pattern wins; on a tie
 * `Allow` wins, which is what makes `Disallow: /` + `Allow: /x` mean what a site
 * owner expects it to mean.
 */
export function isAllowed(rules: readonly RobotsRule[], path: string): boolean {
  let winner: RobotsRule | undefined;

  for (const rule of rules) {
    // An empty `Disallow:` is the documented way to say "nothing is forbidden".
    if (rule.pattern === '') {
      continue;
    }

    if (!toRegExp(rule.pattern).test(path)) {
      continue;
    }

    if (winner === undefined || specificity(rule) > specificity(winner)) {
      winner = rule;
      continue;
    }

    if (specificity(rule) === specificity(winner) && rule.allow) {
      winner = rule;
    }
  }

  return winner === undefined ? true : winner.allow;
}

/** The path-plus-query a robots rule is matched against. */
export function requestPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export type RobotsOptions = CurlOptions & {
  /** Injected so the decision can be tested without a network. */
  readonly fetch?: typeof fetchText;
};

export function robotsUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/robots.txt`;
}

/** Fetches robots.txt for `url`'s origin and decides whether we may fetch `url`. */
export async function checkRobots(
  url: string,
  options: RobotsOptions = {},
): Promise<RobotsDecision> {
  const load = options.fetch ?? fetchText;
  const target = robotsUrl(url);

  let response: Awaited<ReturnType<typeof fetchText>>;

  try {
    response = await load(target, options);
  } catch (cause) {
    return {
      allowed: false,
      reason: `robots.txt at ${target} could not be fetched (${cause instanceof Error ? cause.message : String(cause)}); RFC 9309 treats an unreachable robots.txt as a full disallow.`,
      status: undefined,
      matchedAgent: undefined,
    };
  }

  if (response.status >= 400 && response.status < 500) {
    return {
      allowed: true,
      reason: `robots.txt returned ${response.status}: no rules published, so nothing is disallowed.`,
      status: response.status,
      matchedAgent: undefined,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      allowed: false,
      reason: `robots.txt returned ${response.status}; RFC 9309 treats an unreachable robots.txt as a full disallow.`,
      status: response.status,
      matchedAgent: undefined,
    };
  }

  const selected = selectGroup(parseRobots(response.body));

  if (selected === undefined) {
    return {
      allowed: true,
      reason: 'robots.txt has no group addressed to this user-agent.',
      status: response.status,
      matchedAgent: undefined,
    };
  }

  const path = requestPath(url);
  const allowed = isAllowed(selected.group.rules, path);

  return {
    allowed,
    reason: allowed
      ? `robots.txt group '${selected.agent}' allows ${path}.`
      : `robots.txt group '${selected.agent}' disallows ${path}.`,
    status: response.status,
    matchedAgent: selected.agent,
  };
}
