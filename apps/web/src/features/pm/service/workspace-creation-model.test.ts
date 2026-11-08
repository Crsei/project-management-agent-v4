import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectManagementClient, ApiError, type WorkspaceCreationResult } from '../../../../../../packages/contracts/src/client.ts';
import { decodeWorkspaceCreationDraft, prepareWorkspaceCreation, runWorkspaceCreation } from './workspace-creation-model.ts';

const first = { key: '11111111-1111-4111-8111-111111111111', name: 'Independent workspace', includeSample: false };
const second = { key: '22222222-2222-4222-8222-222222222222', name: 'Other workspace', includeSample: true };

test('workspace preparation persists before sending and retains the exact original across refresh and another tab', () => {
  let value: string | null = null;
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  assert.deepEqual(prepareWorkspaceCreation(storage, 'actor-origin', first), first);
  assert.deepEqual(decodeWorkspaceCreationDraft(value), first);
  assert.deepEqual(prepareWorkspaceCreation(storage, 'actor-origin', second), first);
  assert.deepEqual(decodeWorkspaceCreationDraft(value), first);
});

test('unavailable or corrupt workspace recovery storage never authorizes replacement preparation', () => {
  assert.throws(() => prepareWorkspaceCreation({ getItem: () => '{broken', setItem: () => { throw new Error('must not write'); } }, 'actor-origin', first));
  assert.throws(() => prepareWorkspaceCreation({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 'actor-origin', first), /quota/);
  assert.throws(() => decodeWorkspaceCreationDraft(JSON.stringify({ ...first, credential: 'not-permitted' })));
  assert.throws(() => decodeWorkspaceCreationDraft(JSON.stringify({ ...first, key: 'replacement' })));
  assert.equal(decodeWorkspaceCreationDraft(null), null);
  assert.deepEqual(decodeWorkspaceCreationDraft(JSON.stringify({ key: first.key, name: first.name })), { key: first.key, name: first.name, includeSample: true });
});

const actorA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pending: WorkspaceCreationResult = { status: 'pending', key: first.key, workspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };

function recoveryTransport(delayAuthority = false, refuseMutation = false) {
  let cookie = actorA;
  const lookup = Promise.withResolvers<WorkspaceCreationResult>();
  const lookupStarted = Promise.withResolvers<void>();
  const authorityStarted = Promise.withResolvers<void>();
  const authorityReleased = Promise.withResolvers<void>();
  const requests: { method: string; path: string; actor: string }[] = [];
  const writes: { actor: string; key: string | null; body: unknown; path: string }[] = [];
  const client = new ProjectManagementClient({
    baseUrl: 'https://workspace-recovery.example.test',
    auth: { type: 'cookie', credentials: 'same-origin', cookie: () => `synthetic-session=${cookie}` },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const actor = new Headers(init?.headers).get('Cookie')!.slice('synthetic-session='.length);
      const method = init?.method ?? 'GET';
      requests.push({ method, path, actor });
      if (path === '/api/v1/auth/me') {
        authorityStarted.resolve();
        if (delayAuthority) await authorityReleased.promise;
        return actor ? Response.json({ actor: { id: actor, name: 'Synthetic account' } }) : Response.json({ error: { code: 'unauthenticated' } }, { status: 401 });
      }
      if (method === 'GET' && path === `/api/v1/workspace-creations/${first.key}`) {
        lookupStarted.resolve();
        return Response.json(await lookup.promise);
      }
      if (method === 'POST' && (path === '/api/v1/workspaces' || path === `/api/v1/workspace-creations/${first.key}/recover`)) {
        writes.push({ actor, key: new Headers(init?.headers).get('Idempotency-Key'), body: JSON.parse(String(init?.body)), path });
        if (refuseMutation) return Response.json({ error: { code: 'session_changed', message: 'The authenticated account changed.' } }, { status: 409 });
        return Response.json(pending);
      }
      throw new Error(`Unexpected recovery request: ${method} ${path}`);
    },
  });
  return { client, requests, writes, lookup, lookupStarted, authorityStarted, authorityReleased, switchCookie: (actor: string) => { cookie = actor; } };
}

for (const status of [{ status: 'not_found' } as const, pending]) {
  for (const transition of ['unmount', 'logout', 'account-switch', 'new-session'] as const) {
    test(`delayed ${status.status} lookup cannot resume after ${transition}`, async () => {
      const transport = recoveryTransport();
      let mounted = true;
      let actor: string | null = actorA;
      let epoch = 1;
      const recovery = runWorkspaceCreation(transport.client, 'recover', first, actorA, () => mounted && actor === actorA && epoch === 1);
      await transport.lookupStarted.promise;
      if (transition === 'unmount') mounted = false;
      if (transition === 'logout') actor = null;
      if (transition === 'account-switch') actor = actorB;
      if (transition === 'new-session') epoch++;
      transport.lookup.resolve(status);
      await assert.rejects(recovery, /session changed/);
      assert.equal(transport.requests.length, 1);
      assert.deepEqual(transport.writes, []);
    });
  }

  for (const cookie of [actorB, '']) {
    test(`delayed ${status.status} lookup rechecks Cookie authority even while React still has account A (${cookie ? 'switched' : 'logged out'})`, async () => {
      const transport = recoveryTransport();
      const recovery = runWorkspaceCreation(transport.client, 'recover', first, actorA, () => true);
      await transport.lookupStarted.promise;
      transport.switchCookie(cookie);
      transport.lookup.resolve(status);
      await assert.rejects(recovery);
      assert.deepEqual(transport.requests.map(request => request.path), [`/api/v1/workspace-creations/${first.key}`, '/api/v1/auth/me']);
      assert.deepEqual(transport.writes, []);
    });
  }
}

test('unmount during fresh session authority lookup still prevents the follow-up POST', async () => {
  const transport = recoveryTransport(true);
  let mounted = true;
  const recovery = runWorkspaceCreation(transport.client, 'recover', first, actorA, () => mounted);
  await transport.lookupStarted.promise;
  transport.lookup.resolve({ status: 'not_found' });
  await transport.authorityStarted.promise;
  mounted = false;
  transport.authorityReleased.resolve();
  await assert.rejects(recovery, /session changed/);
  assert.deepEqual(transport.writes, []);
});

for (const status of [{ status: 'not_found' } as const, pending]) {
  test(`same-account recovery of ${status.status} keeps lookup-before-write and the original request`, async () => {
    const transport = recoveryTransport();
    const recovery = runWorkspaceCreation(transport.client, 'recover', first, actorA, () => true);
    await transport.lookupStarted.promise;
    assert.deepEqual(transport.writes, []);
    transport.lookup.resolve(status);
    assert.deepEqual(await recovery, pending);
    assert.deepEqual(transport.requests.map(request => [request.method, request.path]), [
      ['GET', `/api/v1/workspace-creations/${first.key}`],
      ['GET', '/api/v1/auth/me'],
      ['POST', status.status === 'pending' ? `/api/v1/workspace-creations/${first.key}/recover` : '/api/v1/workspaces'],
    ]);
    assert.deepEqual(transport.writes, [{
      actor: actorA,
      key: status.status === 'pending' ? null : first.key,
      body: status.status === 'pending' ? { expectedActorId: actorA } : { name: first.name, expectedActorId: actorA, includeSample: first.includeSample },
      path: status.status === 'pending' ? `/api/v1/workspace-creations/${first.key}/recover` : '/api/v1/workspaces',
    }]);
  });
}

test('check and ready recovery remain read-only and return the original result', async () => {
  const ready: WorkspaceCreationResult = { ...pending, status: 'ready', sampleProjectId: 'PRJ-001' };
  for (const [mode, result] of [['check', { status: 'not_found' }], ['recover', ready]] as const) {
    const transport = recoveryTransport();
    const recovery = runWorkspaceCreation(transport.client, mode, first, actorA, () => true);
    await transport.lookupStarted.promise;
    transport.lookup.resolve(result);
    assert.deepEqual(await recovery, result);
    assert.equal(transport.requests.length, 1);
    assert.deepEqual(transport.writes, []);
  }
});

test('initial creation also requires the current Cookie actor and retains the exact original name and key', async () => {
  const transport = recoveryTransport();
  assert.deepEqual(await runWorkspaceCreation(transport.client, 'create', first, actorA, () => true), pending);
  assert.deepEqual(transport.requests.map(request => request.path), ['/api/v1/auth/me', '/api/v1/workspaces']);
  assert.deepEqual(transport.writes, [{ actor: actorA, key: first.key, body: { name: first.name, expectedActorId: actorA, includeSample: first.includeSample }, path: '/api/v1/workspaces' }]);
  transport.switchCookie(actorB);
  await assert.rejects(runWorkspaceCreation(transport.client, 'create', first, actorA, () => true), /session changed/);
  assert.equal(transport.writes.length, 1);
});

for (const status of [{ status: 'not_found' } as const, pending]) {
  test(`Cookie switch during delayed authority response preserves captured actor for ${status.status} and never retries a mutation refusal`, async () => {
    // This model test covers the emitted intent and refusal transition. The real
    // HTTP integration test proves server-side refusal without side effects.
    const transport = recoveryTransport(true, true);
    const recovery = runWorkspaceCreation(transport.client, 'recover', first, actorA, () => true);
    await transport.lookupStarted.promise;
    transport.lookup.resolve(status);
    await transport.authorityStarted.promise;
    transport.switchCookie(actorB);
    transport.authorityReleased.resolve();
    await assert.rejects(recovery, error => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
    assert.deepEqual(transport.writes, [{
      actor: actorB,
      key: status.status === 'pending' ? null : first.key,
      body: status.status === 'pending' ? { expectedActorId: actorA } : { name: first.name, expectedActorId: actorA, includeSample: first.includeSample },
      path: status.status === 'pending' ? `/api/v1/workspace-creations/${first.key}/recover` : '/api/v1/workspaces',
    }]);
    assert.equal(transport.requests.length, 3);
  });
}
