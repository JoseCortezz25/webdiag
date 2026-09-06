import { describe, expect, test } from 'bun:test';
import { scoreAxis } from '../../catalog/index.ts';
import { normalize } from '../normalize.ts';
import { runProbe } from '../probe.ts';
import { RAW_SCHEMA_VERSION, rawDocumentSchema } from '../raw.ts';
import type { Fetcher, HttpResponse } from './http.ts';
import { AGENT_TOOL, agentProbe } from './probe.ts';

const CONTEXT = { url: 'https://example.com/', mode: 'quick' as const, pages: 1 };

const PAGE = `<!doctype html><html><body>
<div id="app"><button><svg></svg></button></div>
<script src="/bundle.js"></script>
</body></html>`;

function ok(url: string, body: string, contentType = 'text/html'): HttpResponse {
  return { url, status: 200, contentType, body, error: undefined };
}

function missing(url: string): HttpResponse {
  return { url, status: 404, contentType: undefined, body: '', error: undefined };
}

/** Records every URL asked for, so the request plan itself is assertable. */
function recordingFetcher(responses: Readonly<Record<string, HttpResponse>>): {
  readonly fetcher: Fetcher;
  readonly seen: string[];
} {
  const seen: string[] = [];

  return {
    seen,
    fetcher: (url: string) => {
      seen.push(url);
      return Promise.resolve(responses[url] ?? missing(url));
    },
  };
}

const SITE: Readonly<Record<string, HttpResponse>> = {
  'https://example.com/': ok('https://example.com/', PAGE),
  'https://example.com/robots.txt': ok(
    'https://example.com/robots.txt',
    'User-agent: GPTBot\nDisallow: /',
    'text/plain',
  ),
};

describe('agentProbe', () => {
  test('produces a raw document that validates against the schema', async () => {
    const { fetcher } = recordingFetcher(SITE);
    const raw = await agentProbe(fetcher).run(CONTEXT);

    expect(() => rawDocumentSchema.parse(raw)).not.toThrow();
    expect(raw.schema).toBe(RAW_SCHEMA_VERSION);
    expect(raw.axis).toBe('AGENT');
    expect(raw.tool).toEqual(AGENT_TOOL);
    expect(raw.target).toEqual({ url: CONTEXT.url, mode: 'quick' });
  });

  test('asks for the page, robots.txt, llms.txt and the well-known endpoints', async () => {
    const { fetcher, seen } = recordingFetcher(SITE);
    await agentProbe(fetcher).run(CONTEXT);

    expect(seen).toContain('https://example.com/');
    expect(seen).toContain('https://example.com/robots.txt');
    expect(seen).toContain('https://example.com/llms.txt');
    expect(seen).toContain('https://example.com/.well-known/security.txt');
  });

  test('resolves site-root paths against the origin, not the scanned path', async () => {
    const { fetcher, seen } = recordingFetcher({
      'https://example.com/es/servicios': ok('https://example.com/es/servicios', PAGE),
    });

    await agentProbe(fetcher).run({ ...CONTEXT, url: 'https://example.com/es/servicios' });

    expect(seen).toContain('https://example.com/llms.txt');
    expect(seen).not.toContain('https://example.com/es/llms.txt');
  });

  test('is deterministic: the same responses produce the same document', async () => {
    const first = await agentProbe(recordingFetcher(SITE).fetcher).run(CONTEXT);
    const second = await agentProbe(recordingFetcher(SITE).fetcher).run(CONTEXT);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('a deep run measures the same single page and does not claim otherwise', async () => {
    const raw = await agentProbe(recordingFetcher(SITE).fetcher).run({
      ...CONTEXT,
      mode: 'deep',
      pages: 20,
    });

    expect(raw.target.mode).toBe('deep');
    expect(raw.observations.every((observation) => observation.affected.length <= 1)).toBe(true);
  });
});

describe('agentProbe — fallos', () => {
  test('an unreachable site fails the axis instead of inventing an empty page', async () => {
    const fetcher: Fetcher = (url) =>
      Promise.resolve({ url, status: null, contentType: undefined, body: '', error: 'ENOTFOUND' });

    const outcome = await runProbe(agentProbe(fetcher), CONTEXT);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toContain('ENOTFOUND');
  });

  test('a 5xx on the page fails the axis', async () => {
    const fetcher: Fetcher = (url) =>
      Promise.resolve({ url, status: 503, contentType: 'text/html', body: '', error: undefined });

    const outcome = await runProbe(agentProbe(fetcher), CONTEXT);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toContain('503');
  });

  test('a failing side resource degrades that check only', async () => {
    const fetcher: Fetcher = (url) =>
      url === CONTEXT.url
        ? Promise.resolve(ok(url, PAGE))
        : Promise.resolve({
            url,
            status: null,
            contentType: undefined,
            body: '',
            error: 'timeout',
          });

    const raw = await agentProbe(fetcher).run(CONTEXT);
    const llms = raw.observations.find((observation) => observation.id === 'AGENT-LLMSTXT-MISSING');

    expect(llms?.confidence).toBe('low');
    expect(raw.observations.some((o) => o.id === 'AGENT-NO-JS-CONTENT-EMPTY')).toBe(true);
  });
});

describe('agentProbe — el eje AGENT no cobra dos veces por lo mismo', () => {
  async function scoreOf(axis: 'AGENT' | 'A11Y') {
    const raw = await agentProbe(recordingFetcher(SITE).fetcher).run(CONTEXT);
    const { findings, rejected } = normalize([raw]);

    expect(rejected).toEqual([]);

    return scoreAxis(axis, findings);
  }

  test('the landmarks finding deducts in A11Y', async () => {
    const a11y = await scoreOf('A11Y');

    expect(a11y.scored.map((finding) => finding.id)).toContain('A11Y-LANDMARKS-MISSING');
    expect(a11y.deductions.some((deduction) => deduction.id === 'A11Y-LANDMARKS-MISSING')).toBe(
      true,
    );
  });

  test('and appears in AGENT as a mention that subtracts nothing', async () => {
    const agent = await scoreOf('AGENT');

    expect(agent.mentions.map((finding) => finding.id)).toEqual(['A11Y-LANDMARKS-MISSING']);
    expect(agent.deductions.map((deduction) => deduction.id)).not.toContain(
      'A11Y-LANDMARKS-MISSING',
    );
  });

  test('blocked AI crawlers are info and cost the axis zero points', async () => {
    const agent = await scoreOf('AGENT');
    const blocked = agent.scored.find((finding) => finding.id === 'AGENT-AI-BOTS-BLOCKED');

    expect(blocked?.severity).toBe('info');
    expect(agent.deductions.some((deduction) => deduction.id === 'AGENT-AI-BOTS-BLOCKED')).toBe(
      false,
    );
  });
});
