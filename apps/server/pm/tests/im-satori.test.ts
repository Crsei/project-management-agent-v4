import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createImSatoriRuntime } from '../src/im-satori.ts';

type Captured = { body: { channel_id: string; content: string }; headers: http.IncomingHttpHeaders };

async function fixture() {
  const captured: Captured[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  const runtime = createImSatoriRuntime({
    config: {
      wsUrl: 'ws://127.0.0.1:1/satori',
      apiUrl: `http://127.0.0.1:${port}/satori`,
      token: 'T'.repeat(32),
      platforms: ['telegram'],
      timeoutMs: 2_000,
      linkTtlSeconds: 600,
      gatewayId: 'test-gateway',
      botUsername: 'dovspace_test_bot',
    },
    database: () => { throw new Error('This unit test must not reach the database'); },
    publicOrigin: 'http://127.0.0.1:3224',
    ports: {
      execute: async () => { throw new Error('unexpected execute'); },
      list: async () => { throw new Error('unexpected list'); },
      read: async () => { throw new Error('unexpected read'); },
      findWatch: async () => { throw new Error('unexpected watch'); },
    },
  });
  return {
    captured,
    runtime,
    close: async () => {
      runtime.stop();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function event(content: string, overrides: Record<string, unknown> = {}) {
  return {
    sn: 1,
    type: 'message',
    self_id: 'bot-1',
    platform: 'telegram',
    timestamp: Date.now(),
    user: { id: 'user-1', name: 'Operator' },
    channel: { id: 'dm-1', type: 1 },
    message: { id: `message-${content}`, content },
    ...overrides,
  };
}

test('Satori runtime answers help and rejects group messages without executing commands', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.runtime.handleEvent(event('/help'));
  assert.equal(f.captured.length, 1);
  assert.equal(f.captured[0]!.body.channel_id, 'dm-1');
  assert.match(f.captured[0]!.body.content, /\/link/);
  assert.equal(f.captured[0]!.headers['satori-user-id'], 'bot-1');
  assert.equal(f.captured[0]!.headers['satori-platform'], 'telegram');

  await f.runtime.handleEvent(event('/task forbidden', { guild: { id: 'group-1' } }));
  assert.equal(f.captured.length, 2);
  assert.match(f.captured[1]!.body.content, /仅支持私聊/);
});

test('Satori runtime ignores non-command, disallowed-platform, bot and malformed events', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.runtime.handleEvent(event('hello'));
  await f.runtime.handleEvent(event('/help', { platform: 'discord' }));
  await f.runtime.handleEvent(event('/help', { user: { id: 'bot-2', is_bot: true } }));
  await f.runtime.handleEvent({ type: 'message' });
  assert.equal(f.captured.length, 0);
});
