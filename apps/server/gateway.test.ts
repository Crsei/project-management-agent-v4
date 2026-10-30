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
  const requests: { path?: string; host?: string; origin?: string; cookie?: string }[] = [];
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

test('gateway forwards WebSocket upgrades and Vite dev traffic without changing Origin', async t => {
  const agent = http.createServer();
  let agentRequest: { url?: string; host?: string; origin?: string } | undefined;
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
