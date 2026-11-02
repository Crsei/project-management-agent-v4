import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { resolveAgentScope } from './agent-scope.ts';

const scope = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001' };
afterEach(() => { mock.restoreAll(); });

test('scope resolution always attaches an owned deadline signal and preserves request-local credentials', async () => {
  let signal: AbortSignal | null | undefined;
  mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-only');
    assert.equal(init?.redirect, 'error');
    return Response.json({ scope, workspaceName: 'Fixture', projectName: 'Fixture', path: '/tmp/pm-scope-fixture' });
  });
  const snapshot = await resolveAgentScope(scope, new Headers({ authorization: 'Bearer fixture-only' }));
  assert.ok(signal instanceof AbortSignal);
  assert.equal(snapshot.path, '/tmp/pm-scope-fixture');
});

test('caller cancellation aborts and drains in-flight scope authorization rather than racing a detached fetch', async () => {
  const entered = Promise.withResolvers<void>();
  let fetchSettled = false;
  mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    const result = Promise.withResolvers<Response>();
    signal.addEventListener('abort', () => { fetchSettled = true; result.reject(signal.reason); }, { once: true });
    entered.resolve();
    return result.promise;
  });
  const controller = new AbortController();
  const resolving = resolveAgentScope(scope, undefined, controller.signal);
  await entered.promise;
  controller.abort('fixture-stop');
  await assert.rejects(resolving, error => error instanceof Error && 'code' in error && error.code === 'scope_unavailable');
  assert.equal(fetchSettled, true);
});

test('the same cancellation signal remains active while the PM response body is being consumed', async () => {
  const consuming = Promise.withResolvers<void>();
  let bodyAborted = false;
  mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => { bodyAborted = true; controller.error(new Error('fixture body aborted')); }, { once: true });
        controller.enqueue(new TextEncoder().encode('{"scope":'));
      },
      pull() { consuming.resolve(); },
    }), { headers: { 'content-type': 'application/json' } });
  });
  const controller = new AbortController();
  const resolving = resolveAgentScope(scope, undefined, controller.signal);
  await consuming.promise;
  controller.abort('fixture-stop-body');
  await assert.rejects(resolving, error => error instanceof Error && 'code' in error && error.code === 'scope_unavailable');
  assert.equal(bodyAborted, true);
});
