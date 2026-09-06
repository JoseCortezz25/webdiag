/**
 * Reading a response body under a byte budget.
 *
 * `await response.text()` materialises the whole body before anything can be
 * measured, so a cap applied afterwards is not a cap: a 5 GB response or a
 * gzip bomb has already been decoded into memory by the time `.slice()` runs.
 * This reader consumes the stream chunk by chunk, counts the *bytes* it has
 * seen, and cancels the stream the moment the budget is spent. The site being
 * diagnosed never gets to decide how much memory the diagnostic uses.
 */

export type CappedBody = {
  /** The decoded text, cut at the budget. */
  readonly body: string;
  /** True when the body was longer than the budget and reading stopped early. */
  readonly truncated: boolean;
  /** Bytes actually consumed from the wire. Equals the body's byte length when not truncated. */
  readonly bytesRead: number;
  /** The `content-length` header as a number, when the server sent a usable one. */
  readonly contentLength: number | undefined;
};

function contentLengthOf(response: Response): number | undefined {
  const raw = response.headers.get('content-length');

  if (raw === null) {
    return undefined;
  }

  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Reads at most `maxBytes` of the body and stops pulling from the network after
 * that. The decoder runs in streaming mode so a multi-byte character split
 * across two chunks is not turned into replacement characters.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<CappedBody> {
  const contentLength = contentLengthOf(response);
  const stream = response.body;

  if (stream === null) {
    return { body: '', truncated: false, bytesRead: 0, contentLength };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const parts: string[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const remaining = maxBytes - bytesRead;

      if (value.byteLength >= remaining) {
        // Still in streaming mode: a character cut in half by the budget is
        // dropped rather than emitted as a replacement character.
        parts.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        bytesRead += remaining;
        truncated = value.byteLength > remaining || !(await reader.read()).done;
        break;
      }

      parts.push(decoder.decode(value, { stream: true }));
      bytesRead += value.byteLength;
    }

    if (!truncated) {
      parts.push(decoder.decode());
    }
  } finally {
    // Cancelling tells the runtime to stop pulling bytes off the socket. It is
    // a no-op on a stream that already finished.
    await reader.cancel().catch(() => undefined);
  }

  return { body: parts.join(''), truncated, bytesRead, contentLength };
}
