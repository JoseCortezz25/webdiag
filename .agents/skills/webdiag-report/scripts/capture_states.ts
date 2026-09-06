#!/usr/bin/env bun
/**
 * Screenshot capture for the Fase 4 agent-judgment layer.
 *
 * `build_report.py` marries measured evidence to written judgment; this script
 * is the other missing half for the four IDs the finding catalogue marks
 * "juicio del agente" (`docs/inbox/findings-catalog.md` phase 4):
 * `A11Y-ALT-NOT-DESCRIPTIVE`, `A11Y-FOCUS-NOT-VISIBLE`,
 * `A11Y-FOCUS-ORDER-ILLOGICAL`, `A11Y-KEYBOARD-TRAP`. None of them can come
 * from axe-core — axe only checks that an `alt` attribute exists, not whether
 * it says anything, and it never moves the mouse or presses Tab. Somebody has
 * to look at the page in those states, and only a model reading images does
 * that.
 *
 * This script never judges anything itself. It renders the page in the three
 * states the issue asks for (default, hover, focus) and writes a manifest
 * that points at the evidence: a full-page screenshot, one cropped screenshot
 * per Tab stop with its computed focus-indicator style, one before/after pair
 * per hovered control, and one screenshot per image that already has a
 * non-empty `alt` (empty-alt and missing-alt are axe-core's job already).
 *
 * The one piece of automated help it does add is a keyboard-trap *signal*:
 * three consecutive Tab presses landing on the exact same element is not
 * something a normal document produces on its own, so it is flagged for the
 * agent to confirm from the screenshots — never emitted as a finding by
 * itself.
 *
 * Usage:
 *   bun run .agents/skills/webdiag-report/scripts/capture_states.ts <url> \
 *     --out ./diag-2026-09-06/screenshots \
 *     [--max-tab-steps 25] [--hover-limit 12] [--alt-limit 30]
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { type ElementHandle, TimeoutError } from 'puppeteer';

const MANIFEST_SCHEMA = 'webdiag.screenshots/1';

/** Same fixed viewport as the A11Y probe, so the two runs stay comparable. */
const VIEWPORT = { width: 1366, height: 768, deviceScaleFactor: 1 } as const;

const NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TAB_STEPS = 25;
const DEFAULT_HOVER_LIMIT = 12;
const DEFAULT_ALT_LIMIT = 30;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]';
const HOVERABLE_SELECTOR = 'a[href], button:not([disabled]), [role="button"]';

type Rect = { x: number; y: number; width: number; height: number };

type FocusStep = {
  readonly step: number;
  readonly focusId: string | null;
  readonly tag: string;
  readonly accessibleName: string;
  readonly rect: Rect | null;
  readonly outline: string;
  readonly boxShadow: string;
  readonly screenshot: string | null;
  readonly repeatsPreviousStep: boolean;
};

type KeyboardTrapSignal = { readonly atStep: number; readonly focusId: string };

type HoverState = {
  readonly index: number;
  readonly tag: string;
  readonly accessibleName: string;
  readonly rect: Rect;
  readonly screenshotDefault: string | null;
  readonly screenshotHover: string | null;
  readonly styleDefault: Readonly<Record<string, string>>;
  readonly styleHover: Readonly<Record<string, string>>;
};

type AltAuditEntry = {
  readonly index: number;
  readonly alt: string;
  readonly src: string;
  readonly screenshot: string | null;
};

type Manifest = {
  readonly schema: string;
  readonly target: { readonly url: string; readonly finalUrl: string; readonly viewport: typeof VIEWPORT };
  readonly default: { readonly screenshot: string };
  readonly focusOrder: readonly FocusStep[];
  readonly keyboardTrapSignal: KeyboardTrapSignal | null;
  readonly hoverStates: readonly HoverState[];
  readonly altAudit: readonly AltAuditEntry[];
  readonly notes: readonly string[];
};

type Args = {
  readonly url: string;
  readonly outDir: string;
  readonly maxTabSteps: number;
  readonly hoverLimit: number;
  readonly altLimit: number;
};

function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  let outDir: string | undefined;
  let maxTabSteps = DEFAULT_MAX_TAB_STEPS;
  let hoverLimit = DEFAULT_HOVER_LIMIT;
  let altLimit = DEFAULT_ALT_LIMIT;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') {
      outDir = argv[(index += 1)];
    } else if (token === '--max-tab-steps') {
      maxTabSteps = Number(argv[(index += 1)]);
    } else if (token === '--hover-limit') {
      hoverLimit = Number(argv[(index += 1)]);
    } else if (token === '--alt-limit') {
      altLimit = Number(argv[(index += 1)]);
    } else if (token !== undefined) {
      positionals.push(token);
    }
  }

  const url = positionals[0];
  if (url === undefined || outDir === undefined) {
    throw new Error(
      'Usage: capture_states.ts <url> --out <dir> [--max-tab-steps N] [--hover-limit N] [--alt-limit N]',
    );
  }

  return { url, outDir, maxTabSteps, hoverLimit, altLimit };
}

function launchArgs(): readonly string[] {
  return process.env.WEBDIAG_CHROME_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-dev-shm-usage']
    : [];
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof TimeoutError;
}

function pad(value: number): string {
  return String(value).padStart(3, '0');
}

/** Clip rect padded and clamped to the viewport; `null` when nothing is visible. */
function clipFor(rect: Rect, padding: number): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const width = Math.min(VIEWPORT.width - x, Math.ceil(rect.width + padding * 2));
  const height = Math.min(VIEWPORT.height - y, Math.ceil(rect.height + padding * 2));

  if (width <= 4 || height <= 4) {
    return null;
  }

  return { x, y, width, height };
}

type ActiveElementInfo = {
  readonly focusId: string | null;
  readonly tag: string;
  readonly accessibleName: string;
  readonly rect: Rect;
  readonly outline: string;
  readonly boxShadow: string;
};

/** Marks every native tab stop so repeated identity checks survive re-renders. */
async function tagFocusables(page: import('puppeteer').Page): Promise<void> {
  await page.evaluate((selector: string) => {
    let next = 0;
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const tabindexAttr = el.getAttribute('tabindex');
      const tabindex = tabindexAttr === null ? 0 : Number(tabindexAttr);
      if (tabindex < 0 || Number.isNaN(tabindex)) {
        continue;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }
      el.setAttribute('data-webdiag-focus-id', String(next));
      next += 1;
    }
  }, FOCUSABLE_SELECTOR);
}

async function activeElementInfo(page: import('puppeteer').Page): Promise<ActiveElementInfo | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) {
      return null;
    }

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const accessibleName =
      el.getAttribute('aria-label') ??
      el.textContent?.trim().slice(0, 80) ??
      el.getAttribute('alt') ??
      el.getAttribute('title') ??
      '';

    return {
      focusId: el.getAttribute('data-webdiag-focus-id'),
      tag: el.tagName.toLowerCase(),
      accessibleName,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      outline:
        style.outlineStyle === 'none' || style.outlineWidth === '0px'
          ? 'none'
          : `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
      boxShadow: style.boxShadow,
    };
  });
}

/**
 * Walks Tab presses from the top of the document, recording what got focused.
 *
 * Stops early when focus leaves the document (the natural end of the tab
 * sequence) or when `maxTabSteps` is reached, whichever comes first. Three
 * identical `focusId`s in a row is the keyboard-trap signal: a normal page
 * never re-focuses the same node on consecutive presses on its own.
 */
async function walkFocusOrder(
  page: import('puppeteer').Page,
  focusDir: string,
  outDir: string,
  maxTabSteps: number,
): Promise<{ focusOrder: FocusStep[]; trapSignal: KeyboardTrapSignal | null; note: string }> {
  await tagFocusables(page);

  const focusOrder: FocusStep[] = [];
  let trapSignal: KeyboardTrapSignal | null = null;
  let consecutiveRepeats = 0;
  let previousFocusId: string | null = null;
  let note = `Se alcanzo el limite de ${maxTabSteps} pasos de tabulacion sin salir del documento.`;

  for (let step = 1; step <= maxTabSteps; step += 1) {
    await page.keyboard.press('Tab');
    const info = await activeElementInfo(page);

    if (info === null) {
      note = `El foco salio del documento de forma natural tras ${step - 1} paso(s).`;
      break;
    }

    const focusId = info.focusId ?? `unmarked-${step}`;
    const repeatsPreviousStep = focusId === previousFocusId;
    consecutiveRepeats = repeatsPreviousStep ? consecutiveRepeats + 1 : 0;
    previousFocusId = focusId;

    let screenshot: string | null = null;
    const clip = clipFor(info.rect, 24);
    if (clip !== null) {
      const file = path.join(focusDir, `${pad(step)}.png`);
      await page.screenshot({ path: file, clip });
      screenshot = path.relative(outDir, file);
    }

    focusOrder.push({
      step,
      focusId,
      tag: info.tag,
      accessibleName: info.accessibleName,
      rect: info.rect,
      outline: info.outline,
      boxShadow: info.boxShadow,
      screenshot,
      repeatsPreviousStep,
    });

    if (trapSignal === null && consecutiveRepeats >= 2) {
      trapSignal = { atStep: step, focusId };
    }
  }

  return { focusOrder, trapSignal, note };
}

async function captureHoverStates(
  page: import('puppeteer').Page,
  hoverDir: string,
  outDir: string,
  hoverLimit: number,
): Promise<HoverState[]> {
  const handles = (await page.$$(HOVERABLE_SELECTOR)) as ElementHandle<Element>[];
  const states: HoverState[] = [];

  for (const handle of handles) {
    if (states.length >= hoverLimit) {
      break;
    }

    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
    const box = await handle.boundingBox();
    if (box === null || box.width === 0 || box.height === 0) {
      continue;
    }

    const index = states.length + 1;
    const readStyle = () =>
      handle.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          color: style.color,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          textDecorationLine: style.textDecorationLine,
        };
      });
    const accessibleName = await handle.evaluate(
      (el) => el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 80) ?? '',
    );
    const tag = await handle.evaluate((el) => el.tagName.toLowerCase());

    const clip = clipFor(box, 16);
    const styleDefault = await readStyle();
    let screenshotDefault: string | null = null;
    if (clip !== null) {
      const file = path.join(hoverDir, `${pad(index)}-default.png`);
      await page.screenshot({ path: file, clip });
      screenshotDefault = path.relative(outDir, file);
    }

    await handle.hover();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 80)));

    const styleHover = await readStyle();
    let screenshotHover: string | null = null;
    if (clip !== null) {
      const file = path.join(hoverDir, `${pad(index)}-hover.png`);
      await page.screenshot({ path: file, clip });
      screenshotHover = path.relative(outDir, file);
    }

    states.push({
      index,
      tag,
      accessibleName,
      rect: box,
      screenshotDefault,
      screenshotHover,
      styleDefault,
      styleHover,
    });

    await page.mouse.move(0, 0);
  }

  return states;
}

/** `data:` URLs would bloat the manifest; every other src is kept whole. */
function truncateSrc(src: string): string {
  return src.startsWith('data:') ? `${src.slice(0, 40)}…(data URL, ${src.length} chars)` : src;
}

async function captureAltAudit(
  page: import('puppeteer').Page,
  altDir: string,
  outDir: string,
  altLimit: number,
): Promise<AltAuditEntry[]> {
  const handles = (await page.$$('img[alt]')) as ElementHandle<Element>[];
  const entries: AltAuditEntry[] = [];

  for (const handle of handles) {
    if (entries.length >= altLimit) {
      break;
    }

    const alt = await handle.evaluate((el) => el.getAttribute('alt') ?? '');
    if (alt.trim() === '') {
      // Empty alt or no alt: axe-core's A11Y-IMG-ALT-MISSING already owns this.
      continue;
    }

    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
    const box = await handle.boundingBox();
    const src = await handle.evaluate((el) => el.getAttribute('src') ?? el.getAttribute('currentSrc') ?? '');

    const index = entries.length + 1;
    let screenshot: string | null = null;
    const clip = box === null ? null : clipFor(box, 8);
    if (clip !== null) {
      const file = path.join(altDir, `${pad(index)}.png`);
      await page.screenshot({ path: file, clip });
      screenshot = path.relative(outDir, file);
    }

    entries.push({ index, alt, src: truncateSrc(src), screenshot });
  }

  return entries;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir);
  const focusDir = path.join(outDir, 'focus');
  const hoverDir = path.join(outDir, 'hover');
  const altDir = path.join(outDir, 'alt');

  await Promise.all([mkdir(focusDir, { recursive: true }), mkdir(hoverDir, { recursive: true }), mkdir(altDir, { recursive: true })]);

  const browser = await puppeteer.launch({ headless: true, args: [...launchArgs()] });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    let navigationTimedOut = false;
    try {
      await page.goto(args.url, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS });
    } catch (cause) {
      if (!isTimeout(cause)) {
        throw cause;
      }
      navigationTimedOut = true;
    }

    const defaultFile = path.join(outDir, 'default.png');
    await page.screenshot({ path: defaultFile, fullPage: true });

    const { focusOrder, trapSignal, note: focusNote } = await walkFocusOrder(
      page,
      focusDir,
      outDir,
      args.maxTabSteps,
    );
    const hoverStates = await captureHoverStates(page, hoverDir, outDir, args.hoverLimit);
    const altAudit = await captureAltAudit(page, altDir, outDir, args.altLimit);

    const notes: string[] = [focusNote];
    if (navigationTimedOut) {
      notes.push('La navegacion no llego a "networkidle2" dentro del limite: la pagina puede estar incompleta.');
    }

    const manifest: Manifest = {
      schema: MANIFEST_SCHEMA,
      target: { url: args.url, finalUrl: page.url(), viewport: VIEWPORT },
      default: { screenshot: path.relative(outDir, defaultFile) },
      focusOrder,
      keyboardTrapSignal: trapSignal,
      hoverStates,
      altAudit,
      notes,
    };

    await Bun.write(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`capture_states: ${outDir}`);
    console.log(`  default: 1 screenshot`);
    console.log(
      `  focus walk: ${focusOrder.length} step(s)${trapSignal ? ` — keyboard trap signal at step ${trapSignal.atStep}` : ''}`,
    );
    console.log(`  hover states: ${hoverStates.length} element(s)`);
    console.log(`  alt audit: ${altAudit.length} image(s) with non-empty alt`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
