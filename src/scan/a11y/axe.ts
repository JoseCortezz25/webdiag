/**
 * The axe-core payload, validated at the browser boundary.
 *
 * The object this module describes is produced by `axe.run()` *inside the page*
 * and crosses back as plain JSON. Nothing in this process constructed it, so it
 * is untrusted input in exactly the same sense a network response is: a Chrome
 * upgrade, a CSP that ate the injection, or a page that shadowed `window.axe`
 * would all hand us something else. Parsing it here means such a run fails as
 * "the A11Y probe could not read the page" (spec §7 — the axis degrades, the run
 * survives) instead of throwing a `TypeError` three layers deeper.
 *
 * The schema is deliberately a *subset*: only the fields the adapter reads are
 * declared, so an axe minor release that adds keys is not a breaking change.
 */
import { z } from 'zod';

/**
 * axe reports `impact` as one of four levels, or `null` on a rule that has no
 * intrinsic impact. Kept as a plain string union rather than reused from the
 * catalogue: it is axe's vocabulary, not ours, and mapping it to `Severity`
 * is the normalizer's job through the catalogue, never a translation table here.
 */
export const AXE_IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;

export type AxeImpact = (typeof AXE_IMPACTS)[number];

/** Shadow DOM and iframe paths arrive as nested arrays of CSS selectors. */
const axeTargetSchema: z.ZodType<AxeTarget> = z.lazy(() =>
  z.union([z.string(), z.array(axeTargetSchema)]),
);

export type AxeTarget = string | readonly AxeTarget[];

export const axeNodeSchema = z.object({
  target: z.array(axeTargetSchema).readonly(),
  html: z.string(),
  impact: z.enum(AXE_IMPACTS).nullish(),
  failureSummary: z.string().nullish(),
});

export type AxeNode = z.infer<typeof axeNodeSchema>;

export const axeRuleResultSchema = z.object({
  /** The axe rule ID, e.g. `color-contrast`. Mapped to a catalogue ID by `mapping.ts`. */
  id: z.string().min(1),
  impact: z.enum(AXE_IMPACTS).nullish(),
  help: z.string(),
  helpUrl: z.string(),
  /** `wcag2aa`, `cat.forms`, `best-practice`… Used to report which criteria failed. */
  tags: z.array(z.string()).readonly(),
  nodes: z.array(axeNodeSchema).readonly(),
});

export type AxeRuleResult = z.infer<typeof axeRuleResultSchema>;

export const axeReportSchema = z.object({
  testEngine: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  /** The URL axe actually analysed — after redirects, not the one we asked for. */
  url: z.string(),
  violations: z.array(axeRuleResultSchema).readonly(),
  /** Rules axe could not decide on its own. This is the machine-visible half of
   *  the manual-review gap, and it is reported rather than dropped. */
  incomplete: z.array(axeRuleResultSchema).readonly(),
  passes: z.array(axeRuleResultSchema).readonly(),
});

export type AxeReport = z.infer<typeof axeReportSchema>;

export function parseAxeReport(input: unknown): AxeReport {
  return axeReportSchema.parse(input);
}

/**
 * Flattens one node target into a single selector string.
 *
 * Nested arrays mean the element lives inside an iframe or a shadow root; axe
 * gives the path from the outside in, and joining with `>>>` keeps that visible
 * instead of presenting a selector that would not match from the top document.
 */
export function formatTarget(target: readonly AxeTarget[]): string {
  return target
    .map((part) => (typeof part === 'string' ? part : formatTarget(part)))
    .filter((part) => part !== '')
    .join(' >>> ');
}

/** Lower is worse. Used to report the worst impact behind a merged finding. */
export function impactRank(impact: AxeImpact | null | undefined): number {
  const index = AXE_IMPACTS.indexOf(impact as AxeImpact);
  return index === -1 ? AXE_IMPACTS.length : index;
}

/** The WCAG success criteria behind a rule, without axe's internal categories. */
export function wcagTags(tags: readonly string[]): readonly string[] {
  return [...tags].filter((tag) => tag.startsWith('wcag')).sort();
}
