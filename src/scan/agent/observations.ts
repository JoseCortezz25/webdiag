/**
 * Signals in, catalogue observations out. Pure, so every rule below is a unit
 * test rather than a network run.
 *
 * Three rules in here are contract, not preference:
 *
 *  1. **`AGENT-AI-BOTS-BLOCKED` is `info`, always.** The observation never sets
 *     a `severity` override, so the catalogue base (`info`, worth 0 points)
 *     stands. Blocking AI crawlers is a business decision; the report states it
 *     and does not grade it.
 *  2. **Landmarks are scored once, by A11Y.** When the only semantic defect is
 *     the absence of landmarks, this axis emits `A11Y-LANDMARKS-MISSING` — an
 *     ID the catalogue marks `mentionedIn: ['AGENT']` — so it deducts in A11Y
 *     and appears here as a mention. `AGENT-SEMANTICS-POOR` is reserved for the
 *     defect A11Y does *not* already price: controls an agent cannot name.
 *  3. **A check that could not run does not accuse.** A resource whose request
 *     never completed produces a `confidence: low` finding, which the report
 *     lists and the score ignores.
 */
import type { RawObservation } from '../raw.ts';
import type { HtmlAnalysis } from './html.ts';
import type { ResourceProbe } from './resources.ts';
import type { RobotsAnalysis } from './robots.ts';

/**
 * Below this many characters of script-free text, a page delivers nothing to a
 * client that does not execute JavaScript. Provisional: spec §5 leaves exact
 * thresholds to the calibration tickets, so the measured value and the threshold
 * both travel in `evidence` and can be argued with.
 */
export const MIN_TEXT_CHARS = 200;

export type PageSignals = {
  readonly path: string;
  readonly status: number;
  readonly analysis: HtmlAnalysis;
};

export type AgentSignals = {
  readonly page: PageSignals;
  readonly robots: RobotsAnalysis;
  readonly llmsTxt: ResourceProbe;
  readonly wellKnown: readonly ResourceProbe[];
};

/** Every AGENT finding repeats this. The axis is reported, never weighted in. */
const UNPROVEN = 'El impacto de este eje no esta probado.';

function noJsContent(signals: AgentSignals): readonly RawObservation[] {
  const { analysis, path } = signals.page;

  if (analysis.textLength >= MIN_TEXT_CHARS) {
    return [];
  }

  // A page with scripts and no text is a client-rendered shell, which is the
  // case this ID is about. A page with neither is empty for every client alike,
  // so the diagnosis is the same but the certainty is not.
  const clientRendered = analysis.scripts > 0;

  return [
    {
      id: 'AGENT-NO-JS-CONTENT-EMPTY',
      confidence: clientRendered ? 'high' : 'medium',
      count: 1,
      affected: [path],
      evidence: {
        text_chars: analysis.textLength,
        threshold_chars: MIN_TEXT_CHARS,
        scripts: analysis.scripts,
        noscript_blocks: analysis.noscriptBlocks,
        note: clientRendered
          ? 'El HTML servido no trae contenido: se pinta con JavaScript.'
          : 'El HTML servido no trae contenido y tampoco hay scripts que lo expliquen.',
      },
      remediation:
        'Servir el contenido principal en el HTML inicial (SSR o prerender) para que un cliente sin JavaScript lo reciba.',
    },
  ];
}

function aiBotsBlocked(signals: AgentSignals): readonly RawObservation[] {
  const { robots } = signals;

  if (!robots.available || robots.blocked.length === 0) {
    return [];
  }

  return [
    {
      id: 'AGENT-AI-BOTS-BLOCKED',
      // No `severity` override on purpose: the catalogue base `info` is the
      // contract, and this observation must never be able to raise it.
      confidence: 'high',
      count: robots.blocked.length,
      affected: ['/robots.txt'],
      evidence: {
        blocked: robots.blocked,
        via_wildcard: robots.wildcardBlocksRoot,
        groups: robots.groups,
        note: 'Hallazgo neutral: bloquear crawlers de IA es una decision de negocio legitima.',
      },
      remediation:
        'Ninguna accion requerida. Se reporta para que la decision sea explicita y no un efecto colateral del robots.txt.',
      title: `robots.txt bloquea ${robots.blocked.length} crawler(s) de IA`,
    },
  ];
}

function structuredData(signals: AgentSignals): readonly RawObservation[] {
  const { analysis, path } = signals.page;

  if (analysis.jsonLdValid > 0) {
    return [];
  }

  // Microdata declares the same entities in another vocabulary. The catalogue
  // ID is about JSON-LD specifically, so the finding stands — but at a
  // confidence that keeps it out of the arithmetic.
  const hasMicrodata = analysis.microdataItems > 0;

  return [
    {
      id: 'AGENT-STRUCTURED-DATA-MISSING',
      confidence: hasMicrodata ? 'low' : 'high',
      count: 1,
      affected: [path],
      evidence: {
        jsonld_blocks: analysis.jsonLdBlocks,
        jsonld_valid: analysis.jsonLdValid,
        microdata_items: analysis.microdataItems,
        note:
          analysis.jsonLdBlocks > 0
            ? 'Hay bloques JSON-LD pero ninguno parsea: no declaran nada.'
            : hasMicrodata
              ? 'Hay microdata: las entidades existen en otro vocabulario.'
              : 'No se declara ninguna entidad de forma estructurada.',
      },
      remediation:
        'Publicar JSON-LD (schema.org) que declare la organizacion y las entidades principales de cada pagina.',
    },
  ];
}

/** Shared shape for the two "flat file is missing" checks. */
function missingResource(
  id: string,
  probe: ResourceProbe,
  evidence: Readonly<Record<string, unknown>>,
  remediation: string,
): readonly RawObservation[] {
  if (probe.state === 'present') {
    return [];
  }

  const unknown = probe.state === 'unknown';

  return [
    {
      id,
      // We did not look, so we do not deduct: `low` is listed and never scored.
      confidence: unknown ? 'low' : 'high',
      count: 1,
      affected: [probe.path],
      evidence: {
        status: probe.status,
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(unknown ? { note: 'La comprobacion no pudo completarse; no se resta por esto.' } : {}),
        ...evidence,
      },
      remediation,
    },
  ];
}

function llmsTxt(signals: AgentSignals): readonly RawObservation[] {
  return missingResource(
    'AGENT-LLMSTXT-MISSING',
    signals.llmsTxt,
    { note_impacto: `${UNPROVEN} Google clasifica llms.txt como mito.` },
    'Opcional: publicar /llms.txt. Es higiene, no un factor de posicionamiento demostrado.',
  );
}

function wellKnown(signals: AgentSignals): readonly RawObservation[] {
  const present = signals.wellKnown.filter((probe) => probe.state === 'present');

  if (present.length > 0) {
    return [];
  }

  const unknown = signals.wellKnown.every((probe) => probe.state === 'unknown');

  return [
    {
      id: 'AGENT-WELLKNOWN-MISSING',
      confidence: unknown ? 'low' : 'high',
      count: 1,
      affected: ['/.well-known/'],
      evidence: {
        checked: signals.wellKnown.map((probe) => probe.path),
        results: Object.fromEntries(
          signals.wellKnown.map((probe) => [probe.path, probe.detail ?? probe.state]),
        ),
        note_impacto: UNPROVEN,
        ...(unknown
          ? { note: 'Ninguna comprobacion pudo completarse; no se resta por esto.' }
          : {}),
      },
      remediation:
        'Opcional: publicar al menos /.well-known/security.txt (RFC 9116) para dar un contacto legible por maquina.',
    },
  ];
}

/**
 * Semantics, split between two axes on purpose.
 *
 * Missing landmarks are emitted as the A11Y-owned ID, so A11Y deducts for them
 * once and AGENT shows them as a mention. `AGENT-SEMANTICS-POOR` is emitted only
 * when there are controls an agent cannot name — the defect that is genuinely
 * this axis's own, and the one the catalogue note carves out.
 */
function semantics(signals: AgentSignals): readonly RawObservation[] {
  const { analysis, path } = signals.page;
  const landmarksMissing = analysis.landmarks.length === 0;
  const observations: RawObservation[] = [];

  if (landmarksMissing) {
    observations.push({
      id: 'A11Y-LANDMARKS-MISSING',
      confidence: 'medium',
      count: 1,
      affected: [path],
      evidence: {
        landmarks: [],
        expected: ['main', 'nav', 'footer'],
        seen_by: 'probe:agent',
        note: 'Eje dueno A11Y. AGENT lo menciona sin volver a restar por lo mismo.',
      },
      remediation:
        'Envolver el contenido en <main>, <nav> y <footer>, o declarar los roles ARIA equivalentes.',
    });
  }

  if (analysis.interactiveUnnamed === 0) {
    return observations;
  }

  observations.push({
    id: 'AGENT-SEMANTICS-POOR',
    confidence: 'medium',
    count: analysis.interactiveUnnamed,
    affected: [path],
    evidence: {
      controls_total: analysis.interactiveTotal,
      controls_without_name: analysis.interactiveUnnamed,
      landmarks: analysis.landmarks,
      landmarks_missing: landmarksMissing,
      note: landmarksMissing
        ? 'Se resta por los controles sin nombre. La ausencia de landmarks ya la puntuo A11Y-LANDMARKS-MISSING y aqui no se cuenta de nuevo.'
        : 'Se resta solo por los controles sin nombre accesible.',
      note_impacto: UNPROVEN,
    },
    remediation:
      'Dar nombre accesible a cada enlace y boton: texto visible, aria-label, o un <img> con alt descriptivo.',
  });

  return observations;
}

/** Every rule, in catalogue ID order within the axis. */
export function toObservations(signals: AgentSignals): readonly RawObservation[] {
  return [
    ...noJsContent(signals),
    ...aiBotsBlocked(signals),
    ...structuredData(signals),
    ...llmsTxt(signals),
    ...wellKnown(signals),
    ...semantics(signals),
  ];
}
