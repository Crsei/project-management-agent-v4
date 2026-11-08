import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WorkspaceCreationResult } from '../packages/contracts/src/workspace-creation.ts';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import type { WorkspaceSnapshot, FileRecord } from '../packages/pm-schema/index.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';

function ready(value: WorkspaceCreationResult): asserts value is Extract<WorkspaceCreationResult, { status: 'ready' }> {
  assert.equal(value.status, 'ready');
}

test('new workspace creates independent persisted Nova content; concurrent original keys and deleted ready content never reseed', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const workspaceClient = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
  const key = randomUUID();
  const original = { name: 'Nova workspace one', expectedActorId: f.owner.id };
  assert.equal((await f.request('/api/v1/workspaces', { method: 'POST', cookie: '', headers: { 'Idempotency-Key': key }, body: original })).status, 401);
  assert.equal((await f.request('/api/v1/workspaces', { method: 'POST', headers: { 'Idempotency-Key': key, origin: 'https://untrusted.example' }, body: original })).status, 403);
  assert.equal((await f.request('/api/v1/workspaces', { method: 'POST', headers: { 'Idempotency-Key': key }, body: { ...original, ownerId: randomUUID() } })).status, 400);
  // Exercise the production client for the 27-object durable initialization:
  // it has no implicit 30s fixture-request deadline, but remains bounded by the
  // fixture/test lifetime. Neither concurrent call retries its write.
  const requests = await Promise.all([workspaceClient.createWorkspace(original, key, { signal: f.signal }), workspaceClient.createWorkspace(original, key, { signal: f.signal })]);
  assert.deepEqual(requests[0], requests[1]);
  const first = requests[0]!; ready(first);
  const snapshot = await f.request<WorkspaceSnapshot>(`/api/v1/workspaces/${first.workspaceId}/core/workspace`);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.equal(snapshot.body.files.length, 27);
  assert.equal(snapshot.body.files.filter(file => file.entity.entity === 'work_item').length, 8);
  assert.equal(snapshot.body.files.filter(file => file.entity.entity === 'document').length, 4);
  assert.deepEqual(snapshot.body.errors.filter(issue => issue.severity === 'error'), []);
  const project = snapshot.body.files.find(file => file.id === first.sampleProjectId)!;
  assert.match(project.entity.title, /Nova/);
  assert.equal(project.entity.owner, undefined);
  for (const item of snapshot.body.files) {
    assert.equal(item.entity.assignee, undefined);
    if (item.entity.entity !== 'project') assert.equal(item.entity.project, project.id);
    for (const target of item.entity.links) assert.ok(snapshot.body.files.some(file => file.id === target), `Unresolved sample link ${target}`);
  }
  const location = await f.request<{ path: string; storageId: string }>(`/api/v1/workspaces/${first.workspaceId}/local-projects/projects/${project.id}/location`);
  assert.equal(await readFile(join(location.body.path, '.pm/core/projects', `${project.id}.md`), 'utf8'), project.raw);
  const otherKey = randomUUID();
  const other = await workspaceClient.createWorkspace({ name: 'Nova workspace two', expectedActorId: f.owner.id }, otherKey, { signal: f.signal });
  ready(other);
  assert.notEqual(other.workspaceId, first.workspaceId);
  const otherLocation = await f.request<{ path: string; storageId: string }>(`/api/v1/workspaces/${other.workspaceId}/local-projects/projects/${other.sampleProjectId}/location`);
  assert.notEqual(otherLocation.body.path, location.body.path);
  assert.notEqual(otherLocation.body.storageId, location.body.storageId);
  const updated = await f.request<FileRecord>(`/api/v1/workspaces/${first.workspaceId}/core/entities/${project.id}`, { method: 'PATCH', body: { revision: project.revision, changes: { title: 'Edited only in one workspace' } } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const unchanged = await f.request<FileRecord>(`/api/v1/workspaces/${other.workspaceId}/core/files/${other.sampleProjectId}`);
  assert.equal(unchanged.body.entity.title, project.entity.title);
  const originalWorkspace = await f.request<WorkspaceSnapshot>(`/api/v1/workspaces/${f.workspaceId}/core/workspace`);
  assert.equal(originalWorkspace.body.files.length, 0, 'An existing workspace with no sample intent stays empty');
  const mismatch = await f.request('/api/v1/workspaces', { method: 'POST', headers: { 'Idempotency-Key': key }, body: { name: 'Changed frozen name', expectedActorId: f.owner.id } });
  assert.equal(mismatch.status, 409);
  const deletedPath = join(location.body.path, '.pm/core/projects', `${project.id}.md`);
  await rm(deletedPath);
  assert.equal((await f.request('/api/v1/workspaces')).status, 200);
  const replay = await workspaceClient.createWorkspace(original, key, { signal: f.signal });
  assert.deepEqual(replay, first);
  await assert.rejects(readFile(deletedPath), { code: 'ENOENT' });
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n, 3);
});

test('failed new-workspace Nova initialization retains one frozen workspace and recovers after storage returns', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const workspaceClient = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
  const key = randomUUID();
  const settings = await f.request<{ defaultParent: string }>(`/api/v1/workspaces/${f.workspaceId}/local-projects/settings`);
  const parent = settings.body.defaultParent;
  const offline = `${parent}-offline`;
  await rename(parent, offline);
  let workspaceId: string | undefined;
  try {
    const failed = await f.request<{ error: { code: string } }>('/api/v1/workspaces', { method: 'POST', headers: { 'Idempotency-Key': key }, body: { name: 'Recover original Nova', expectedActorId: f.owner.id } });
    // Missing trusted storage is the existing recoverable directory conflict,
    // not a generic initialization failure or a rejection of the new intent.
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, 'local_directory_unavailable');
    const pending = await f.request<WorkspaceCreationResult>(`/api/v1/workspace-creations/${key}`);
    assert.equal(pending.body.status, 'pending');
    assert.ok(pending.body.status === 'pending'); workspaceId = pending.body.workspaceId;
    const stillOffline = await f.request<{ error: { code: string } }>(`/api/v1/workspace-creations/${key}/recover`, { method: 'POST', body: { expectedActorId: f.owner.id } });
    assert.equal(stillOffline.status, 409);
    assert.equal(stillOffline.body.error.code, 'local_directory_unavailable');
    const retained = await f.request<WorkspaceCreationResult>(`/api/v1/workspace-creations/${key}`);
    assert.deepEqual(retained.body, { status: 'pending', key, workspaceId });
    assert.equal((await f.request(`/api/v1/workspaces/${workspaceId}/core/workspace`)).status, 503);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n, 2);
    const listing = await f.request<{ items: { id: string }[]; pendingInitializations: { workspaceId: string; name: string; key: string | null }[] }>('/api/v1/workspaces');
    assert.equal(listing.status, 200);
    assert.ok(listing.body.items.some(item => item.id === f.workspaceId));
    assert.equal(listing.body.items.some(item => item.id === workspaceId), false);
    assert.deepEqual(listing.body.pendingInitializations, [{ workspaceId, name: 'Recover original Nova', key }]);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/core/workspace`)).status, 200);
    assert.equal((await f.request('/api/v1/workspaces', { cookie: '' })).status, 401);
  } finally { await rename(offline, parent); }
  assert.ok(workspaceId);
  const resumed = await workspaceClient.recoverWorkspaceCreation(key, { expectedActorId: f.owner.id }, { signal: f.signal });
  ready(resumed);
  assert.equal(resumed.workspaceId, workspaceId);
  assert.equal((await f.request<WorkspaceSnapshot>(`/api/v1/workspaces/${workspaceId}/core/workspace`)).body.files.length, 27);
  const outsider = await f.member('Unrelated workspace creator');
  assert.deepEqual((await f.request<WorkspaceCreationResult>(`/api/v1/workspace-creations/${key}`, { cookie: outsider.cookie })).body, { status: 'not_found' });
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n, 2);
});

test('readiness inventories untouched Nova authority with local projects disabled, without treating an empty instance as lost storage', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal, localProjectsEnabled: false }); t.after(() => f.close());
  await f.startWorker();
  const empty = await f.request<{ checks: { core: boolean } }>('/health/ready');
  assert.equal(empty.status, 200); assert.equal(empty.body.checks.core, true);
  const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
  const created = await client.createWorkspace({ name: 'Untouched shared-root Nova', expectedActorId: f.owner.id }, randomUUID(), { signal: f.signal });
  ready(created);
  assert.deepEqual((await f.pool.query(`SELECT
    (SELECT count(*)::int FROM project_audit WHERE workspace_id=$1) AS audit,
    (SELECT count(*)::int FROM local_project_operations WHERE workspace_id=$1) AS local,
    (SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) AS receipts`, [created.workspaceId])).rows[0],
  { audit: 0, local: 0, receipts: 0 }, 'The sample row must be the only SQL core-authority evidence');
  const before = await f.request<{ checks: { core: boolean } }>('/health/ready');
  assert.equal(before.status, 200); assert.equal(before.body.checks.core, true);
  const root = join(f.coreRoot, created.workspaceId), offline = join(f.root, 'offline-nova');
  await f.stopServices();
  await rename(root, offline);
  try {
    await f.restartApi(false); await f.startWorker();
    const missing = await f.request<{ status: string; checks: { core: boolean; database: boolean; storage: boolean; worker: boolean } }>('/health/ready');
    assert.equal(missing.status, 503); assert.equal(missing.body.status, 'not_ready');
    assert.equal(missing.body.checks.core, false);
    assert.equal(missing.body.checks.database, true); assert.equal(missing.body.checks.storage, true); assert.equal(missing.body.checks.worker, true);
    const access = await f.request<{ error: { code: string } }>(`/api/v1/workspaces/${created.workspaceId}/core/workspace`);
    assert.equal(access.status, 503); assert.equal(access.body.error.code, 'core_workspace_storage_missing');
    await assert.rejects(readFile(join(root, '.pm/state/state.json')), { code: 'ENOENT' });
    assert.equal((await f.pool.query('SELECT status FROM workspace_sample_initializations WHERE workspace_id=$1', [created.workspaceId])).rows[0].status, 'ready');
  } finally {
    await f.stopServices();
    await rename(offline, root);
  }
  await f.restartApi(false); await f.startWorker();
  assert.equal((await f.request('/health/ready')).status, 200);
  const restored = await f.request<WorkspaceSnapshot>(`/api/v1/workspaces/${created.workspaceId}/core/workspace`);
  assert.equal(restored.status, 200); assert.equal(restored.body.files.length, 27);
});

test('workspace creation can omit the sample and keeps one idempotent empty workspace', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
  const key = randomUUID();
  const request = { name: 'Empty workspace', expectedActorId: f.owner.id, includeSample: false };
  const first = await client.createWorkspace(request, key, { signal: f.signal });
  ready(first);
  assert.equal(first.sampleProjectId, null);
  assert.deepEqual(await client.createWorkspace({ ...request, includeSample: true }, key, { signal: f.signal }), first);
  const list = await f.request<{ items: { id: string }[]; pendingInitializations: { workspaceId: string }[] }>('/api/v1/workspaces');
  assert.ok(list.body.items.some(item => item.id === first.workspaceId));
  assert.equal(list.body.pendingInitializations.some(item => item.workspaceId === first.workspaceId), false);
  const snapshot = await f.request<WorkspaceSnapshot>(`/api/v1/workspaces/${first.workspaceId}/core/workspace`);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.deepEqual(snapshot.body.files, []);
  assert.deepEqual((await f.pool.query('SELECT template,sample_skipped,status,project_id FROM workspace_sample_initializations WHERE workspace_id=$1', [first.workspaceId])).rows[0], { template: null, sample_skipped: true, status: 'ready', project_id: null });
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n, 2);
});
