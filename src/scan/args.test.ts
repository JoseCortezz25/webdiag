import { describe, expect, test } from 'bun:test';
import { AXES } from '../catalog/index.ts';
import { DEFAULT_OUT_DIR, parseScanArgs } from './args.ts';

function request(argv: readonly string[]) {
  const parsed = parseScanArgs(argv);

  if (!parsed.ok) {
    throw new Error(`expected a valid invocation, got: ${parsed.error}`);
  }

  return parsed.request;
}

function error(argv: readonly string[]): string {
  const parsed = parseScanArgs(argv);

  if (parsed.ok) {
    throw new Error('expected the invocation to be rejected');
  }

  return parsed.error;
}

describe('parseScanArgs', () => {
  test('defaults to a quick single-page run over every axis', () => {
    expect(request(['https://example.com'])).toEqual({
      url: 'https://example.com',
      mode: 'quick',
      axes: AXES,
      pages: 1,
      out: DEFAULT_OUT_DIR,
      repo: undefined,
    });
  });

  test('reads every documented flag', () => {
    const parsed = request([
      'https://example.com',
      '--mode',
      'deep',
      '--out',
      '/tmp/out',
      '--repo',
      '/srv/site',
      '--pages',
      '7',
      '--axes',
      'SEO,PERF',
    ]);

    expect(parsed).toEqual({
      url: 'https://example.com',
      mode: 'deep',
      axes: ['PERF', 'SEO'],
      pages: 7,
      out: '/tmp/out',
      repo: '/srv/site',
    });
  });

  test('normalises --axes to catalog order so the artifacts cannot reorder', () => {
    expect(request(['https://example.com', '--axes', 'sec,perf']).axes).toEqual(['PERF', 'SEC']);
    expect(request(['https://example.com', '--axes', 'perf,sec']).axes).toEqual(['PERF', 'SEC']);
  });

  test('deep defaults to a 5 page sample', () => {
    expect(request(['https://example.com', '--mode', 'deep']).pages).toBe(5);
  });

  test.each([
    [[], 'scan requires a URL'],
    [['example.com'], 'is not an http(s) URL'],
    [['https://a', 'https://b'], 'takes a single URL'],
    [['https://a', '--mode', 'whitebox'], '--mode must be one of'],
    [['https://a', '--axes', 'NOPE'], '--axes must be a comma-separated subset'],
    [['https://a', '--pages', '0'], '--pages must be a positive integer'],
    [['https://a', '--pages', 'many'], '--pages must be a positive integer'],
    [['https://a', '--out'], '--out requires a value'],
    [['https://a', '--nope', 'x'], "unknown option '--nope'"],
  ])('rejects %p', (argv, expected) => {
    expect(error(argv)).toContain(expected);
  });
});
