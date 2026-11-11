import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from './sse.ts';

test('SSE parsing preserves split UTF-8 and multiline CRLF frames', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nid: 9\r\nevent: output\r\ndata: {"text":"中"}\r\ndata: tail\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const frames = [];
  for await (const frame of parseSse(stream)) frames.push(frame);
  assert.deepEqual(frames, [{ id: '9', event: 'output', data: '{"text":"中"}\ntail' }, { id: '9', data: '[DONE]' }]);
});

test('partial SSE event is not fabricated after transport loss', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"uncommitted":true}')); controller.close(); } });
  const frames = [];
  for await (const frame of parseSse(stream)) frames.push(frame);
  assert.deepEqual(frames, []);
});

test('aborting observation cancels the actual body reader', async () => {
  let cancelled = false;
  const control = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const iterator = parseSse(stream, control.signal);
  const next = iterator.next();
  control.abort();
  await next;
  assert.equal(cancelled, true);
});
