import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forwardRequest } from './container-bridge.mjs';

async function listen(server, endpoint) {
  const ready = Promise.withResolvers();
  server.once('error', ready.reject);
  server.listen(endpoint, () => { server.removeListener('error', ready.reject); ready.resolve(); });
  await ready.promise;
}
async function close(server) {
  const done = Promise.withResolvers();
  server.close(() => done.resolve()); server.closeAllConnections();
  await done.promise;
}
function tcpEndpoint(server) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { host: '127.0.0.1', port: address.port };
}
async function bridgeFixture(direction, listener) {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-bridge-'));
  const upstream = createServer(listener);
  let target;
  const bridge = createServer((incoming, outgoing) => forwardRequest({ ...target, path: incoming.url ?? '/' }, incoming, outgoing));
  const cleanup = async () => { await close(bridge); await close(upstream); await rm(root, { recursive: true, force: true }); };
  try {
    if (direction === 'broker') {
      const socketPath = path.join(root, 'host.sock');
      await listen(upstream, { path: socketPath }); target = { socketPath };
      await listen(bridge, { host: '127.0.0.1', port: 0 });
      return { client: tcpEndpoint(bridge), close: cleanup };
    }
    await listen(upstream, { host: '127.0.0.1', port: 0 }); target = tcpEndpoint(upstream);
    const socketPath = path.join(root, 'agent.sock');
    await listen(bridge, { path: socketPath });
    return { client: { socketPath }, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}

for (const direction of ['broker', 'control']) {
  test(`${direction} bridge preserves complete streamed request/response bytes without cancelling completion`, { timeout: 5000 }, async t => {
    const continueBody = Promise.withResolvers(), upstreamClosed = Promise.withResolvers();
    const payload = Buffer.from('data: {"text":"完整 streamed body"}\n\ndata: [DONE]\n\n');
    const upload = Buffer.from('request body 完整');
    let received;
    const runtime = await bridgeFixture(direction, (incoming, outgoing) => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.once('end', () => {
        received = { method: incoming.method, url: incoming.url, marker: incoming.headers['x-test-marker'], body: Buffer.concat(chunks) };
        outgoing.once('close', () => upstreamClosed.resolve(outgoing.writableFinished));
        outgoing.writeHead(201, { 'content-type': 'text/event-stream', 'content-length': String(payload.length), 'x-test-reply': 'preserved' });
        outgoing.write(payload.subarray(0, 19));
        void continueBody.promise.then(() => outgoing.end(payload.subarray(19)));
      });
    });
    t.after(runtime.close);
    const result = Promise.withResolvers();
    const client = request({ ...runtime.client, path: '/responses?test=complete', method: 'POST', headers: { 'content-length': String(upload.length), 'x-test-marker': 'preserved' } }, response => {
      const chunks = [];
      response.on('data', chunk => { chunks.push(chunk); continueBody.resolve(); });
      response.once('error', result.reject);
      response.once('end', () => result.resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete }));
    });
    client.once('error', result.reject); client.end(upload);
    const response = await result.promise;
    assert.equal(response.status, 201); assert.equal(response.headers['x-test-reply'], 'preserved');
    assert.equal(response.complete, true); assert.deepEqual(response.body, payload);
    assert.deepEqual(received, { method: 'POST', url: '/responses?test=complete', marker: 'preserved', body: upload });
    assert.equal(await upstreamClosed.promise, true, 'Normal downstream completion must not cancel the upstream response');
  });

  test(`${direction} bridge propagates streamed response cancellation to its actual upstream socket`, { timeout: 5000 }, async t => {
    const upstreamClosed = Promise.withResolvers(), firstChunk = Promise.withResolvers();
    const frame = Buffer.from('data: still generating\n\n');
    const runtime = await bridgeFixture(direction, (incoming, outgoing) => {
      incoming.resume(); incoming.once('error', () => {});
      outgoing.once('close', () => upstreamClosed.resolve(outgoing.writableFinished));
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.write(frame);
    });
    t.after(runtime.close);
    const client = request({ ...runtime.client, path: '/responses', method: 'POST' }, response => {
      response.once('error', () => {});
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        chunks.push(chunk); bytes += chunk.length;
        if (bytes >= frame.length) { firstChunk.resolve(Buffer.concat(chunks)); response.destroy(); }
      });
    });
    client.once('error', firstChunk.reject); client.end('{}');
    assert.deepEqual(await firstChunk.promise, frame);
    assert.equal(await upstreamClosed.promise, false, 'Client cancellation must close the unfinished upstream before fixture cleanup');
  });

  test(`${direction} bridge aborts its actual upstream request when the client upload aborts`, { timeout: 5000 }, async t => {
    const bodyStarted = Promise.withResolvers(), upstreamAborted = Promise.withResolvers();
    const partial = Buffer.from('partial upload');
    const runtime = await bridgeFixture(direction, (incoming, outgoing) => {
      const chunks = []; let bytes = 0;
      incoming.on('data', chunk => {
        chunks.push(chunk); bytes += chunk.length;
        if (bytes >= partial.length) bodyStarted.resolve(Buffer.concat(chunks));
      });
      incoming.once('aborted', () => upstreamAborted.resolve(incoming.complete));
      incoming.once('error', () => {});
      outgoing.once('error', () => {});
    });
    t.after(runtime.close);
    const client = request({ ...runtime.client, path: '/responses', method: 'POST' });
    client.once('error', () => {});
    client.write(partial);
    assert.deepEqual(await bodyStarted.promise, partial);
    client.destroy();
    assert.equal(await upstreamAborted.promise, false, 'An unfinished client upload must abort the unfinished upstream request');
  });
}
