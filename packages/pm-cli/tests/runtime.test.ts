import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { CliRequestError, createCliRuntime, parseOptions } from '../runtime.ts';

const token = 'synthetic-private-runtime-token-1234567890123456789';

test('strict shared parsing rejects unsupported, missing and duplicate options', () => {
  assert.deepEqual(parseOptions(['--file=a.json', '--revision', 'absent'], ['file', 'revision']), { file: 'a.json', revision: 'absent' });
  for (const args of [['--file', 'a', '--file', 'b'], ['--file'], ['--unknown', 'a'], ['position'], ['--file', '--revision', 'x']]) assert.throws(() => parseOptions(args, ['file', 'revision']));
});

test('PM service identity is workspace-independent; scoped requests preserve headers, HTTP errors and raw bodies', async t => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? '');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === '/api/v1/account') { response.setHeader('Content-Type', 'application/json'); response.end('{"account":true}'); return; }
    if (request.url === '/api/v1/workspaces') { response.setHeader('Content-Type', 'application/json'); response.end('{"items":[{"id":"first"},{"id":"second"}]}'); return; }
    if (request.url === '/api/v1/workspaces/selected/core/bytes') { response.setHeader('Content-Type', 'application/octet-stream'); response.end(Buffer.from([0, 1, 255])); return; }
    if (request.url === '/api/v1/workspaces/selected/core/stream') { response.setHeader('Content-Type', 'text/event-stream'); response.end('id: actual-cursor\nevent: change\ndata: {"observed":true}\n\n'); return; }
    if (request.url === '/api/v1/workspaces/selected/core/rejected') {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Current revision differs', diagnostics: [{ code: 'REVISION_CONFLICT', severity: 'error', message: 'stale', path: 'task.md' }] })); return;
    }
    if (request.url === '/api/v1/workspaces/selected/core/malformed') { response.end('not-json'); return; }
    response.writeHead(404); response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const previous = { PM_API_URL: process.env.PM_API_URL, PM_SESSION_TOKEN: process.env.PM_SESSION_TOKEN, PM_WORKSPACE_ID: process.env.PM_WORKSPACE_ID };
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.PM_SESSION_TOKEN = token;
  delete process.env.PM_WORKSPACE_ID;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const closed = once(server, 'close');
    server.closeAllConnections(); server.close();
    await closed;
  });
  const runtime = createCliRuntime();
  assert.deepEqual(await runtime.authentication(), { origin: process.env.PM_API_URL, headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await runtime.json('service', '/account'), { account: true });
  assert.deepEqual(calls, ['/api/v1/account'], 'Service requests and identity forwarding do not select a workspace');
  await assert.rejects(runtime.connection(), (error: unknown) => error instanceof CliRequestError && error.code === 'CLI_WORKSPACE_REQUIRED');
  assert.deepEqual(await runtime.json('service', '/account'), { account: true }, 'A workspace ambiguity does not poison service authentication');
  process.env.PM_WORKSPACE_ID = 'selected';
  const selected = createCliRuntime();
  const bytes = await selected.response('core', '/bytes');
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), new Uint8Array([0, 1, 255]));
  const stream = await selected.response('core', '/stream');
  assert.equal(stream.bodyUsed, false, 'Raw response ownership belongs to the stream consumer');
  const reader = stream.body!.getReader();
  try { assert.match(new TextDecoder().decode((await reader.read()).value), /id: actual-cursor/); }
  finally { await reader.cancel(); reader.releaseLock(); }
  await assert.rejects(selected.response('core', '/rejected'), (error: unknown) => error instanceof CliRequestError && error.status === 409 && error.code === 'REVISION_CONFLICT');
  await assert.rejects(selected.json('core', '/malformed'), (error: unknown) => error instanceof CliRequestError && error.code === 'CLI_INVALID_RESPONSE');
  const before = calls.length;
  for (const name of ['Authorization', 'authorization', 'COOKIE', 'Origin', 'Host', 'Proxy-Authorization']) await assert.rejects(selected.json('core', '/bytes', { headers: { [name]: 'caller-value' } }), /CLI manages/);
  for (const endpoint of ['https://other.invalid', '//other.invalid/path', '/../account', '/%2e%2e/account', '/bytes#fragment', '/\\other.invalid']) await assert.rejects(selected.json('core', endpoint));
  assert.equal(calls.length, before, 'Unsafe paths and managed headers are rejected before dispatch');
});
