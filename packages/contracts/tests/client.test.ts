/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadableStream } from 'node:stream/web';
import { createServer } from 'node:http';
import { buildApp } from '../../../apps/api/src/app.ts';
import { ApiError, CommandOutcomeUnknown, ProjectManagementClient, type Command } from '../src/client.ts';
import type { AgentChatStreamEvent } from '../src/agent-chat.ts';

const commandId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const command: Command<'ActivateProject'> = { commandId, commandType: 'ActivateProject', payload: {} };
const committed = { commandId, status: 'committed', httpStatus: 200, result: null };
const rejected = { commandId, status: 'rejected', httpStatus: 409, error: { code: 'version_conflict', message: 'Changed' } };
const client = (fetch: typeof globalThis.fetch) => new ProjectManagementClient({ baseUrl: 'https://example.test', auth: { type: 'none' }, fetch });

test('a lowercase receipt matches an uppercase command UUID without sending again', async () => {
  const lowercaseId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const uppercaseCommand = { ...command, commandId: lowercaseId.toUpperCase() };
  const receipt = { ...committed, commandId: lowercaseId };
  let calls = 0;
  const api = client(async (_url, init) => {
    calls++;
    assert.equal(init?.method, 'POST');
    assert.equal(JSON.parse(String(init?.body)).commandId, uppercaseCommand.commandId);
    return Response.json(receipt);
  });
  assert.deepEqual(await api.executeCommand(workspaceId, uppercaseCommand), receipt);
  assert.equal(calls, 1);
});

test('a command is sent once; unknown outcomes preserve the original query identifiers', async () => {
  const requests: string[] = [];
  const api = client(async (url, init) => {
    requests.push(`${init?.method} ${url}`);
    if (init?.method === 'POST') throw new TypeError('Connection lost after send');
    return Response.json(committed);
  });
  await assert.rejects(api.executeCommand(workspaceId, command), error => error instanceof CommandOutcomeUnknown && error.commandId === commandId && error.workspaceId === workspaceId);
  assert.equal(requests.length, 1);
  assert.deepEqual(await api.getCommandReceipt(workspaceId, commandId), committed);
  assert.ok(requests[1]!.endsWith(`/commands/${commandId}`));
  assert.equal(requests.filter(request => request.startsWith('POST')).length, 1);
});

test('rejection receipts remain values; request errors and unknown server/invalid responses remain distinct', async () => {
  assert.deepEqual(await client(async () => Response.json(rejected, { status: 409 })).executeCommand(workspaceId, command), rejected);
  await assert.rejects(client(async () => Response.json({ error: { code: 'unauthenticated' }, requestId: 'r1' }, { status: 401 })).executeCommand(workspaceId, command), error => error instanceof ApiError && error.code === 'unauthenticated' && error.requestId === 'r1');
  for (const response of [Response.json({}, { status: 200 }), Response.json({ error: { code: 'temporarily_unavailable' } }, { status: 503 }), new Response('invalid json', { status: 200 })]) {
    await assert.rejects(client(async () => response).executeCommand(workspaceId, command), CommandOutcomeUnknown);
  }
});

test('authentication is explicit and token providers refresh per request', async () => {
  const seen: { credentials: string | undefined; bearer: string | null; cookie: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ credentials: init?.credentials, bearer: headers.get('authorization'), cookie: headers.get('cookie') });
    return Response.json({ actor: { id: commandId, email: 'test@example.test', name: 'Test' } });
  };
  await client(fetch).getMe();
  let token = 'first';
  const bearer = new ProjectManagementClient({ baseUrl: 'https://example.test', auth: { type: 'bearer', token: () => token }, fetch });
  await bearer.getMe(); token = 'second'; await bearer.getMe();
  const cookie = new ProjectManagementClient({ baseUrl: 'https://example.test', auth: { type: 'cookie', credentials: 'same-origin', cookie: () => 'pm_session=explicit' }, fetch });
  await cookie.getMe();
  assert.deepEqual(seen, [
    { credentials: 'omit', bearer: null, cookie: null },
    { credentials: 'omit', bearer: 'Bearer first', cookie: null },
    { credentials: 'omit', bearer: 'Bearer second', cookie: null },
    { credentials: 'same-origin', bearer: null, cookie: 'pm_session=explicit' },
  ]);
  assert.throws(() => new ProjectManagementClient({ baseUrl: 'https://user:password@example.test', auth: { type: 'none' } }), /without embedded credentials/);
});

test('SSE handles fragmented UTF-8 and CRLF, checkpoint IDs and stream_error without reconnecting', async () => {
  const notification = { eventId: commandId, eventType: '项目Changed', workspaceId, projectId: null, aggregateId: commandId, aggregateKind: 'project', aggregateVersion: 1, occurredAt: '2026-10-16T00:00:00.000Z' };
  const wire = `: connected\r\n\r\nid: 11\r\nevent: change\r\ndata: ${JSON.stringify(notification)}\r\n\r\nid: 12\r\nevent: checkpoint\r\ndata: {"cursor":"12"}\r\n\r\nevent: stream_error\r\ndata: {"code":"permission_denied"}\r\n\r\n`;
  const bytes = new TextEncoder().encode(wire);
  let calls = 0;
  const api = client(async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).searchParams.get('after'), '10');
    assert.equal(new Headers(init?.headers).get('last-event-id'), '9');
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const events = [];
  for await (const event of api.subscribeEvents(workspaceId, { after: '10', lastEventId: '9' })) events.push(event);
  assert.deepEqual(events, [{ type: 'change', id: '11', event: notification }, { type: 'checkpoint', id: '12', cursor: '12' }, { type: 'stream_error', code: 'permission_denied' }]);
  assert.equal(calls, 1);
});

test('agent chat SSE reassembles fragmented UTF-8 and CRLF frames and validates the done message', async () => {
  const threadId = '00000000-0000-4000-8000-000000000003';
  const assistant = { id: '00000000-0000-4000-8000-000000000004', threadId, role: 'assistant', content: 'Hello 世界', status: 'complete', errorCode: null, model: 'test-model', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:01.000Z' };
  const streaming = { ...assistant, content: '', status: 'streaming' };
  const user = { ...assistant, id: '00000000-0000-4000-8000-000000000005', role: 'user', content: 'hi', status: 'complete', model: null };
  const wire = [
    `event: user\ndata: ${JSON.stringify({ message: user })}\n\n`,
    `event: assistant\ndata: ${JSON.stringify({ message: streaming })}\n\n`,
    `event: delta\ndata: {"messageId":"${assistant.id}","delta":"Hello "}\n\n`,
    `event: delta\ndata: {"messageId":"${assistant.id}","delta":"世界"}\n\n`,
    `event: done\ndata: ${JSON.stringify({ message: assistant })}\n\n`,
  ].join('').replaceAll('\n', '\r\n');
  const bytes = new TextEncoder().encode(wire);
  const api = client(async (url, init) => {
    assert.equal(new URL(String(url)).pathname, `/api/v1/workspaces/${workspaceId}/agent/threads/${threadId}/messages`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { messageId: '00000000-0000-4000-8000-000000000006', content: 'hi' });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const events = [];
  for await (const event of api.streamAgentMessage(workspaceId, threadId, { messageId: '00000000-0000-4000-8000-000000000006', content: 'hi' })) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['user', 'assistant', 'delta', 'delta', 'done']);
  assert.equal(events[2]?.type === 'delta' ? events[2].delta : '', 'Hello ');
  assert.equal(events[3]?.type === 'delta' ? events[3].delta : '', '世界');
  assert.deepEqual(events[4]?.type === 'done' ? events[4].message : null, assistant);
});

for (const wire of ['', 'event: delta\ndata: {"messageId":"message","delta":"partial"}\n\n']) {
  test(`agent chat rejects EOF ${wire ? 'after a delta' : 'without events'}`, async () => {
    const response = new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
    const api = client(async () => response);
    const events: AgentChatStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of api.streamAgentMessage(workspaceId, commandId, { messageId: commandId, content: 'hi' })) events.push(event);
    }, error => error instanceof ApiError && error.status === 502 && error.code === 'agent_stream_incomplete');
    assert.deepEqual(events.map(event => event.type), wire ? ['delta'] : []);
    assert.equal(response.body!.locked, false);
  });
}

for (const type of ['done', 'cancelled', 'error'] as const) {
  test(`agent chat ${type} terminates and releases an open transport`, { timeout: 2_000 }, async () => {
    const message = { id: commandId, threadId: commandId, role: 'assistant', content: 'reply', status: type === 'done' ? 'complete' : 'cancelled', errorCode: null, model: null, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:01.000Z' };
    const payload = type === 'error' ? { code: 'provider_error', message: 'Provider failed', messageId: commandId } : { message };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: ${type}\r\ndata: ${JSON.stringify(payload)}\r\n\r\nevent: delta\ndata: {"messageId":"message","delta":"ignored"}\n\n`));
        // Keep the transport open: only the terminal event can finish iteration.
      },
      cancel() { cancelled = true; },
    });
    const api = client(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const events = [];
    for await (const event of api.streamAgentMessage(workspaceId, commandId, { messageId: commandId, content: 'hi' })) events.push(event);
    assert.deepEqual(events, [{ type, ...payload }]);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });
}


test('an established SSE stream that becomes silent aborts without replaying its last checkpoint', { timeout: 90_000 }, async t => {
  let requests = 0;
  let requestedCursor: string | null = null;
  const { promise: closed, resolve: disconnected } = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    requests++;
    requestedCursor = new URL(request.url!, 'http://localhost').searchParams.get('after');
    response.on('close', disconnected);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': connected\n\nid: 12\nevent: checkpoint\ndata: {"cursor":"12"}\n\n');
    // Model a proxy retaining the downstream socket after its upstream dies.
  });
  t.after(async () => {
    server.closeAllConnections();
    const stopped = Promise.withResolvers<void>();
    server.close(error => error ? stopped.reject(error) : stopped.resolve());
    await stopped.promise;
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const api = new ProjectManagementClient({ baseUrl: `http://127.0.0.1:${address.port}`, auth: { type: 'none' } });
  const stream = api.subscribeEvents(workspaceId, { after: '11' });
  assert.deepEqual(await stream.next(), { done: false, value: { type: 'checkpoint', id: '12', cursor: '12' } });
  await assert.rejects(stream.next(), /event_stream_idle_timeout/);
  await closed;
  assert.equal(requests, 1);
  assert.equal(requestedCursor, '11');
});

test('SSE 410 and download metadata are exposed to the caller', async () => {
  const expired = client(async () => Response.json({ error: { code: 'cursor_expired', details: { head: '25' } }, requestId: 'expired' }, { status: 410 }));
  await assert.rejects(async () => { for await (const _event of expired.subscribeEvents(workspaceId, { lastEventId: '1' })) { /* no frames */ } }, error => error instanceof ApiError && error.status === 410 && error.code === 'cursor_expired');
  const download = await client(async () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'Content-Type': 'application/octet-stream', ETag: '"digest"', 'Content-Disposition': "attachment; filename*=UTF-8''result.txt" } })).downloadArtifactVersion(workspaceId, commandId);
  assert.deepEqual([...download.bytes], [1, 2, 3]);
  assert.equal(download.etag, '"digest"');
  assert.equal(download.mediaType, 'application/octet-stream');
});

test('the Node client reads a real bootstrap HTTP server without mistaking readiness for success', async t => {
  const app = buildApp();
  t.after(async () => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const api = new ProjectManagementClient({ baseUrl: address, auth: { type: 'none' } });
  assert.deepEqual(await api.getLiveness(), { status: 'alive' });
  assert.deepEqual(await api.getReadiness(), { status: 'not_ready', reason: 'backend_not_initialized' });
  assert.equal((await api.getCapabilities()).execution.enabled, false);
});

test('malformed structured Chat events cannot become trusted capability or tool state', async () => {
  for (const [event, payload] of [
    ['capabilities', { messageId: commandId, access: { enabled: true, mode: 'full_access' } }],
    ['tool', { messageId: commandId, toolCall: { id: 'claimed', status: 'succeeded', result: 'Model says saved' } }],
    ['context', { messageId: commandId, sources: [{ kind: 'project', entityId: 'PRJ-1' }] }],
  ] as const) {
    const api = client(async () => new Response(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    await assert.rejects(async () => {
      for await (const _frame of api.streamAgentMessage(workspaceId, commandId, { messageId: commandId, content: 'Read the project' })) { /* Reject untrusted metadata. */ }
    }, error => error instanceof ApiError && error.code === 'invalid_event_stream');
  }
});

test('a valid tool update is not a Chat terminal and an EOF remains unknown', async () => {
  const toolCall = { id: 'call_read', operationId: commandId, name: 'pm_read', arguments: { id: 'TASK-1' }, status: 'running',
    startedAt: '2026-10-25T00:00:00.000Z', finishedAt: null, grantId: commandId, onBehalfOf: workspaceId, approvalPolicy: 'auto_approve', result: null, error: null };
  const api = client(async () => new Response(`event: tool\ndata: ${JSON.stringify({ messageId: commandId, toolCall })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  const stream = api.streamAgentMessage(workspaceId, commandId, { messageId: commandId, content: 'Read' });
  const first = await stream.next();
  assert.equal(first.value?.type, 'tool');
  await assert.rejects(stream.next(), error => error instanceof ApiError && error.code === 'agent_stream_incomplete');
});

test('lost access-update responses are never automatically repeated', async () => {
  let attempts = 0;
  const api = client(async () => { attempts++; throw new TypeError('Response lost after authorization commit'); });
  await assert.rejects(api.setAgentThreadAccess(workspaceId, commandId, { enabled: false, expectedRevision: 2 }), TypeError);
  assert.equal(attempts, 1);
});
