/**
 * axe report → raw observations. Pure: no browser, no clock, no I/O.
 *
 * This is the seam `raw.ts` promises — "cada probe sigue escribiendo lo que
 * Lighthouse o axe-core produce de verdad, y trae un adaptador que lo mapea
 * sobre esta misma forma". Keeping it pure is what makes the interesting rules
 * testable from a fixture instead of from a live site:
 *
 *  - a rule with N failing nodes is *one* observation with `count: N` (spec §6),
 *    never N observations;
 *  - `A11Y-MANUAL-REVIEW-PENDING` is appended unconditionally, even on a page
 *    with zero violations, because that finding is the sentence that stops the
 *    report from reading as a certificate of compliance;
 *  - severity is never set here. The observation carries no `severity`, so the
 *    normalizer resolves it from the catalogue. That is how
 *    `A11Y-FORM-LABEL-MISSING` stays `high` and `A11Y-BUTTON-NAME-MISSING` stays
 *    a blocking `critical` without this file holding an opinion about either.
 */
import type { RawObservation, ToolVersion } from '../raw.ts';
import {
  type AxeImpact,
  type AxeNode,
  type AxeReport,
  type AxeRuleResult,
  formatTarget,
  impactRank,
  wcagTags,
} from './axe.ts';
import {
  A11Y_RULE_MAPPINGS,
  type A11yRuleMapping,
  MANUAL_REVIEW_ID,
  mappingForAxeRule,
} from './mapping.ts';

/** What the browser layer hands over. Everything else in this file is derived. */
export type AxeAnalysis = {
  readonly report: AxeReport;
  /** The Chrome that rendered the page. Recorded because a browser bump moves results. */
  readonly browser: ToolVersion;
  /** Final URL after redirects, so `affected` names the page actually audited. */
  readonly pageUrl: string;
  readonly httpStatus: number | undefined;
  /** True when navigation ran past its budget and axe read the page anyway. */
  readonly navigationTimedOut: boolean;
};

/** Enough selectors to recognise the problem; not a full dump of the DOM. */
const MAX_SAMPLES = 5;

/** Roughly the share of WCAG criteria automation can decide (Deque, WebAIM). */
const AUTOMATED_COVERAGE = '~57%';
const STANDARD = 'WCAG 2.2 AA';

type Sample = {
  readonly rule: string;
  readonly selector: string;
  readonly impact: AxeImpact | null;
  readonly summary: string | null;
};

type Accumulator = {
  readonly mapping: A11yRuleMapping;
  readonly axeRules: string[];
  readonly wcag: Set<string>;
  readonly samples: Sample[];
  count: number;
  worstImpact: AxeImpact | null;
  docRef: string | undefined;
  help: string | undefined;
};

/**
 * `affected` names pages, not elements (see the stub fixture): a finding that
 * repeats across a crawl merges by page, and the selectors live in `evidence`.
 */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function sampleOf(rule: AxeRuleResult, node: AxeNode): Sample {
  return {
    rule: rule.id,
    selector: formatTarget(node.target),
    impact: node.impact ?? rule.impact ?? null,
    summary: node.failureSummary ?? null,
  };
}

/**
 * `helpUrl` is read out of `axe.run`'s result, which was computed inside the
 * audited page. A page that tampers with it must not be able to reject its own
 * finding (the schema refuses non-http(s) references) or plant a `javascript:`
 * link in the report, so anything else is dropped and the finding keeps going.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function accumulate(accumulator: Accumulator, rule: AxeRuleResult): void {
  accumulator.axeRules.push(rule.id);
  accumulator.count += rule.nodes.length;

  for (const tag of wcagTags(rule.tags)) {
    accumulator.wcag.add(tag);
  }

  if (impactRank(rule.impact) < impactRank(accumulator.worstImpact)) {
    accumulator.worstImpact = rule.impact ?? null;
  }

  if (accumulator.docRef === undefined && isHttpUrl(rule.helpUrl)) {
    accumulator.docRef = rule.helpUrl;
  }

  if (accumulator.help === undefined) {
    accumulator.help = rule.help;
  }

  for (const node of rule.nodes) {
    if (accumulator.samples.length >= MAX_SAMPLES) {
      break;
    }
    accumulator.samples.push(sampleOf(rule, node));
  }
}

function toObservation(accumulator: Accumulator, path: string): RawObservation {
  const { mapping } = accumulator;

  return {
    id: mapping.catalogId,
    // axe violations are rule failures on a rendered DOM, not heuristics: if a
    // node is in `violations` the check ran and failed. Anything axe was unsure
    // about is in `incomplete`, and lands in the manual-review finding instead.
    confidence: 'high',
    count: accumulator.count,
    affected: [path],
    evidence: {
      axe_rules: accumulator.axeRules,
      nodes: accumulator.count,
      impact: accumulator.worstImpact,
      wcag: [...accumulator.wcag].sort(),
      ...(accumulator.help === undefined ? {} : { help: accumulator.help }),
      samples: accumulator.samples,
    },
    remediation: mapping.remediation,
    ...(accumulator.docRef === undefined ? {} : { doc_ref: accumulator.docRef }),
    ...(mapping.title === undefined ? {} : { title: mapping.title }),
  };
}

/** axe rules that failed and that this catalogue version has no ID for. */
function outsideCatalog(report: AxeReport): readonly { rule: string; nodes: number }[] {
  return report.violations
    .filter((rule) => mappingForAxeRule(rule.id) === undefined)
    .map((rule) => ({ rule: rule.id, nodes: rule.nodes.length }))
    .sort((left, right) => (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0));
}

/**
 * The finding that goes out on every single run.
 *
 * Its evidence is the honest inventory of what the automated pass did and did
 * not settle: how many rules passed, how many axe itself could not decide
 * (`incomplete`), and which failures fell outside the catalogue. A reader who
 * only sees the score should still be able to tell how much was never checked.
 */
function manualReviewObservation(analysis: AxeAnalysis, path: string): RawObservation {
  const { report } = analysis;
  const unresolved = [...report.incomplete].map((rule) => rule.id).sort();
  const unmapped = outsideCatalog(report);

  return {
    id: MANUAL_REVIEW_ID,
    confidence: 'high',
    count: 1,
    affected: [path],
    evidence: {
      standard: STANDARD,
      automated_coverage: AUTOMATED_COVERAGE,
      engine: `${report.testEngine.name}@${report.testEngine.version}`,
      browser: `${analysis.browser.name}@${analysis.browser.version}`,
      page_url: analysis.pageUrl,
      http_status: analysis.httpStatus ?? null,
      navigation_timed_out: analysis.navigationTimedOut,
      axe_rules_passed: report.passes.length,
      axe_rules_violated: report.violations.length,
      axe_rules_incomplete: report.incomplete.length,
      needs_human_review: unresolved,
      outside_catalog: unmapped,
    },
    remediation:
      'Complementar con revisión humana: cerca del 43% de los criterios WCAG exige juicio y ninguna herramienta automática lo cubre. Empezar por los checks marcados en needs_human_review.',
  };
}

/**
 * Turns one axe report into the observations for `raw/A11Y.json`.
 *
 * Deterministic by construction: mapped findings come out in
 * `A11Y_RULE_MAPPINGS` order, every list is either sorted or in axe's own DOM
 * order, and nothing reads the clock.
 */
export function toObservations(analysis: AxeAnalysis): readonly RawObservation[] {
  const path = pathOf(analysis.pageUrl);
  const accumulators = new Map<string, Accumulator>();

  for (const rule of analysis.report.violations) {
    const mapping = mappingForAxeRule(rule.id);

    if (mapping === undefined) {
      continue;
    }

    const existing = accumulators.get(mapping.catalogId);
    const accumulator: Accumulator = existing ?? {
      mapping,
      axeRules: [],
      wcag: new Set<string>(),
      samples: [],
      count: 0,
      worstImpact: null,
      docRef: undefined,
      help: undefined,
    };

    accumulate(accumulator, rule);
    accumulators.set(mapping.catalogId, accumulator);
  }

  const mapped = A11Y_RULE_MAPPINGS.flatMap((mapping) => {
    const accumulator = accumulators.get(mapping.catalogId);
    return accumulator === undefined ? [] : [toObservation(accumulator, path)];
  });

  return [...mapped, manualReviewObservation(analysis, path)];
}
