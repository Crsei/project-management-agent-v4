import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

test('setup remains an infrastructure error when buildApp has no database, without preventing liveness', async t => {
  const app = buildApp(); t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await fetch(`${origin}/health/live`)).status, 200);
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${origin}/api/v1/setup${method === 'GET' ? '/status' : ''}`, {
      method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    });
    assert.equal(response.status, 503);
    const result = await response.json() as { error: { code: string }; initialized?: boolean };
    assert.equal(result.error.code, 'backend_not_initialized');
    assert.equal(result.initialized, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.has('set-cookie'), false);
  }
});
