import { describe, expect, test } from 'bun:test';
import { readBodyCapped } from './body.ts';

/** A body delivered in fixed-size chunks, the way a socket hands it over. */
function chunked(text: string, chunkBytes: number, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });

  return new Response(stream, { headers });
}

describe('readBodyCapped', () => {
  test('returns a short body whole and reports it as not truncated', async () => {
    const result = await readBodyCapped(chunked('hello world', 4), 1024);

    expect(result.body).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(11);
  });

  test('stops reading at the byte budget instead of buffering the whole body', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        // An endless body. Without a real cap this test never finishes.
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
    });

    const result = await readBodyCapped(new Response(stream), 4096);

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(4096);
    expect(result.body).toHaveLength(4096);
    // Four chunks fill the budget; one more read confirms there was more.
    // Anything close to that is fine; thousands would mean the cap is not one.
    expect(pulls).toBeLessThan(16);
  });

  test('counts bytes, not UTF-16 code units', async () => {
    // Each of these characters is 3 bytes in UTF-8 and 1 code unit in UTF-16.
    const text = '€€€€€';
    const result = await readBodyCapped(chunked(text, 100), 9);

    expect(result.body).toBe('€€€');
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(9);
  });

  test('does not corrupt a multi-byte character split across two chunks', async () => {
    const result = await readBodyCapped(chunked('añb', 2), 1024);

    expect(result.body).toBe('añb');
    expect(result.truncated).toBe(false);
  });

  test('a character cut in half by the budget is dropped, not replaced', async () => {
    const result = await readBodyCapped(chunked('€€', 100), 4);

    expect(result.body).toBe('€');
    expect(result.truncated).toBe(true);
  });

  test('a body exactly at the budget is not truncated', async () => {
    const result = await readBodyCapped(chunked('abcd', 2), 4);

    expect(result.body).toBe('abcd');
    expect(result.truncated).toBe(false);
  });

  test('exposes a usable content-length and ignores a nonsensical one', async () => {
    const good = await readBodyCapped(chunked('abc', 3, { 'content-length': '3' }), 10);
    const bad = await readBodyCapped(chunked('abc', 3, { 'content-length': 'many' }), 10);

    expect(good.contentLength).toBe(3);
    expect(bad.contentLength).toBeUndefined();
  });

  test('a response without a body reads as empty', async () => {
    const result = await readBodyCapped(new Response(null, { status: 204 }), 10);

    expect(result.body).toBe('');
    expect(result.truncated).toBe(false);
  });
});
