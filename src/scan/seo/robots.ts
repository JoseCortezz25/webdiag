/**
 * `robots.txt`: parse it, then answer questions with it.
 *
 * The matcher follows RFC 9309 rather than "does the path start with the
 * pattern", because the difference is the whole finding. `Disallow: /` plus
 * `Allow: /$` blocks the site except the home page; the naive reading calls it
 * a total block and files a blocking critical against a site that is fine.
 * Longest-match-wins with allow breaking ties is what a crawler actually does,
 * so it is what this does.
 *
 * A missing `robots.txt` is not a finding. The absence of the file means
 * "everything is allowed", which is the same answer as an empty file, and the
 * catalogue has no ID for it — correctly.
 */

export type RobotsRule = { readonly type: 'allow' | 'disallow'; readonly path: string };
export type RobotsGroup = {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
};
export type RobotsSyntaxError = {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
};

export type RobotsFile = {
  readonly status: number;
  readonly url: string;
  readonly present: boolean;
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  readonly errors: readonly RobotsSyntaxError[];
};

/** Fields a crawler recognises. Anything else is a syntax error, per RFC 9309 §2.2.4. */
const KNOWN_FIELDS = new Set([
  'user-agent',
  'allow',
  'disallow',
  'sitemap',
  'crawl-delay',
  'host',
  'clean-param',
  'request-rate',
  'visit-time',
  'noindex',
]);

type MutableGroup = { agents: string[]; rules: RobotsRule[] };

export function parseRobots(body: string, url: string, status: number): RobotsFile {
  const groups: MutableGroup[] = [];
  const sitemaps: string[] = [];
  const errors: RobotsSyntaxError[] = [];

  let current: MutableGroup | undefined;
  // A run of consecutive `User-agent` lines forms one group; the first rule after
  // them closes the run, so the next agent line has to start a new group.
  let acceptingAgents = false;

  const lines = body.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.split('#')[0]?.trim() ?? '';

    if (line === '') {
      continue;
    }

    const separator = line.indexOf(':');

    if (separator === -1) {
      errors.push({ line: index + 1, text: line, reason: 'line has no "field: value" separator' });
      continue;
    }

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (!KNOWN_FIELDS.has(field)) {
      errors.push({ line: index + 1, text: line, reason: `unknown directive '${field}'` });
      continue;
    }

    if (field === 'sitemap') {
      if (value === '') {
        errors.push({ line: index + 1, text: line, reason: 'Sitemap without a URL' });
      } else {
        sitemaps.push(value);
      }
      continue;
    }

    if (field === 'user-agent') {
      if (value === '') {
        errors.push({ line: index + 1, text: line, reason: 'User-agent without a value' });
        continue;
      }
      if (current === undefined || !acceptingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      if (current === undefined) {
        errors.push({
          line: index + 1,
          text: line,
          reason: `${field} before any User-agent line`,
        });
        continue;
      }
      acceptingAgents = false;
      current.rules.push({ type: field, path: value });
      continue;
    }

    // crawl-delay, host and friends are recognised but carry no meaning here.
    acceptingAgents = false;
  }

  return {
    status,
    url,
    present: status >= 200 && status < 300,
    groups: groups.map((group) => ({ agents: group.agents, rules: group.rules })),
    sitemaps,
    errors,
  };
}

/** Escapes a robots path pattern into a regex, keeping `*` and a trailing `$`. */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

/** The group that applies to `agent`: the most specific name match, else `*`. */
export function groupFor(robots: RobotsFile, agent: string): RobotsGroup | undefined {
  const needle = agent.toLowerCase();
  let best: RobotsGroup | undefined;
  let bestLength = -1;

  for (const group of robots.groups) {
    for (const candidate of group.agents) {
      const matches = candidate === '*' || needle.includes(candidate);
      if (matches && candidate.length > bestLength) {
        best = group;
        bestLength = candidate.length;
      }
    }
  }

  return best;
}

export type RobotsVerdict = {
  readonly allowed: boolean;
  /** The rule that decided it, so evidence can quote the line rather than a guess. */
  readonly rule: RobotsRule | undefined;
};

/**
 * Longest match wins; a tie goes to `Allow`. An empty `Disallow:` value means
 * "nothing is disallowed" and never matches.
 */
export function verdictFor(robots: RobotsFile, agent: string, path: string): RobotsVerdict {
  const group = groupFor(robots, agent);

  if (group === undefined) {
    return { allowed: true, rule: undefined };
  }

  let winner: RobotsRule | undefined;

  for (const rule of group.rules) {
    if (rule.path === '') {
      continue;
    }
    if (!patternToRegExp(rule.path).test(path)) {
      continue;
    }
    if (winner === undefined) {
      winner = rule;
      continue;
    }
    if (rule.path.length > winner.path.length) {
      winner = rule;
      continue;
    }
    if (rule.path.length === winner.path.length && rule.type === 'allow') {
      winner = rule;
    }
  }

  return { allowed: winner === undefined || winner.type === 'allow', rule: winner };
}

/** Path plus query of a URL, which is what robots patterns are matched against. */
export function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
