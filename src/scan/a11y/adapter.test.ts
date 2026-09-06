import { describe, expect, test } from 'bun:test';
import { scoreAxis } from '../../catalog/index.ts';
import { normalize } from '../normalize.ts';
import { RAW_SCHEMA_VERSION, type RawDocument, type RawObservation } from '../raw.ts';
import { type AxeAnalysis, toObservations } from './adapter.ts';
import { axeReport, axeRule } from './fixture.ts';
import { MANUAL_REVIEW_ID } from './mapping.ts';

function analysis(overrides: Partial<AxeAnalysis> = {}): AxeAnalysis {
  return {
    report: axeReport(),
    browser: { name: 'chrome', version: '152.0.7977.75' },
    pageUrl: 'https://example.test/contacto',
    httpStatus: 200,
    navigationTimedOut: false,
    ...overrides,
  };
}

function withViolations(...violations: ReturnType<typeof axeRule>[]): AxeAnalysis {
  return analysis({ report: axeReport({ violations }) });
}

function byId(observations: readonly RawObservation[], id: string): RawObservation | undefined {
  return observations.find((observation) => observation.id === id);
}

/** Runs the observations through the real normalizer, as the orchestrator does. */
function findingsFor(observations: readonly RawObservation[]) {
  const document: RawDocument = {
    schema: RAW_SCHEMA_VERSION,
    axis: 'A11Y',
    tool: { name: 'axe-core', version: '4.13.0' },
    target: { url: 'https://example.test/contacto', mode: 'quick' },
    observations,
  };

  return normalize([document]);
}

describe('toObservations', () => {
  test('emits A11Y-MANUAL-REVIEW-PENDING on a page with zero violations', () => {
    // The point of the finding: a clean automated pass is not a clean site.
    const observations = toObservations(analysis());

    expect(observations).toHaveLength(1);
    expect(observations[0]?.id).toBe(MANUAL_REVIEW_ID);
  });

  test('emits A11Y-MANUAL-REVIEW-PENDING alongside real violations too', () => {
    const observations = toObservations(withViolations(axeRule('image-alt', ['img.hero'])));

    expect(observations.map((observation) => observation.id)).toContain(MANUAL_REVIEW_ID);
  });

  test('turns N failing nodes into one observation with count N', () => {
    const observations = toObservations(
      withViolations(axeRule('color-contrast', ['.nav a', '.nav b', 'footer p'])),
    );
    const contrast = byId(observations, 'A11Y-CONTRAST-INSUFFICIENT');

    expect(contrast?.count).toBe(3);
    expect(observations.filter((o) => o.id === 'A11Y-CONTRAST-INSUFFICIENT')).toHaveLength(1);
  });

  test('folds sibling axe rules into the single catalog ID that owns them', () => {
    const observations = toObservations(
      withViolations(axeRule('image-alt', ['img.a']), axeRule('svg-img-alt', ['svg.b', 'svg.c'])),
    );
    const images = byId(observations, 'A11Y-IMG-ALT-MISSING');

    expect(images?.count).toBe(3);
    expect(images?.evidence.axe_rules).toEqual(['image-alt', 'svg-img-alt']);
  });

  test('never sets severity, so the catalog stays the only authority on it', () => {
    const observations = toObservations(
      withViolations(axeRule('label', ['#email']), axeRule('button-name', ['button.submit'])),
    );

    for (const observation of observations) {
      expect(observation.severity).toBeUndefined();
    }
  });

  test('names the page in `affected` and keeps the selectors in evidence', () => {
    const observations = toObservations(withViolations(axeRule('label', ['#email'])));
    const labels = byId(observations, 'A11Y-FORM-LABEL-MISSING');

    expect(labels?.affected).toEqual(['/contacto']);
    expect(labels?.evidence.samples).toEqual([
      {
        rule: 'label',
        selector: '#email',
        impact: 'serious',
        summary: 'Fix any of the following: #email',
      },
    ]);
  });

  test('caps the selector samples without capping the count', () => {
    const selectors = Array.from({ length: 12 }, (_, index) => `.cell-${index}`);
    const observations = toObservations(withViolations(axeRule('color-contrast', selectors)));
    const contrast = byId(observations, 'A11Y-CONTRAST-INSUFFICIENT');

    expect(contrast?.count).toBe(12);
    expect(contrast?.evidence.samples).toHaveLength(5);
  });

  test('reports a violation the catalog has no ID for instead of dropping it', () => {
    const observations = toObservations(
      withViolations(axeRule('meta-viewport', ['meta']), axeRule('image-alt', ['img'])),
    );

    expect(byId(observations, 'A11Y-IMG-ALT-MISSING')).toBeDefined();
    expect(byId(observations, MANUAL_REVIEW_ID)?.evidence.outside_catalog).toEqual([
      { rule: 'meta-viewport', nodes: 1 },
    ]);
  });

  test('records what the automated pass could not settle', () => {
    const report = axeReport({
      violations: [],
      incomplete: [axeRule('color-contrast', ['.hero h1']), axeRule('aria-hidden-focus', ['#x'])],
      passes: [axeRule('html-has-lang', []), axeRule('region', [])],
    });
    const evidence = byId(toObservations(analysis({ report })), MANUAL_REVIEW_ID)?.evidence;

    expect(evidence?.axe_rules_incomplete).toBe(2);
    expect(evidence?.needs_human_review).toEqual(['aria-hidden-focus', 'color-contrast']);
    expect(evidence?.axe_rules_passed).toBe(2);
    expect(evidence?.automated_coverage).toBe('~57%');
  });

  test('records the browser and the engine that produced the reading', () => {
    const evidence = byId(toObservations(analysis()), MANUAL_REVIEW_ID)?.evidence;

    expect(evidence?.engine).toBe('axe-core@4.13.0');
    expect(evidence?.browser).toBe('chrome@152.0.7977.75');
    expect(evidence?.http_status).toBe(200);
    expect(evidence?.navigation_timed_out).toBe(false);
  });

  test('is deterministic: the same report yields the same observations', () => {
    const input = withViolations(
      axeRule('region', ['body']),
      axeRule('label', ['#a', '#b']),
      axeRule('color-contrast', ['.x']),
    );

    expect(JSON.stringify(toObservations(input))).toBe(JSON.stringify(toObservations(input)));
  });
});

describe('the catalog contract the probe has to honour', () => {
  test('A11Y-FORM-LABEL-MISSING lands as high and does not zero the axis', () => {
    const { findings } = findingsFor(toObservations(withViolations(axeRule('label', ['#email']))));
    const label = findings.find((finding) => finding.id === 'A11Y-FORM-LABEL-MISSING');

    expect(label?.severity).toBe('high');
    expect(scoreAxis('A11Y', findings).zeroed).toBe(false);
  });

  test('A11Y-BUTTON-NAME-MISSING zeroes the axis and reaches the cover', () => {
    const { findings } = findingsFor(
      toObservations(withViolations(axeRule('button-name', ['button.icon']))),
    );
    const score = scoreAxis('A11Y', findings);

    expect(findings.find((finding) => finding.id === 'A11Y-BUTTON-NAME-MISSING')?.severity).toBe(
      'critical',
    );
    expect(score.zeroed).toBe(true);
    expect(score.coverPage).toEqual(['A11Y-BUTTON-NAME-MISSING']);
  });

  test('A11Y-LANDMARKS-MISSING is scored by A11Y and only mentioned by AGENT', () => {
    const { findings } = findingsFor(toObservations(withViolations(axeRule('region', ['body']))));

    expect(scoreAxis('A11Y', findings).scored.map((finding) => finding.id)).toContain(
      'A11Y-LANDMARKS-MISSING',
    );

    const agent = scoreAxis('AGENT', findings);
    expect(agent.mentions.map((finding) => finding.id)).toContain('A11Y-LANDMARKS-MISSING');
    expect(agent.deductions).toEqual([]);
    expect(agent.score).toBe(100);
  });

  test('every observation the adapter emits is accepted by the catalog', () => {
    const { findings, rejected } = findingsFor(
      toObservations(
        withViolations(
          axeRule('color-contrast', ['.a']),
          axeRule('image-alt', ['img']),
          axeRule('label', ['#e']),
          axeRule('button-name', ['button']),
          axeRule('html-has-lang', ['html']),
          axeRule('heading-order', ['h3']),
          axeRule('aria-valid-attr-value', ['div']),
          axeRule('region', ['body']),
        ),
      ),
    );

    expect(rejected).toEqual([]);
    expect(findings).toHaveLength(9);
  });
});
