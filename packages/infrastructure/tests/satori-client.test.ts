import assert from 'node:assert/strict';
import test from 'node:test';
import { createSatoriClient, type SatoriSocket } from '../src/satori-client.ts';

test('Satori client connects to the v1 events endpoint, not the bare API base', () => {
  let requested = '';
  const socket: SatoriSocket = {
    addEventListener() {},
    send() {},
    close() {},
  };
  const client = createSatoriClient({
    url: 'ws://127.0.0.1:5140/satori',
    token: 'T'.repeat(32),
    onEvent() {},
    socketFactory(url) { requested = url; return socket; },
  });
  client.start();
  assert.equal(requested, 'ws://127.0.0.1:5140/satori/v1/events');
  client.stop();
});

test('Satori READY exposes bot identity and online state separately from the session counter', () => {
  const listeners = new Map<string, (event: { data?: unknown; code?: number }) => void>();
  const sent: string[] = [];
  const socket: SatoriSocket = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    send(data) { sent.push(data); },
    close() {},
  };
  const client = createSatoriClient({
    url: 'ws://127.0.0.1:5140/satori',
    token: 'T'.repeat(32),
    onEvent() {},
    socketFactory() { return socket; },
  });
  client.start();
  listeners.get('open')!({});
  assert.equal(JSON.parse(sent[0]!).op, 3);
  listeners.get('message')!({
    data: JSON.stringify({
      op: 4,
      body: { logins: [{ sn: 999, platform: 'telegram', user: { id: 'bot-1', name: 'Dovspace bot' }, status: 1 }] },
    }),
  });
  const ready = client.status();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.bots[0]?.selfId, 'bot-1');
  assert.equal(ready.bots[0]?.status, 'online');
  assert.equal(ready.bots[0]?.name, 'Dovspace bot');
  listeners.get('close')!({ code: 1006 });
  assert.equal(client.status().state, 'disconnected');
  assert.deepEqual(client.status().bots, []);
  client.stop();
});
