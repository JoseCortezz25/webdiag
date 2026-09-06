import { describe, expect, test } from 'bun:test';
import { detectLibraries, LIBRARY_SIGNATURES } from './signatures.ts';

describe('detectLibraries', () => {
  test('recognises a library from a string a minifier has to preserve', () => {
    expect(detectLibraries('...t.fn=t.prototype={jquery:"3.4.1"};jQuery.fn.jquery...')).toEqual([
      'jquery',
    ]);
    expect(
      detectLibraries('throw Error("Minified React error; visit react.dev/errors/418")'),
    ).toEqual(['react']);
  });

  test('says nothing about a version, because it cannot know one', () => {
    const detected = detectLibraries('window.__VUE_DEVTOOLS_GLOBAL_HOOK__=x');

    expect(detected).toEqual(['vue']);
    expect(detected.join()).not.toMatch(/\d+\.\d+/);
  });

  test('finds every library in a bundle that concatenated several', () => {
    const bundle = 'jQuery.fn.jquery; window.__VUE_DEVTOOLS_GLOBAL_HOOK__; htmx.org/docs';

    expect(detectLibraries(bundle)).toEqual(['jquery', 'vue', 'htmx']);
  });

  test('returns signature-table order, so two runs agree byte for byte', () => {
    const forwards = detectLibraries('htmx.org --- jQuery.fn.jquery');
    const backwards = detectLibraries('jQuery.fn.jquery --- htmx.org');

    expect(forwards).toEqual(backwards);
  });

  test('stays quiet on application code that names nothing', () => {
    expect(detectLibraries('export function total(items){return items.length}')).toEqual([]);
  });

  test('every signature has a distinct library name', () => {
    const names = LIBRARY_SIGNATURES.map((signature) => signature.library);

    expect(new Set(names).size).toBe(names.length);
  });

  test('no signature is stateful: a global regex would skip every other call', () => {
    for (const signature of LIBRARY_SIGNATURES) {
      expect(signature.pattern.global).toBe(false);
    }
  });
});
