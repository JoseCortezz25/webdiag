/**
 * Reading the HTML the way an agent without a browser reads it.
 *
 * This is deliberately a scanner over the served bytes, not a DOM. That is not a
 * shortcut, it is the measurement: `AGENT-NO-JS-CONTENT-EMPTY` asks what the
 * page delivers *before* any script runs, so parsing the response as text is
 * exactly the vantage point of the client we are modelling. Rendering it in
 * Chrome first would answer a different question — and one the A11Y axis
 * already answers with axe.
 *
 * The cost of that choice is precision, and it is paid honestly: every count
 * this module produces ends up in `evidence`, so a reader can disagree with the
 * number instead of having to trust it.
 */

import { elementSpans, stripElements } from '../text/html-scan.ts';

/** Landmark elements a text-mode agent can navigate by. */
const LANDMARK_TAGS = ['main', 'nav', 'header', 'footer', 'aside'] as const;

/** ARIA equivalents, for pages that build landmarks out of `div`s. */
const LANDMARK_ROLES = [
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'form',
  'region',
] as const;

export type HtmlAnalysis = {
  /** Characters of visible text in `<body>` once scripts and markup are gone. */
  readonly textLength: number;
  /** Landmarks found, as `main`, `role=navigation`, … Sorted, deduplicated. */
  readonly landmarks: readonly string[];
  readonly scripts: number;
  readonly noscriptBlocks: number;
  readonly jsonLdBlocks: number;
  /** Blocks that actually parse. An unparseable block declares nothing. */
  readonly jsonLdValid: number;
  readonly jsonLdTypes: readonly string[];
  /** `itemscope` attributes: structured data in a form that is not JSON-LD. */
  readonly microdataItems: number;
  readonly interactiveTotal: number;
  /** Links and buttons with no text, no `aria-label` and no labelled image. */
  readonly interactiveUnnamed: number;
};

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

function bodyOf(html: string): string {
  const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return match?.[1] ?? html;
}

/** The handful of entities that actually move a text-length measurement. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

/** Elements whose content is never visible text. */
const INERT_ELEMENTS = ['script', 'style', 'template', 'noscript'] as const;

/** Visible text: markup, scripts, styles and inert templates removed. */
function visibleText(html: string): string {
  return decodeEntities(stripTags(stripElements(html, INERT_ELEMENTS)))
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

function findLandmarks(body: string): readonly string[] {
  const found = new Set<string>();

  for (const tag of LANDMARK_TAGS) {
    if (new RegExp(`<${tag}\\b`, 'i').test(body)) {
      found.add(tag);
    }
  }

  for (const role of LANDMARK_ROLES) {
    if (new RegExp(`role\\s*=\\s*["']?${role}\\b`, 'i').test(body)) {
      found.add(`role=${role}`);
    }
  }

  return [...found].sort();
}

type JsonLd = {
  readonly blocks: number;
  readonly valid: number;
  readonly types: readonly string[];
};

/** Collects `@type` from an arbitrarily nested JSON-LD payload. */
function collectTypes(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTypes(item, into);
    }
    return;
  }

  if (typeof value !== 'object' || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;
  const type = record['@type'];

  if (typeof type === 'string') {
    into.add(type);
  } else if (Array.isArray(type)) {
    for (const item of type) {
      if (typeof item === 'string') {
        into.add(item);
      }
    }
  }

  const graph = record['@graph'];

  if (graph !== undefined) {
    collectTypes(graph, into);
  }
}

function readJsonLd(html: string): JsonLd {
  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const types = new Set<string>();
  let blocks = 0;
  let valid = 0;

  for (const match of html.matchAll(pattern)) {
    blocks += 1;

    try {
      const parsed: unknown = JSON.parse(match[1] ?? '');
      valid += 1;
      collectTypes(parsed, types);
    } catch {
      // An unparseable block is counted but declares nothing: `valid` stays put.
    }
  }

  return { blocks, valid, types: [...types].sort() };
}

type Named = {
  readonly total: number;
  readonly unnamed: number;
};

function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=\\s*["'][^"']*\\S[^"']*["']`, 'i').test(tag);
}

/** An image with a non-empty `alt` names the control that wraps it. */
function hasLabelledImage(inner: string): boolean {
  for (const match of inner.matchAll(/<img\b[^>]*>/gi)) {
    if (hasAttribute(match[0], 'alt')) {
      return true;
    }
  }

  return false;
}

function isNamed(openTag: string, inner: string): boolean {
  return (
    visibleText(inner).length > 0 ||
    hasAttribute(openTag, 'aria-label') ||
    hasAttribute(openTag, 'aria-labelledby') ||
    hasAttribute(openTag, 'title') ||
    hasLabelledImage(inner)
  );
}

/**
 * Counts links and buttons an agent could not address by name.
 *
 * Anchors without `href` are skipped: they are not controls, and counting them
 * would inflate the number with markup that no client treats as interactive.
 */
/**
 * How many controls one page is examined for. Past this the counts are lower
 * bounds; no real page has this many links, and a page that does is trying to
 * make the probe do quadratic work.
 */
const MAX_CONTROLS = 20_000;

function countNamed(body: string): Named {
  let total = 0;
  let unnamed = 0;

  // `elementSpans` hands back disjoint contents in linear time. The regex it
  // replaces — `<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>` — re-scanned to the end
  // of the document for every unclosed `<a>`, which on a 2 MB body meant
  // minutes of blocked event loop under the control of the page being scanned.
  for (const { tag, attributes, inner } of elementSpans(body, ['a', 'button'], MAX_CONTROLS)) {
    if (tag === 'a' && !hasAttribute(`<a ${attributes}>`, 'href')) {
      continue;
    }

    total += 1;

    if (!isNamed(`<${tag} ${attributes}>`, inner)) {
      unnamed += 1;
    }
  }

  return { total, unnamed };
}

export function analyzeHtml(html: string): HtmlAnalysis {
  const document = stripComments(html);
  const body = bodyOf(document);
  const jsonLd = readJsonLd(document);
  const named = countNamed(body);

  return {
    textLength: visibleText(body).length,
    landmarks: findLandmarks(body),
    scripts: countMatches(document, /<script\b/gi),
    noscriptBlocks: countMatches(document, /<noscript\b/gi),
    jsonLdBlocks: jsonLd.blocks,
    jsonLdValid: jsonLd.valid,
    jsonLdTypes: jsonLd.types,
    microdataItems: countMatches(document, /\bitemscope\b/gi),
    interactiveTotal: named.total,
    interactiveUnnamed: named.unnamed,
  };
}
