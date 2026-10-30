import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import type { Capabilities } from '../../../../packages/contracts/src/client.ts';

test('a live HTTP process does not advertise business readiness or execution', async (t) => {
  const app = buildApp();
  t.after(async () => { await app.close(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  const live = await fetch(`${address}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'alive' });

  const ready = await fetch(`${address}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    status: 'not_ready', reason: 'backend_not_initialized',
  });

  const capabilities = await fetch(`${address}/api/v1/capabilities`);
  assert.equal(capabilities.status, 200);
  const advertised = await capabilities.json() as Capabilities;
  for (const capability of ['business', 'database', 'storage', 'markdownCore', 'worker', 'realtime', 'execution'] as const) {
    assert.equal(advertised[capability].enabled, false, capability);
  }
  assert.equal(advertised.accountRecovery.request.enabled, false);
  assert.equal(advertised.accountRecovery.verification.enabled, false);

  const unsupported = await fetch(`${address}/api/v1/runs`, { method: 'POST' });
  assert.equal(unsupported.status, 404);
});

test('a fully received request retains its result when processing exceeds ten seconds', { timeout: 30_000 }, async t => {
  const app = buildApp();
  t.after(() => app.close());
  app.get('/slow-result', async () => {
    await delay(11_000);
    return { completed: true };
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/slow-result`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { completed: true });
});

test('the API accepts loopback spellings of the configured origin and rejects other browser origins', async t => {
  const app = buildApp({ publicOrigin: 'http://127.0.0.1:3224' });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const status = async (origin: string) => (await fetch(`${address}/api/v1/capabilities`, { headers: { origin } })).status;
  assert.equal(await status('http://127.0.0.1:3224'), 200);
  assert.equal(await status('http://localhost:3224'), 200);
  assert.equal(await status('http://[::1]:3224'), 200);
  assert.equal(await status('http://127.0.0.1:4326'), 403, 'another port is another origin');
  assert.equal(await status('https://localhost:3224'), 403, 'another scheme is another origin');
  assert.equal(await status('http://127.0.0.1:3224.evil.example'), 403, 'lookalike host is not loopback');
  assert.equal(await status('null'), 403);
});

test('configuration rejects invalid ports and empty hosts while accepting an explicit listen port', () => {
  for (const value of ['', '0', '65536', 'NaN', '1.5', '-1', ' 4100 ']) {
    assert.throws(() => readConfig({ PORT: value }), /PORT/);
  }
  assert.throws(() => readConfig({ HOST: '' }), /HOST/);
  assert.deepEqual(readConfig({ PORT: '4200' }), { host: '127.0.0.1', port: 4200 });
});
