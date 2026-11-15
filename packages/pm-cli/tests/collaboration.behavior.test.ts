import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { collaborationFamily, watchCollaborationEvents } from '../collaboration.ts';
import { CliRequestError, type CliRuntime, type PmRequestOptions, type PmScope } from '../runtime.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
function transport(response: (endpoint: string, options?: PmRequestOptions) => Promise<Response>) {
  const calls: { scope: PmScope; endpoint: string; options?: PmRequestOptions }[] = [], printed: unknown[] = [];
  const runtime: CliRuntime = {
    async authentication() { return { origin: 'http://127.0.0.1:4194', headers: {} }; },
    async connection() { return { workspaceId, origin: 'http://127.0.0.1:4194', headers: {} }; },
    async response(scope, endpoint, options) { calls.push({ scope, endpoint, ...(options ? { options } : {}) }); return response(endpoint, options); },
    async json<T>(scope: PmScope, endpoint: string, options?: PmRequestOptions): Promise<T> { return await (await runtime.response(scope, endpoint, options)).json() as T; },
    print(value) { printed.push(value); },
  };
  return { runtime, calls, printed };
}
function change(sequence: string) {
  return `id: ${sequence}\nevent: change\ndata: ${JSON.stringify({ eventId: randomUUID(), eventType: 'TaskCommentEdited', workspaceId, projectId: 'PRJ-1', aggregateId: 'TASK-1', aggregateKind: 'work_item', aggregateVersion: Number(sequence), occurredAt: '2026-11-01T00:00:00.000Z' })}\n\n`;
}

test('collaboration owns only closed prefixes and validates mutations before sending', async () => {
  const io = transport(async () => Response.json({ committed: true }));
  assert.equal(await collaborationFamily.dispatch(['task', 'list'], io.runtime), false);
  assert.equal(io.calls.length, 0);
  await assert.rejects(collaborationFamily.dispatch(['comment', 'edit', 'TASK-1', randomUUID(), '--project', 'PRJ-1', '--version', '0', '--content', 'body', '--request-id', randomUUID()], io.runtime));
  await assert.rejects(collaborationFamily.dispatch(['events', 'watch', '--duration-ms', '0'], io.runtime));
  await assert.rejects(collaborationFamily.dispatch(['changes', 'history', '--id', 'TASK-1', '--source', 'source', '--path', 'a.md'], io.runtime));
  await assert.rejects(collaborationFamily.dispatch(['comment', 'unknown'], io.runtime), /Unsupported comment action/);
  assert.equal(io.calls.length, 0);
});

test('an ambiguous native comment write is submitted once and only the original receipt is read', async () => {
  const requestId = randomUUID(), commentId = randomUUID();
  const io = transport(async (_path, options) => {
    if (options?.method === 'POST') throw new CliRequestError('CLI_CONNECTION_FAILED', 'Response lost');
    return Response.json({ commandId: requestId, status: 'committed', result: { id: commentId, version: 2 } });
  });
  await assert.rejects(collaborationFamily.dispatch(['comment', 'edit', 'TASK-1', commentId, '--project', 'PRJ-1', '--version', '1', '--content', 'Corrected', '--request-id', requestId], io.runtime), /Response lost/);
  assert.equal(io.calls.length, 1);
  assert.deepEqual(io.calls[0]!.options?.body, { commandId: requestId, commandType: 'UpdateTaskComment', projectId: 'PRJ-1', targetId: 'TASK-1', expectedVersions: { [commentId]: 1 }, payload: { commentId, content: 'Corrected' } });
  await collaborationFamily.dispatch(['comment', 'receipt', '--request-id', requestId], io.runtime);
  assert.equal(io.calls.length, 2);
  assert.equal(io.calls[1]!.endpoint, `/commands/${requestId}`);
  assert.equal(io.calls[1]!.options?.method, undefined);
});

test('history/inbox reads do not acknowledge and explicit acknowledgement preserves the observed watermark', async () => {
  const token = randomUUID(), io = transport(async () => Response.json({}));
  await collaborationFamily.dispatch(['changes', 'history', '--id', 'TASK-1', '--head', '42', '--cursor', '39', '--related', 'false'], io.runtime);
  await collaborationFamily.dispatch(['notifications', 'inbox', '--after', '3', '--through', '9'], io.runtime);
  assert.equal(io.calls.some(call => call.endpoint.includes('acknowledge') || call.endpoint === '/commands'), false);
  await collaborationFamily.dispatch(['changes', 'ack', '--id', 'TASK-1', '--through', '42', '--observation-token', token], io.runtime);
  assert.deepEqual(io.calls[2]!.options?.body, { target: { kind: 'core', entityId: 'TASK-1' }, through: '42', observationToken: token });
  assert.equal(io.calls[2]!.endpoint, '/change-history/acknowledge');
  assert.equal(io.calls.length, 3);
});

test('finite SSE reconnects only GET from the last complete checkpoint and cancels every body', async () => {
  let connection = 0, cancelled = 0;
  const io = transport(async () => {
    const round = connection++;
    const text = round === 0 ? `${change('1')}id: 3\nevent: checkpoint\ndata: {"cursor":"3"}\n\nid: 4\nevent: change\ndata: {"partial":` : change('5');
    const bytes = new TextEncoder().encode(text); let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) { const end = Math.min(offset + 11, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end; return; }
        if (round === 0) controller.error(new TypeError('Socket disconnected'));
      },
      cancel() { cancelled++; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  await watchCollaborationEvents(io.runtime, { after: '0', projectId: 'PRJ-1', durationMs: 1000, maxEvents: 2, reconnects: 1 });
  assert.equal(io.calls.length, 2);
  assert.ok(io.calls[1]!.endpoint.includes('after=3'));
  assert.equal(io.calls[1]!.options?.headers?.['Last-Event-ID'], '3');
  assert.ok(io.calls.every(call => call.options?.method === undefined));
  assert.equal(cancelled, 1, 'the errored stream is already closed; the remaining live body must be cancelled');
  assert.deepEqual(io.printed.at(-1), { cursor: '5', events: 2, connections: 2, reason: 'limit', writeReplay: false });
  assert.deepEqual(io.printed.filter((entry): entry is { event: string } => !!entry && typeof entry === 'object' && 'event' in entry).map(entry => entry.event), ['change', 'checkpoint', 'change']);
});

test('SSE expiry and permission errors stop without fallback, reconnect or write replay', async () => {
  const expired = transport(async () => { throw new CliRequestError('HTTP_ERROR', 'cursor_expired', [], 410); });
  await assert.rejects(watchCollaborationEvents(expired.runtime, { after: '0', durationMs: 1000, maxEvents: 10, reconnects: 3 }), error => error instanceof CliRequestError && error.status === 410);
  assert.equal(expired.calls.length, 1);
  const denied = transport(async () => new Response('event: stream_error\ndata: {"code":"permission_denied"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(watchCollaborationEvents(denied.runtime, { after: '0', durationMs: 1000, maxEvents: 10, reconnects: 3 }), /permission_denied/);
  assert.equal(denied.calls.length, 1);
});

test('finite watch abort removes process listeners and aborts/cancels its live stream', async () => {
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  let cancelled = false, signal: AbortSignal | undefined;
  const io = transport(async (_path, options) => {
    signal = options?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  await watchCollaborationEvents(io.runtime, { after: '0', durationMs: 5, maxEvents: 10, reconnects: 0 });
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, false, 'abort closes this transport before cancellation');
  assert.equal(process.listenerCount('SIGINT'), beforeInt); assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  assert.deepEqual(io.printed.at(-1), { cursor: '0', events: 0, connections: 1, reason: 'aborted', writeReplay: false });
});

test('oversized or malformed event frames are rejected rather than buffering without bounds', async () => {
  const io = transport(async () => new Response(`data: ${'x'.repeat(1024 * 1024 + 1)}`, { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(watchCollaborationEvents(io.runtime, { after: '0', durationMs: 1000, maxEvents: 10, reconnects: 2 }), /exceeds 1 MiB/);
  assert.equal(io.calls.length, 1);
});
