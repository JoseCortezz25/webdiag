import { describe, expect, test } from 'bun:test';
import { closingPositions, elementSpans, nextAtOrAfter, stripElements } from './html-scan.ts';

describe('closingPositions', () => {
  test('finds each closing tag once, case-insensitively, and not a longer name', () => {
    const html = '<a></a><abbr></abbr></A ><a></a>';
    expect(closingPositions(html.toLowerCase(), 'a')).toEqual([3, 20, 28]);
  });
});

describe('nextAtOrAfter', () => {
  test('returns the first position at or after the index', () => {
    expect(nextAtOrAfter([3, 20, 28], 0)).toBe(3);
    expect(nextAtOrAfter([3, 20, 28], 3)).toBe(3);
    expect(nextAtOrAfter([3, 20, 28], 4)).toBe(20);
    expect(nextAtOrAfter([3, 20, 28], 30)).toBeUndefined();
    expect(nextAtOrAfter([], 0)).toBeUndefined();
  });
});

describe('stripElements', () => {
  test('removes the named elements and their content, leaving the rest', () => {
    expect(
      stripElements('<p>a</p><script>x = 1;</script><b>b</b><STYLE>.c{}</STYLE >c', [
        'script',
        'style',
      ]),
    ).toBe('<p>a</p> <b>b</b> c');
  });

  test('an unclosed element swallows the rest of the document, like a browser', () => {
    expect(stripElements('a<script>never closed<p>b</p>', ['script'])).toBe('a ');
  });

  test('does not stop at a closing tag of a longer name', () => {
    expect(stripElements('<a>x</abbr>y</a>z', ['a'])).toBe(' z');
  });

  test('a hundred thousand unclosed tags finish in linear time', () => {
    const html = `${'<script>'.repeat(100_000)}tail`;
    const started = performance.now();

    expect(stripElements(html, ['script'])).toBe(' ');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('elementSpans', () => {
  test('reports each closed element with its attributes and content', () => {
    const spans = elementSpans(
      '<a href="/x">Go</a><button type="submit">Send</button>',
      ['a', 'button'],
      100,
    );

    expect(spans).toEqual([
      { tag: 'a', attributes: ' href="/x"', inner: 'Go' },
      { tag: 'button', attributes: ' type="submit"', inner: 'Send' },
    ]);
  });

  test('an element left open ends where the next of its kind begins', () => {
    const spans = elementSpans('<a href="/1">one<a href="/2">two</a>', ['a'], 100);

    expect(spans.map((span) => span.inner)).toEqual(['one', 'two']);
  });

  test('an element with no closing tag anywhere after it is not reported', () => {
    expect(elementSpans('<a href="/1">one', ['a'], 100)).toEqual([]);
  });

  test('respects the examination limit', () => {
    const html = '<a href="/x">t</a>'.repeat(50);

    expect(elementSpans(html, ['a'], 10)).toHaveLength(10);
  });
});
