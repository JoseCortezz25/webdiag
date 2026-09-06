/**
 * Linear-time scanning over served HTML for the two agent-facing measurements
 * that read raw bytes rather than a parsed tree.
 *
 * The obvious tool — `/<script\b[^>]*>[\s\S]*?<\/script>/gi` — is quadratic on
 * hostile input: every unclosed `<script` makes the lazy quantifier walk to the
 * end of the document before giving up, and a 2 MB body may hold a hundred
 * thousand of them. Measured at ~80 s of blocked event loop, outside any probe
 * timeout. The helpers here find closing tags once, then binary-search them, so
 * the cost is proportional to the document, not to its square.
 */

/** Start offsets of every `</tag` in `lower`, ascending. `lower` must be lower-cased. */
export function closingPositions(lower: string, tag: string): readonly number[] {
  const needle = `</${tag}`;
  const positions: number[] = [];
  let from = 0;

  for (;;) {
    const at = lower.indexOf(needle, from);

    if (at === -1) {
      return positions;
    }

    // `</a` must not match `</abbr`: the name has to end right there.
    const next = lower.charCodeAt(at + needle.length);
    const nameEnds = Number.isNaN(next) || next === 0x3e /* > */ || next <= 0x20;

    if (nameEnds) {
      positions.push(at);
    }

    from = at + needle.length;
  }
}

/** First position in `sorted` that is `>= index`, or undefined. Binary search. */
export function nextAtOrAfter(sorted: readonly number[], index: number): number | undefined {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    const value = sorted[middle];

    if (value !== undefined && value < index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return sorted[low];
}

/** Offset just past the `>` that ends the tag starting at `tagStart`, or the document end. */
function tagEnd(html: string, tagStart: number): number {
  const close = html.indexOf('>', tagStart);
  return close === -1 ? html.length : close + 1;
}

/**
 * Removes every `<tag …>…</tag>` element for the given tag names, replacing each
 * with a single space. An element that is never closed runs to the end of the
 * document, which is how a browser reads it too.
 */
export function stripElements(html: string, tags: readonly string[]): string {
  const lower = html.toLowerCase();
  const closes = new Map(tags.map((tag) => [tag, closingPositions(lower, tag)] as const));
  const open = new RegExp(`<(${tags.join('|')})\\b[^>]*>`, 'gi');

  const out: string[] = [];
  let cursor = 0;

  for (const match of html.matchAll(open)) {
    const start = match.index;

    if (start < cursor) {
      // Inside an element already removed.
      continue;
    }

    const tag = (match[1] ?? '').toLowerCase();
    const contentStart = start + match[0].length;
    const close = nextAtOrAfter(closes.get(tag) ?? [], contentStart);

    out.push(html.slice(cursor, start), ' ');
    cursor = close === undefined ? html.length : tagEnd(html, close);

    if (cursor >= html.length) {
      break;
    }
  }

  out.push(html.slice(cursor));
  return out.join('');
}

export type ElementSpan = {
  readonly tag: string;
  /** The attribute text between the tag name and `>`. */
  readonly attributes: string;
  /** The content up to the closing tag, or up to the next opening tag of the same name. */
  readonly inner: string;
};

/**
 * Every `<tag …>…</tag>` element for the given names, in document order, with
 * disjoint contents.
 *
 * An unclosed element ends where the next element of the same name opens —
 * which is what the HTML parser does with a nested `<a>` — so the contents
 * handed back never overlap and the total work stays linear. An element with
 * no closing tag anywhere after it is not reported, exactly as a regex that
 * required the closing tag would not have reported it. `limit` bounds how many
 * elements are examined; a document past it yields a lower bound.
 */
export function elementSpans(
  html: string,
  tags: readonly string[],
  limit: number,
): readonly ElementSpan[] {
  const lower = html.toLowerCase();
  const closes = new Map(tags.map((tag) => [tag, closingPositions(lower, tag)] as const));
  const open = new RegExp(`<(${tags.join('|')})\\b([^>]*)>`, 'gi');

  const opens: { tag: string; attributes: string; start: number; contentStart: number }[] = [];

  for (const match of html.matchAll(open)) {
    opens.push({
      tag: (match[1] ?? '').toLowerCase(),
      attributes: match[2] ?? '',
      start: match.index,
      contentStart: match.index + match[0].length,
    });

    if (opens.length >= limit) {
      break;
    }
  }

  // Where the next element of the same name opens, filled from the back.
  const nextSame = new Array<number | undefined>(opens.length);
  const lastSeen = new Map<string, number>();

  for (let index = opens.length - 1; index >= 0; index -= 1) {
    const entry = opens[index];

    if (entry === undefined) {
      continue;
    }

    nextSame[index] = lastSeen.get(entry.tag);
    lastSeen.set(entry.tag, entry.start);
  }

  const spans: ElementSpan[] = [];

  for (const [index, entry] of opens.entries()) {
    const close = nextAtOrAfter(closes.get(entry.tag) ?? [], entry.contentStart);

    if (close === undefined) {
      continue;
    }

    const end = Math.min(close, nextSame[index] ?? html.length);

    spans.push({
      tag: entry.tag,
      attributes: entry.attributes,
      inner: html.slice(entry.contentStart, end),
    });
  }

  return spans;
}
