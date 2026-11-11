export type SseFrame = { event?: string; id?: string; data: string };

/** Decode actual SSE, including split UTF-8, CRLF and multiline data fields. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', data: string[] = [], dataBytes = 0, event: string | undefined, id: string | undefined;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!signal?.aborted) {
      const result = await reader.read();
      pending += decoder.decode(result.value, { stream: !result.done });
      if (pending.length > 8 * 1024 * 1024) throw new Error('Agent SSE frame exceeds 8 MiB.');
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line === '') {
          if (data.length) yield { data: data.join('\n'), ...(event ? { event } : {}), ...(id ? { id } : {}) };
          data = []; dataBytes = 0; event = undefined;
        } else if (!line.startsWith(':')) {
          const separator = line.indexOf(':');
          const field = separator < 0 ? line : line.slice(0, separator);
          const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
          if (field === 'data') { data.push(value); dataBytes += value.length; }
          else if (field === 'event') event = value;
          else if (field === 'id' && !value.includes('\0')) id = value;
          if (dataBytes > 8 * 1024 * 1024) throw new Error('Agent SSE frame exceeds 8 MiB.');
        }
      }
      if (result.done) break;
    }
    // An incomplete event without its terminating blank line is not committed SSE.
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
