/**
 * robots.txt path patterns, matched without a regular expression.
 *
 * RFC 9309 patterns have exactly two special characters: `*` matches any run
 * of characters and a trailing `$` anchors the end. Translating that into a
 * regex is the obvious move and the wrong one: `/*a*a*a*a*a$` becomes
 * `^/.*a.*a.*a.*a.*a$`, and against a long path of `a`s the engine tries every
 * way of splitting the string across the five `.*` — polynomial time, on input
 * the site being scanned controls. The classic two-pointer wildcard match does
 * the same job in O(n·m) with no backtracking explosion.
 */

/**
 * True when `path` matches a robots pattern. The pattern is matched from the
 * start of the path; without a trailing `$` it may end anywhere.
 */
export function matchesRobotsPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  // Consecutive stars mean the same as one; collapsing them keeps the walk short.
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/\*{2,}/g, '*');
  // A pattern that is not anchored behaves as if it ended in `*`.
  const glob = anchored || body.endsWith('*') ? body : `${body}*`;

  let p = 0;
  let s = 0;
  let starAt = -1;
  let matchAt = 0;

  while (s < path.length) {
    if (p < glob.length && glob[p] === '*') {
      starAt = p;
      matchAt = s;
      p += 1;
    } else if (p < glob.length && glob[p] === path[s]) {
      p += 1;
      s += 1;
    } else if (starAt !== -1) {
      p = starAt + 1;
      matchAt += 1;
      s = matchAt;
    } else {
      return false;
    }
  }

  while (p < glob.length && glob[p] === '*') {
    p += 1;
  }

  return p === glob.length;
}
