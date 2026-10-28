import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ProjectManagementClient } from '../packages/contracts/src/client.ts';
import { agentCatalogSchema, type AgentCatalog, type AgentFileArea, type AgentScope, type AgentStorageSettings } from '../packages/contracts/src/agent-file-areas.ts';
import type { LocalProjectAttempt } from '../packages/contracts/src/local-projects.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createLocalProjectFixture, localProjectCaseTimeout, type LocalProjectFixture } from './local-project-fixture.ts';

type Failure = { error: { code: string; details?: { currentRevision?: number; reason?: string } } };
async function initialize(f: LocalProjectFixture, name: string, folder: string) {
  const result = await f.request<LocalProjectAttempt>(`/api/v1/workspaces/${f.workspaceId}/local-projects/initializations`, {
    method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
    body: { input: { entity: 'project', title: name, body: 'Original PM project authority' }, directory: { mode: 'new', parentPath: f.parents[0], folderName: folder } },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  if (result.body.status !== 'ready') throw new Error('Native project did not initialize');
  return result.body;
}

// A real PostgreSQL URL is required by the fixture; these acceptance cases never skip.
describe('v3 Agent file areas: real PM authorization, disk and SQL mappings', { concurrency: 1 }, () => {
  it('lists true empty groups, resolves the original mount, and persists independent two-level mappings without moving PM data', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const empty = await createWorkspace(f.pool, f.owner.id, 'A real empty workspace');
    const project = await initialize(f, 'A real empty project', 'native-project');
    const second = await initialize(f, 'Another real empty project', 'native-project-two');
    let client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
    const initial = agentCatalogSchema.parse(await client.agentContexts.catalog());
    assert.equal(initial.workspaces.find(workspace => workspace.id === empty.id)?.projects.length, 0);
    const group = initial.workspaces.find(workspace => workspace.id === f.workspaceId)!;
    assert.deepEqual(group.projects.map(entry => entry.id).sort(), [project.record.id, second.record.id].sort());
    assert.deepEqual(group.fileArea, { path: join(f.root, '.pmv3', 'workspaces', f.workspaceId, 'workspace'), status: 'available', revision: 0, source: 'default', canManage: true, reason: 'initializes_on_first_use' });
    await assert.rejects(lstat(join(f.root, '.pmv3')), { code: 'ENOENT' });
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_file_areas')).rows[0].n, 0);
    assert.deepEqual(group.projects.find(entry => entry.id === project.record.id)?.fileArea, {
      path: project.location.path, status: 'available', revision: 0, source: 'project_location', canManage: true,
    });
    const nativeScope = { workspaceId: f.workspaceId, projectId: project.record.id };
    assert.deepEqual(await client.agentContexts.resolve(nativeScope), {
      scope: nativeScope, workspaceName: 'Local project acceptance', projectName: 'A real empty project', path: project.location.path,
    });
    const defaultArea = await client.agentContexts.resolve({ workspaceId: f.workspaceId, projectId: null });
    assert.equal(defaultArea.path, group.fileArea.path);
    assert.ok((await lstat(defaultArea.path)).isDirectory());
    const coreFile = join(project.location.path!, '.pm/core/projects', `${project.record.id}.md`);
    const before = await readFile(coreFile);
    const existing = join(f.parents[1], 'workspace-area'); await mkdir(existing);
    await writeFile(join(existing, 'user-file.txt'), 'Do not modify');
    const workspaceArea = await client.agentContexts.saveWorkspace(f.workspaceId, { directory: { mode: 'existing', path: existing }, expectedRevision: 1 });
    assert.deepEqual(workspaceArea.fileArea, { path: existing, status: 'available', source: 'explicit', revision: 2, canManage: true });
    const projectArea = await client.agentContexts.saveProject(f.workspaceId, project.record.id, {
      directory: { mode: 'new', parentPath: f.parents[1], folderName: 'project-agent-area' }, expectedRevision: 0,
    });
    assert.equal(projectArea.fileArea.path, join(f.parents[1], 'project-agent-area'));
    assert.equal(projectArea.fileArea.revision, 1); assert.equal(projectArea.fileArea.source, 'explicit');
    assert.ok((await lstat(projectArea.fileArea.path!)).isDirectory());
    await assert.rejects(lstat(join(projectArea.fileArea.path!, '.pm')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(coreFile), before);
    assert.equal(await readFile(join(existing, 'user-file.txt'), 'utf8'), 'Do not modify');
    const staleProject = await f.request<Failure>(`/api/v1/workspaces/${f.workspaceId}/projects/${project.record.id}/agent-file-area`, {
      method: 'PUT', body: { directory: { mode: 'existing', path: existing }, expectedRevision: 0 },
    });
    assert.equal(staleProject.status, 409); assert.equal(staleProject.body.error.details?.currentRevision, 1);
    await f.restartApi();
    client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
    const restored = await client.agentContexts.catalog();
    const restoredGroup = restored.workspaces.find(workspace => workspace.id === f.workspaceId)!;
    assert.deepEqual(restoredGroup.fileArea, workspaceArea.fileArea);
    assert.deepEqual(restoredGroup.projects.find(entry => entry.id === project.record.id)?.fileArea, projectArea.fileArea);
    assert.equal((await client.agentContexts.resolve({ workspaceId: f.workspaceId, projectId: null })).path, existing);
    assert.equal((await client.agentContexts.resolve(nativeScope)).path, projectArea.fileArea.path);
    assert.equal(restoredGroup.projects.find(entry => entry.id === second.record.id)?.fileArea.source, 'project_location');
    assert.deepEqual(await readFile(coreFile), before, 'Configuring an execution location never changes project authority');
  });

  it('serializes revision CAS and rejects stale writes before creating a directory', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const endpoint = `/api/v1/workspaces/${f.workspaceId}/agent-file-area`;
    const save = (path: string, expectedRevision: number) => f.request<{ fileArea: AgentFileArea } | Failure>(endpoint, { method: 'PUT', body: { directory: { mode: 'existing', path }, expectedRevision } });
    assert.equal((await save(f.parents[0], 0)).status, 200);
    const raced = await Promise.all([save(f.parents[0], 1), save(f.parents[1], 1)]);
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
    const winner = raced.find(result => result.status === 200)!;
    if (!('fileArea' in winner.body)) throw new Error('No saved file area');
    assert.equal(winner.body.fileArea.revision, 2);
    const lost = raced.find(result => result.status === 409)!;
    if (!('error' in lost.body)) throw new Error('No conflict');
    assert.equal(lost.body.error.code, 'agent_file_area_revision_conflict');
    assert.equal(lost.body.error.details?.currentRevision, 2);
    const candidate = join(f.parents[0], 'must-not-be-created');
    const stale = await f.request<Failure>(endpoint, { method: 'PUT', body: { directory: { mode: 'new', parentPath: f.parents[0], folderName: 'must-not-be-created' }, expectedRevision: 1 } });
    assert.equal(stale.status, 409);
    await assert.rejects(lstat(candidate), { code: 'ENOENT' });
    const catalog = await f.request<AgentCatalog>('/api/v1/agent-contexts');
    assert.deepEqual(catalog.body.workspaces[0]?.fileArea, winner.body.fileArea);
    assert.equal((await f.pool.query('SELECT revision FROM agent_file_areas WHERE workspace_id=$1', [f.workspaceId])).rows[0].revision, 2);
  });

  it('filters memberships and projects, redacts paths, rejects hidden resolve, and preserves original management and Origin checks', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const a = await initialize(f, 'Allowed project', 'allowed');
    const b = await initialize(f, 'Hidden project', 'hidden');
    const reader = await f.member('Restricted reader'), outsider = await f.member('Outsider'), manager = await f.member('Read-only local manager');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] });
    await f.command('SetWorkspaceMember', { userId: manager.user.id, capabilities: ['domain.read', 'access.manage'], projectIds: null });
    const readerCatalog = await f.request<AgentCatalog>('/api/v1/agent-contexts', { cookie: reader.cookie });
    assert.equal(readerCatalog.status, 200);
    assert.deepEqual(readerCatalog.body.workspaces[0]?.projects.map(project => project.id), [a.record.id]);
    assert.equal(readerCatalog.body.workspaces[0]?.projects[0]?.fileArea.path, null);
    assert.equal(readerCatalog.body.workspaces[0]?.projects[0]?.fileArea.status, 'unavailable');
    assert.equal(readerCatalog.body.workspaces[0]?.projects[0]?.fileArea.canManage, false);
    assert.equal(JSON.stringify(readerCatalog.body).includes(f.parents[0]), false);
    assert.equal((await f.request<AgentCatalog>('/api/v1/agent-contexts', { cookie: outsider.cookie })).body.workspaces.length, 0);
    const scope: AgentScope = { workspaceId: f.workspaceId, projectId: a.record.id };
    const hiddenPath = await f.request<Failure>('/api/v1/agent-contexts/resolve', { method: 'POST', cookie: reader.cookie, body: scope });
    assert.equal(hiddenPath.status, 403); assert.equal(hiddenPath.body.error.code, 'agent_file_area_path_not_visible');
    assert.equal(JSON.stringify(hiddenPath.body).includes(f.parents[0]), false);
    const deniedProject = await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', cookie: reader.cookie, body: { ...scope, projectId: b.record.id } });
    assert.equal(deniedProject.status, 404);
    const visibleManager = await f.request<AgentCatalog>('/api/v1/agent-contexts', { cookie: manager.cookie });
    assert.equal(visibleManager.body.workspaces[0]?.projects[0]?.fileArea.canManage, false);
    assert.ok(visibleManager.body.workspaces[0]?.projects[0]?.fileArea.path);
    assert.equal((await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', cookie: manager.cookie, body: scope })).status, 200);
    const endpoint = `/api/v1/workspaces/${f.workspaceId}/projects/${a.record.id}/agent-file-area`;
    const input = { directory: { mode: 'existing', path: f.parents[0] }, expectedRevision: 0 };
    for (const cookie of [reader.cookie, manager.cookie, outsider.cookie]) assert.ok((await f.request(endpoint, { method: 'PUT', cookie, body: input })).status >= 400);
    assert.equal((await f.request('/api/v1/agent-contexts', { cookie: '' })).status, 401);
    assert.equal((await f.request(endpoint, { method: 'PUT', headers: { origin: 'https://hostile.example' }, body: input })).status, 403);
    assert.equal((await f.request(endpoint, { method: 'PUT', headers: { 'sec-fetch-site': 'cross-site' }, body: input })).status, 403);
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, reader.user.id]);
    assert.equal((await f.request<AgentCatalog>('/api/v1/agent-contexts', { cookie: reader.cookie })).body.workspaces.length, 0);
    assert.equal((await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', cookie: reader.cookie, body: scope })).status, 404);
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_file_areas')).rows[0].n, 0);
  });

  it('refuses missing, replaced, symlinked, untrusted and invalid core locations without recreating disks or falling back', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const endpoint = `/api/v1/workspaces/${f.workspaceId}/agent-file-area`, scope = { workspaceId: f.workspaceId, projectId: null };
    const root = join(f.parents[1], 'workspace-agent-area'); await mkdir(root);
    assert.equal((await f.request(endpoint, { method: 'PUT', body: { directory: { mode: 'existing', path: root }, expectedRevision: 0 } })).status, 200);
    await rename(root, root + '-original');
    const missing = await f.request<AgentCatalog>('/api/v1/agent-contexts');
    assert.equal(missing.body.workspaces[0]?.fileArea.status, 'unavailable');
    assert.equal(missing.body.workspaces[0]?.fileArea.path, root);
    const missingResolve = await f.request<Failure>('/api/v1/agent-contexts/resolve', { method: 'POST', body: scope });
    assert.equal(missingResolve.status, 409); assert.equal(missingResolve.body.error.code, 'agent_file_area_unavailable');
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    await f.restartApi();
    assert.equal((await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', body: scope })).status, 409);
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    await mkdir(root);
    const replaced = await f.request<AgentCatalog>('/api/v1/agent-contexts');
    assert.equal(replaced.body.workspaces[0]?.fileArea.reason, 'directory_identity_changed');
    const symlinkPath = join(f.parents[0], 'link'); await symlink(root, symlinkPath, 'dir');
    for (const directory of [
      { mode: 'existing', path: symlinkPath }, { mode: 'existing', path: f.root },
      { mode: 'existing', path: join(f.parents[0], 'missing') },
      { mode: 'new', parentPath: f.parents[0], folderName: '../escape' },
    ]) assert.ok((await f.request(endpoint, { method: 'PUT', body: { directory, expectedRevision: 1 } })).status >= 400);
    assert.equal((await f.request<AgentCatalog>('/api/v1/agent-contexts')).body.workspaces[0]?.fileArea.revision, 1);
    const project = await initialize(f, 'Native identity check', 'native-identity');
    const projectScope = { workspaceId: f.workspaceId, projectId: project.record.id };
    await writeFile(join(project.location.path!, '.pm/project.json'), '{}');
    const invalid = await f.request<AgentCatalog>('/api/v1/agent-contexts');
    assert.equal(invalid.body.workspaces[0]?.projects.find(entry => entry.id === project.record.id)?.fileArea.status, 'unavailable');
    const nativeResolve = await f.request<Failure>('/api/v1/agent-contexts/resolve', { method: 'POST', body: projectScope });
    assert.equal(nativeResolve.status, 409); assert.equal(nativeResolve.body.error.code, 'agent_file_area_unavailable');
    const absent = await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', body: { ...projectScope, projectId: 'PRJ-999999' } });
    assert.equal(absent.status, 404, 'Saved preference or guessed ID cannot manufacture a core project');
  });

  it('isolates default workspace/project scopes and preserves assignments across revisioned settings and restart', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ localProjectsEnabled: false, signal: t.signal }); t.after(() => f.close());
    const project = await f.command('CreateProject', { name: 'No native mount', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const second = await f.command('CreateProject', { name: 'Future assignment', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    await f.restartApi(true);
    let client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
    const endpoint = `/api/v1/workspaces/${f.workspaceId}/agent-storage-settings`;
    const settings = await client.agentContexts.storageSettings(f.workspaceId);
    assert.deepEqual(settings, { defaultRoot: join(f.root, '.pmv3'), effectiveRoot: join(f.root, '.pmv3'), revision: 0, canManage: true });
    const catalog = await client.agentContexts.catalog();
    assert.equal(catalog.workspaces[0]?.projects.find(p => p.id === project.id)?.fileArea.source, 'default');
    await assert.rejects(lstat(join(f.root, '.pmv3')), { code: 'ENOENT' });
    assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_storage_settings')).rows[0].n, 0);
    const workspace = await client.agentContexts.resolve({ workspaceId: f.workspaceId, projectId: null });
    const assigned = await client.agentContexts.resolve({ workspaceId: f.workspaceId, projectId: project.id });
    assert.equal(workspace.path, join(f.root, '.pmv3', 'workspaces', f.workspaceId, 'workspace'));
    assert.equal(assigned.path, join(f.root, '.pmv3', 'workspaces', f.workspaceId, 'projects', project.id));
    await writeFile(join(assigned.path, 'keep.txt'), 'preserve existing files');
    const saved = await client.agentContexts.saveStorageSettings(f.workspaceId, { directory: { mode: 'new', parentPath: f.parents[0], folderName: 'new-chat-default' }, expectedRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.equal(saved.effectiveRoot, join(f.parents[0], 'new-chat-default'));
    const stale = await f.request<Failure>(endpoint, { method: 'PUT', body: { directory: { mode: 'new', parentPath: f.parents[0], folderName: 'stale-root' }, expectedRevision: 0 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'agent_storage_settings_revision_conflict');
    await assert.rejects(lstat(join(f.parents[0], 'stale-root')), { code: 'ENOENT' });
    const future = await client.agentContexts.resolve({ workspaceId: f.workspaceId, projectId: second.id });
    assert.equal(future.path, join(saved.effectiveRoot!, 'workspaces', f.workspaceId, 'projects', second.id));
    await f.restartApi();
    client = new ProjectManagementClient({ baseUrl: f.origin, auth: { type: 'cookie', credentials: 'include', cookie: () => f.ownerCookie } });
    assert.equal((await client.agentContexts.resolve({ workspaceId: f.workspaceId, projectId: project.id })).path, assigned.path);
    assert.equal(await readFile(join(assigned.path, 'keep.txt'), 'utf8'), 'preserve existing files');
    const persisted = await client.agentContexts.catalog();
    assert.equal(persisted.workspaces[0]?.projects.find(p => p.id === project.id)?.fileArea.source, 'default');
    assert.equal(persisted.workspaces[0]?.projects.find(p => p.id === project.id)?.fileArea.revision, 1);
    await rename(assigned.path, assigned.path + '-original');
    assert.equal((await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', body: { workspaceId: f.workspaceId, projectId: project.id } })).status, 409);
    await assert.rejects(lstat(assigned.path), { code: 'ENOENT' });
  });

  it('guards settings permissions, CAS races, trusted roots and traversal without filesystem side effects', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const reader = await f.member('Settings reader'), manager = await f.member('Read-only manager');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: null });
    await f.command('SetWorkspaceMember', { userId: manager.user.id, capabilities: ['domain.read', 'access.manage'], projectIds: null });
    const endpoint = `/api/v1/workspaces/${f.workspaceId}/agent-storage-settings`;
    const hidden = await f.request<AgentStorageSettings>(endpoint, { cookie: reader.cookie });
    assert.deepEqual(hidden.body, { defaultRoot: null, effectiveRoot: null, revision: 0, canManage: false });
    const input = { directory: { mode: 'existing', path: f.parents[0] }, expectedRevision: 0 };
    for (const cookie of [reader.cookie, manager.cookie]) assert.equal((await f.request(endpoint, { method: 'PUT', cookie, body: input })).status, 403);
    assert.equal((await f.request('/api/v1/agent-contexts/resolve', { method: 'POST', cookie: manager.cookie, body: { workspaceId: f.workspaceId, projectId: null } })).status, 409);
    await assert.rejects(lstat(join(f.root, '.pmv3')), { code: 'ENOENT' });
    const link = join(f.parents[0], 'linked-default'); await symlink(f.parents[1], link, 'dir');
    for (const directory of [
      { mode: 'existing', path: f.root }, { mode: 'existing', path: link },
      { mode: 'existing', path: '/etc' }, { mode: 'new', parentPath: f.parents[0], folderName: '../escaped' },
    ]) assert.ok((await f.request(endpoint, { method: 'PUT', body: { directory, expectedRevision: 0 } })).status >= 400);
    const raced = await Promise.all(f.parents.map(path => f.request(endpoint, { method: 'PUT', body: { directory: { mode: 'existing', path }, expectedRevision: 0 } })));
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
    assert.equal((await f.request<AgentStorageSettings>(endpoint)).body.revision, 1);
  });
});
