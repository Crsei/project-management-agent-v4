import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { ProjectManagementClient, ApiError } from '../packages/contracts/src/client.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';

// Real isolated HTTP/session/database/storage boundary, not a mocked mutation.
test('workspace mutations refuse an intent captured for another Cookie account before any side effects', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const other = await f.member('Synthetic other creation account');
  let cookie = f.ownerCookie;
  const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => cookie } });
  const captured = await client.getMe({ signal: f.signal });
  assert.equal(captured.actor.id, f.owner.id);
  const key = randomUUID();
  const name = 'Captured workspace intent';
  async function snapshot() {
    return {
      counts: (await f.pool.query(`SELECT
        (SELECT count(*)::int FROM workspaces) AS workspaces,
        (SELECT count(*)::int FROM memberships) AS memberships,
        (SELECT count(*)::int FROM workspace_sample_initializations) AS samples,
        (SELECT count(*)::int FROM project_audit) AS audit`)).rows[0],
      core: (await readdir(f.coreRoot)).sort(),
      parents: await Promise.all(f.parents.map(async path => (await readdir(path)).sort())),
      samples: (await f.pool.query('SELECT workspace_id,actor_id,request_key,status,core_initialization_phase,core_root_identity FROM workspace_sample_initializations ORDER BY workspace_id')).rows,
    };
  }
  const before = await snapshot();
  cookie = other.cookie;
  await assert.rejects(client.createWorkspace({ name, expectedActorId: captured.actor.id }, key, { signal: f.signal }), error => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
  await assert.rejects(client.recoverWorkspaceCreation(key, { expectedActorId: captured.actor.id }, { signal: f.signal }), error => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
  assert.deepEqual(await snapshot(), before, 'A stale account intent must create no workspace, membership, sample, audit or directory');
  assert.deepEqual(await client.getWorkspaceCreation(key, { signal: f.signal }), { status: 'not_found' });

  // No optional/default actor shim: old callers cannot silently bind to B.
  const missingCreate = await f.request<{ error: { code: string } }>('/api/v1/workspaces', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { name } });
  const missingRecover = await f.request<{ error: { code: string } }>(`/api/v1/workspace-creations/${key}/recover`, { method: 'POST', cookie, body: {} });
  assert.equal(missingCreate.status, 400); assert.equal(missingRecover.status, 400);
  assert.deepEqual(await snapshot(), before);

  // A separately explicit intent captured for B works under B, using the same
  // previously refused key without creating any hidden A-owned workspace.
  const created = await client.createWorkspace({ name, expectedActorId: other.user.id }, key, { signal: f.signal });
  assert.equal(created.status, 'ready');
  assert.ok(created.status === 'ready');
  const after = await snapshot();
  assert.equal(after.counts.workspaces, before.counts.workspaces + 1);
  assert.equal(after.counts.memberships, before.counts.memberships + 1);
  assert.equal(after.counts.samples, before.counts.samples + 1);
  assert.deepEqual((await f.pool.query('SELECT owner_id FROM workspaces WHERE id=$1', [created.workspaceId])).rows, [{ owner_id: other.user.id }]);
  assert.equal((await f.request<{ files: unknown[] }>(`/api/v1/workspaces/${created.workspaceId}/core/workspace`, { cookie })).body.files.length, 27);
  assert.deepEqual(await client.recoverWorkspaceCreation(key, { expectedActorId: other.user.id }, { signal: f.signal }), created);
  const settled = await snapshot();

  // Even an existing ready key refuses the stale actor before returning it.
  await assert.rejects(client.recoverWorkspaceCreation(key, { expectedActorId: captured.actor.id }, { signal: f.signal }), error => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
  await assert.rejects(client.createWorkspace({ name, expectedActorId: captured.actor.id }, key, { signal: f.signal }), error => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
  assert.deepEqual(await snapshot(), settled);
});
