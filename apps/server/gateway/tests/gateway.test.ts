import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGateway } from './gateway.ts';

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: http.Server) {
  server.closeAllConnections();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close(error => error ? reject(error) : resolve());
  return promise;
}

test('gateway preserves API paths, headers, streaming and unified static fallback', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pm-gateway-'));
  await mkdir(path.join(directory, 'assets'));
  await writeFile(path.join(directory, 'index.html'), '<title>unified web</title>');
  await writeFile(path.join(directory, 'assets', 'app.js'), 'asset');
  const requests: { path: string | undefined; host: string | undefined; origin: string | undefined; cookie: string | undefined }[] = [];
  const streamResponse: { current?: http.ServerResponse } = {};
  const pm = http.createServer((req, res) => {
    requests.push({ path: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie });
    if (req.url === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      streamResponse.current = res;
    } else res.writeHead(404, { 'content-type': 'application/json' }).end('{"pm":false}');
  });
  const agent = http.createServer((req, res) => {
    requests.push({ path: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie });
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"agent":false}');
  });
  const pmUrl = await listen(pm);
  const agentUrl = await listen(agent);
  const gateway = createGateway({ pmUrl, agentUrl, webDist: directory });
  const url = await listen(gateway);
  t.after(async () => { await close(gateway); await close(pm); await close(agent); await rm(directory, { recursive: true, force: true }); });
  for (const route of ['/pm/project/example', '/agent/thread/example']) {
    assert.match(await (await fetch(url + route)).text(), /unified web/);
  }
  assert.equal(await (await fetch(url + '/assets/app.js')).text(), 'asset');
  assert.equal((await fetch(url + '/assets/missing.js')).status, 404);
  const account = await fetch(url + '/pm/account/recovery');
  assert.equal(account.headers.get('cache-control'), 'no-store');
  assert.equal(account.headers.get('referrer-policy'), 'no-referrer');
  const response = await fetch(url + '/agent/api/missing?x=1', { headers: { origin: url, cookie: 'pm_v4_session=sample' } });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '{"agent":false}');
  assert.deepEqual(requests.at(-1), { path: '/api/missing?x=1', host: new URL(url).host, origin: url, cookie: 'pm_v4_session=sample' });
  assert.equal((await fetch(url + '/api/v1/missing')).status, 404);
  assert.equal((await fetch(url + '/health/ready')).status, 404);
  const stream = await fetch(url + '/api/v1/events');
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/);
  assert.ok(streamResponse.current);
  streamResponse.current.end('data: second\n\n');
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: second/);
});

test('gateway denies private PM proof paths before proxying bodies, credentials or upgrades', async t => {
  const received: { url: string | undefined; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    received.push({ url: req.url, headers: req.headers, body });
    res.setHeader('x-private-proof', 'must-not-leak');
    res.end('private-upstream-body');
  });
  let upgrades = 0;
  upstream.on('upgrade', (_req, socket) => { upgrades++; socket.end(); });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ pmUrl: upstreamUrl, agentUrl: upstreamUrl, webDevUrl: upstreamUrl });
  const url = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  for (const route of [
    '/api/v1/internal', '/api/v1/internal/', '/api/v1/internal/agent-tools/reconcile?operationId=secret',
    '/api/v1/%69nternal/agent-tools/reconcile', '/api/v1/in%74ernal/agent-tools/reconcile',
    '/api/v1/public/../internal/agent-tools/reconcile',
  ]) {
    const response = await fetch(url + route, { method: 'POST',
      headers: { authorization: 'Bearer private-service-proof', cookie: 'pm_v4_session=private', 'content-type': 'application/json' },
      body: '{"requestHash":"private-body"}' });
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-private-proof'), null);
    assert.equal(await response.text(), '');
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const response = await fetch(url + '/api/v1/internal/agent-tools/reconcile', { method });
    assert.equal(response.status, 404);
  }
  const encodedSeparator = await fetch(url + '/api/v1/internal%2fagent-tools/reconcile');
  assert.equal(encodedSeparator.status, 400);
  assert.equal(received.length, 0, 'private body and headers never reach any PM, Agent or dev upstream');
  const address = new URL(url), socket = net.connect(Number(address.port), address.hostname);
  await once(socket, 'connect');
  socket.write(`GET /api/v1/%69nternal/agent-tools/reconcile HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: Bearer private-service-proof\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  let response = '';
  for await (const chunk of socket) response += chunk.toString();
  assert.match(response, /^HTTP\/1\.1 404/);
  assert.doesNotMatch(response, /private-service-proof|private-upstream-body|x-private-proof/);
  assert.equal(upgrades, 0);
  assert.equal(received.length, 0);
  for (const route of ['/api/v1/internalish', '/api/v1/agent-tools', '/agent/api/mcp/clients']) {
    assert.equal((await fetch(url + route)).status, 200, 'neighboring public routes retain their original proxy behavior');
  }
  assert.deepEqual(received.map(item => item.url), ['/api/v1/internalish', '/api/v1/agent-tools', '/api/mcp/clients']);
});

test('gateway forwards WebSocket upgrades and Vite dev traffic without changing Origin', async t => {
  const agent = http.createServer();
  let agentRequest: { url: string | undefined; host: string | undefined; origin: string | undefined } | undefined;
  agent.on('upgrade', (req, socket) => {
    agentRequest = { url: req.url, host: req.headers.host, origin: req.headers.origin };
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello');
    socket.end();
  });
  const dev = http.createServer((req, res) => res.end(`vite:${req.url}`));
  const agentUrl = await listen(agent);
  const devUrl = await listen(dev);
  const gateway = createGateway({ agentUrl, webDevUrl: devUrl });
  const url = await listen(gateway);
  t.after(async () => { await close(gateway); await close(agent); await close(dev); });
  assert.equal(await (await fetch(url + '/agent/deep-link')).text(), 'vite:/agent/deep-link');
  const address = new URL(url);
  const socket = net.connect(Number(address.port), address.hostname);
  await once(socket, 'connect');
  socket.write(`GET /agent/api/terminal?x=1 HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${url}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  let result = '';
  for await (const chunk of socket) result += chunk.toString();
  assert.match(result, /^HTTP\/1\.1 101/);
  assert.match(result, /hello$/);
  assert.deepEqual(agentRequest, { url: '/api/terminal?x=1', host: address.host, origin: url });
});

test('gateway shutdown drains then closes persistent SSE connections within its own grace period', async t => {
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ pmUrl: upstreamUrl });
  const url = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); upstream.closeAllConnections(); upstream.close(); });
  const response = await fetch(url + '/api/v1/events');
  const reader = response.body!.getReader();
  await reader.read();
  const ended = reader.read().catch(() => ({ done: true }));
  const stop = gateway.shutdown(20);
  assert.equal(gateway.shutdown(20), stop, 'shutdown is idempotent');
  await stop;
  assert.equal((await ended).done, true);
  assert.equal(gateway.listening, false);
});

test('gateway shutdown also releases upgraded WebSocket sockets and their upstream', async t => {
  const upstream = http.createServer();
  let upgraded: import('node:stream').Duplex | undefined;
  upstream.on('upgrade', (_req, socket) => {
    upgraded = socket;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ agentUrl: upstreamUrl });
  const url = new URL(await listen(gateway));
  const client = net.connect(Number(url.port), url.hostname);
  t.after(() => { client.destroy(); upgraded?.destroy(); upstream.close(); gateway.close(); });
  const connected = once(client, 'data');
  client.write('GET /agent/api/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await connected;
  assert.ok(upgraded);
  const closed = once(client, 'close');
  const upstreamEnded = once(upgraded, 'end');
  await gateway.shutdown(20);
  await Promise.all([closed, upstreamEnded]);
  assert.equal(gateway.listening, false);
});
