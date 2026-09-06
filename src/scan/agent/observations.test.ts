import { describe, expect, test } from 'bun:test';
import { ownerAxisOf, requireEntry } from '../../catalog/index.ts';
import { analyzeHtml } from './html.ts';
import { type AgentSignals, MIN_TEXT_CHARS, toObservations } from './observations.ts';
import type { ResourceProbe } from './resources.ts';
import { analyzeRobots, unavailableRobots } from './robots.ts';

const RICH_BODY = `<body>
<header><nav><a href="/">Inicio</a></nav></header>
<main><h1>Taller</h1><p>${'Reparamos bicicletas de todo tipo desde hace veinte anos. '.repeat(6)}</p>
<a href="/precios">Ver precios</a></main>
<footer><a href="/contacto">Contacto</a></footer>
<script type="application/ld+json">{"@type":"Organization","name":"Taller"}</script>
</body>`;

function present(path: string): ResourceProbe {
  return { path, state: 'present', status: 200, contentType: 'text/plain', detail: undefined };
}

function absent(path: string): ResourceProbe {
  return { path, state: 'absent', status: 404, contentType: undefined, detail: 'respondio 404' };
}

function unknown(path: string): ResourceProbe {
  return { path, state: 'unknown', status: null, contentType: undefined, detail: 'timeout' };
}

/** A site with nothing wrong on this axis: the baseline every test deviates from. */
function healthy(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    page: { path: '/', status: 200, analysis: analyzeHtml(RICH_BODY) },
    robots: analyzeRobots('User-agent: *\nDisallow: /admin'),
    llmsTxt: present('/llms.txt'),
    wellKnown: [present('/.well-known/security.txt')],
    ...overrides,
  };
}

function idsOf(signals: AgentSignals): readonly string[] {
  return toObservations(signals).map((observation) => observation.id);
}

function find(signals: AgentSignals, id: string) {
  return toObservations(signals).find((observation) => observation.id === id);
}

describe('toObservations — sitio sano', () => {
  test('emits nothing when every signal is satisfied', () => {
    expect(idsOf(healthy())).toEqual([]);
  });
});

describe('AGENT-NO-JS-CONTENT-EMPTY', () => {
  test('fires on a client-rendered shell with high confidence', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml('<body><div id="root"></div><script src="/a.js"></script></body>'),
      },
    });
    const observation = find(signals, 'AGENT-NO-JS-CONTENT-EMPTY');

    expect(observation?.confidence).toBe('high');
    expect(observation?.evidence.threshold_chars).toBe(MIN_TEXT_CHARS);
    expect(observation?.evidence.text_chars).toBe(0);
  });

  test('an empty page with no scripts is reported with lower confidence', () => {
    const signals = healthy({
      page: { path: '/', status: 200, analysis: analyzeHtml('<body><div></div></body>') },
    });

    expect(find(signals, 'AGENT-NO-JS-CONTENT-EMPTY')?.confidence).toBe('medium');
  });

  test('server-rendered copy above the threshold does not fire', () => {
    expect(idsOf(healthy())).not.toContain('AGENT-NO-JS-CONTENT-EMPTY');
  });
});

describe('AGENT-AI-BOTS-BLOCKED', () => {
  const blocked = healthy({ robots: analyzeRobots('User-agent: GPTBot\nDisallow: /') });

  test('is reported as a fact, never escalated: no severity override', () => {
    const observation = find(blocked, 'AGENT-AI-BOTS-BLOCKED');

    expect(observation).toBeDefined();
    expect(observation?.severity).toBeUndefined();
    expect(requireEntry('AGENT-AI-BOTS-BLOCKED').baseSeverity).toBe('info');
  });

  test('names the blocked crawlers and asks for nothing', () => {
    const observation = find(blocked, 'AGENT-AI-BOTS-BLOCKED');

    expect(observation?.evidence.blocked).toEqual(['GPTBot']);
    expect(observation?.remediation).toContain('Ninguna accion requerida');
  });

  test('says nothing when robots.txt could not be read', () => {
    expect(idsOf(healthy({ robots: unavailableRobots() }))).not.toContain('AGENT-AI-BOTS-BLOCKED');
  });
});

describe('AGENT-STRUCTURED-DATA-MISSING', () => {
  test('fires when there is no JSON-LD at all', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml(RICH_BODY.replace(/<script[\s\S]*?<\/script>/, '')),
      },
    });

    expect(find(signals, 'AGENT-STRUCTURED-DATA-MISSING')?.confidence).toBe('high');
  });

  test('a JSON-LD block that does not parse declares nothing', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml(
          RICH_BODY.replace(
            /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
            '<script type="application/ld+json">{roto</script>',
          ),
        ),
      },
    });
    const observation = find(signals, 'AGENT-STRUCTURED-DATA-MISSING');

    expect(observation?.evidence.jsonld_blocks).toBe(1);
    expect(observation?.evidence.jsonld_valid).toBe(0);
  });

  test('microdata lowers confidence so the finding never deducts', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml(
          '<body><main><div itemscope itemtype="https://schema.org/Product"></div></main></body>',
        ),
      },
    });

    expect(find(signals, 'AGENT-STRUCTURED-DATA-MISSING')?.confidence).toBe('low');
  });
});

describe('AGENT-LLMSTXT-MISSING y AGENT-WELLKNOWN-MISSING', () => {
  test('both fire when the files are absent, and both state the unproven impact', () => {
    const signals = healthy({
      llmsTxt: absent('/llms.txt'),
      wellKnown: [absent('/.well-known/security.txt'), absent('/.well-known/ai.txt')],
    });

    for (const id of ['AGENT-LLMSTXT-MISSING', 'AGENT-WELLKNOWN-MISSING']) {
      expect(String(find(signals, id)?.evidence.note_impacto)).toContain('no esta probado');
    }
  });

  test('llms.txt is offered as optional hygiene, not as a ranking factor', () => {
    const observation = find(healthy({ llmsTxt: absent('/llms.txt') }), 'AGENT-LLMSTXT-MISSING');

    expect(observation?.remediation).toContain('Opcional');
    expect(String(observation?.evidence.note_impacto)).toContain('mito');
  });

  test('a check that could not run is low confidence, so it never deducts', () => {
    const signals = healthy({
      llmsTxt: unknown('/llms.txt'),
      wellKnown: [unknown('/.well-known/security.txt')],
    });

    expect(find(signals, 'AGENT-LLMSTXT-MISSING')?.confidence).toBe('low');
    expect(find(signals, 'AGENT-WELLKNOWN-MISSING')?.confidence).toBe('low');
  });

  test('one present endpoint is enough for /.well-known/', () => {
    const signals = healthy({
      wellKnown: [absent('/.well-known/ai.txt'), present('/.well-known/security.txt')],
    });

    expect(idsOf(signals)).not.toContain('AGENT-WELLKNOWN-MISSING');
  });
});

describe('semantica: el punto de landmarks se cuenta una sola vez', () => {
  const noLandmarks =
    '<body><div><p>' +
    'Texto suficiente para no disparar el check de contenido. '.repeat(6) +
    '</p><a href="/x">Ir</a></div></body>';

  test('missing landmarks are emitted under the A11Y-owned ID', () => {
    const signals = healthy({
      page: { path: '/', status: 200, analysis: analyzeHtml(noLandmarks) },
    });

    expect(idsOf(signals)).toContain('A11Y-LANDMARKS-MISSING');
    expect(ownerAxisOf('A11Y-LANDMARKS-MISSING')).toBe('A11Y');
    expect(requireEntry('A11Y-LANDMARKS-MISSING').mentionedIn).toContain('AGENT');
  });

  test('when landmarks are the only defect, AGENT-SEMANTICS-POOR is not emitted', () => {
    const signals = healthy({
      page: { path: '/', status: 200, analysis: analyzeHtml(noLandmarks) },
    });

    expect(idsOf(signals)).not.toContain('AGENT-SEMANTICS-POOR');
  });

  test('AGENT-SEMANTICS-POOR fires for controls an agent cannot name', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml(
          `<body><main><p>${'Contenido servido de sobra para pasar el umbral. '.repeat(6)}</p><button><svg></svg></button></main></body>`,
        ),
      },
    });
    const observation = find(signals, 'AGENT-SEMANTICS-POOR');

    expect(observation?.count).toBe(1);
    expect(observation?.evidence.controls_without_name).toBe(1);
    expect(observation?.evidence.landmarks_missing).toBe(false);
  });

  test('with both defects, the note says the landmark point is not counted twice', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml(
          `<body><div><p>${'Contenido servido de sobra para pasar el umbral. '.repeat(6)}</p><button><svg></svg></button></div></body>`,
        ),
      },
    });
    const ids = idsOf(signals);

    expect(ids).toContain('A11Y-LANDMARKS-MISSING');
    expect(ids).toContain('AGENT-SEMANTICS-POOR');
    expect(String(find(signals, 'AGENT-SEMANTICS-POOR')?.evidence.note)).toContain(
      'no se cuenta de nuevo',
    );
  });
});

describe('toObservations — contrato con el catalogo', () => {
  test('every emitted ID is published in the catalogue', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml('<body><div><button></button></div></body>'),
      },
      robots: analyzeRobots('User-agent: *\nDisallow: /'),
      llmsTxt: absent('/llms.txt'),
      wellKnown: [absent('/.well-known/security.txt')],
    });

    for (const observation of toObservations(signals)) {
      expect(() => requireEntry(observation.id)).not.toThrow();
      expect(requireEntry(observation.id).deprecated).toBe(false);
    }
  });

  test('the whole rule set fires on a site that fails every check', () => {
    const signals = healthy({
      page: {
        path: '/',
        status: 200,
        analysis: analyzeHtml('<body><div><button></button></div></body>'),
      },
      robots: analyzeRobots('User-agent: *\nDisallow: /'),
      llmsTxt: absent('/llms.txt'),
      wellKnown: [absent('/.well-known/security.txt')],
    });

    expect(idsOf(signals)).toEqual([
      'AGENT-NO-JS-CONTENT-EMPTY',
      'AGENT-AI-BOTS-BLOCKED',
      'AGENT-STRUCTURED-DATA-MISSING',
      'AGENT-LLMSTXT-MISSING',
      'AGENT-WELLKNOWN-MISSING',
      'A11Y-LANDMARKS-MISSING',
      'AGENT-SEMANTICS-POOR',
    ]);
  });
});
