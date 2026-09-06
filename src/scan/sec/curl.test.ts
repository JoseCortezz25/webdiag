import { describe, expect, test } from 'bun:test';
import { USER_AGENT_PRODUCT } from './agent.ts';
import {
  type CommandResult,
  type CommandRunner,
  fetchHeaders,
  fetchText,
  headerValue,
  headerValues,
  parseHeaderDump,
} from './curl.ts';

function runner(result: Partial<CommandResult>): CommandRunner & { commands: string[][] } {
  const commands: string[][] = [];

  const fn = (command: readonly string[]): Promise<CommandResult> => {
    commands.push([...command]);
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', ...result });
  };

  return Object.assign(fn, { commands });
}

const REDIRECT_DUMP = [
  'HTTP/1.1 301 Moved Permanently',
  'Location: https://example.com/',
  'Set-Cookie: first=1',
  '',
  'HTTP/2 200 ',
  'content-type: text/html',
  'set-cookie: a=1',
  'set-cookie: b=2',
  '',
  'x-webdiag-final-url: https://example.com/',
  '',
].join('\r\n');

describe('parseHeaderDump', () => {
  test('splits one block per response in the redirect chain', () => {
    const blocks = parseHeaderDump(REDIRECT_DUMP);

    expect(blocks.map((entry) => entry.status)).toEqual([301, 200]);
  });

  test('keeps duplicate headers, because two Set-Cookie lines are two cookies', () => {
    const blocks = parseHeaderDump(REDIRECT_DUMP);

    expect(headerValues(blocks[1] ?? { status: 0, headers: [] }, 'set-cookie')).toEqual([
      'a=1',
      'b=2',
    ]);
  });

  test('header lookup ignores case', () => {
    const blocks = parseHeaderDump('HTTP/2 200\r\nContent-Type: text/html\r\n\r\n');

    expect(headerValue(blocks[0] ?? { status: 0, headers: [] }, 'CONTENT-TYPE')).toBe('text/html');
  });

  test('returns nothing for a dump with no status line', () => {
    expect(parseHeaderDump('garbage\r\n\r\n')).toEqual([]);
  });
});

describe('fetchHeaders', () => {
  test('identifies the probe on every request', async () => {
    const fake = runner({ stdout: REDIRECT_DUMP });

    await fetchHeaders('https://example.com/', { runner: fake });

    const command = fake.commands[0] ?? [];
    const agent = command[command.indexOf('--user-agent') + 1] ?? '';

    expect(agent.startsWith(`${USER_AGENT_PRODUCT} (+`)).toBe(true);
  });

  test('discards the body: no header check needs it', async () => {
    const fake = runner({ stdout: REDIRECT_DUMP });

    await fetchHeaders('https://example.com/', { runner: fake });

    expect(fake.commands[0]).toContain('/dev/null');
  });

  test('reports where the redirect chain ended', async () => {
    const transcript = await fetchHeaders('http://example.com', {
      runner: runner({ stdout: REDIRECT_DUMP }),
    });

    expect(transcript.finalUrl).toBe('https://example.com/');
  });

  test('a non-zero exit becomes an error carrying what curl said', async () => {
    const failing = runner({ exitCode: 6, stderr: 'curl: (6) Could not resolve host' });

    expect(fetchHeaders('https://nope.invalid/', { runner: failing })).rejects.toThrow(
      /Could not resolve host/,
    );
  });
});

describe('fetchText', () => {
  test('separates the body from the status marker', async () => {
    const response = await fetchText('https://example.com/robots.txt', {
      runner: runner({ stdout: 'User-agent: *\nDisallow: /x\nx-webdiag-status: 200\n' }),
    });

    expect(response.status).toBe(200);
    expect(response.body.trim()).toBe('User-agent: *\nDisallow: /x');
  });

  test('a body that mentions the marker does not confuse the parser', async () => {
    const response = await fetchText('https://example.com/robots.txt', {
      runner: runner({ stdout: '# x-webdiag-status: 999\nDisallow:\nx-webdiag-status: 404\n' }),
    });

    expect(response.status).toBe(404);
  });
});
