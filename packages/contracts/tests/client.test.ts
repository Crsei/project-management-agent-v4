/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadableStream } from 'node:stream/web';
import { createServer } from 'node:http';
import { buildApp } from '../../../apps/server/pm/src/app.ts';
import { ApiError, CommandOutcomeUnknown, ProjectManagementClient, type Command } from '../src/client.ts';

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
  const cookie = new ProjectManagementClient({ baseUrl: 'https://example.test', auth: { type: 'cookie', credentials: 'same-origin', cookie: () => 'pm_v4_session=explicit' }, fetch });
  await cookie.getMe();
  assert.deepEqual(seen, [
    { credentials: 'omit', bearer: null, cookie: null },
    { credentials: 'omit', bearer: 'Bearer first', cookie: null },
    { credentials: 'omit', bearer: 'Bearer second', cookie: null },
    { credentials: 'same-origin', bearer: null, cookie: 'pm_v4_session=explicit' },
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

