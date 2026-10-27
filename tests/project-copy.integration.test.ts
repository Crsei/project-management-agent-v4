import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import type { ProjectCopyResult } from '../packages/pm-core/project-copy.ts';
import { createLocalProjectFixture, type LocalProjectFixture } from './local-project-fixture.ts';

async function project(f: LocalProjectFixture, name: string, folderName: string): Promise<Entity> {
  return f.command<Entity>('CreateProject', { name, goal: 'Substantive goal', ownerId: f.owner.id, completionCriteria: ['Human definition'], description: 'Original project prose',
    localDirectory: { mode: 'new', parentPath: f.parents[0], folderName } });
}
function copyCommand(f: LocalProjectFixture, source: Entity, folderName: string): Command {
  return { commandId: randomUUID(), commandType: 'DuplicateProject', targetId: source.id, projectId: source.id,
    expectedVersions: { [source.id]: source.version }, payload: { name: 'Independent copy', includeTasks: true,
      localDirectory: { mode: 'new', parentPath: f.parents[1], folderName } } };
}

// A real random-schema PostgreSQL/API/filesystem acceptance suite; no fixture fallback or silent skips.
// Run explicitly with TEST_DATABASE_URL, after generating the shared client/contracts.
describe('project copy and guarded deletion', { timeout: 600_000, concurrency: 1 }, () => {
  it('copies native content/tasks with fresh IDs and no grants/history/code; restart and same key return the original mapping', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const source = await project(f, 'Source project', 'source');
    await writeFile(join(f.parents[0], 'source', 'user-code.ts'), 'User-owned code\n');
    const first = await f.command<Entity>('CreateWorkItem', { title: 'Parent', description: 'Substantive task', acceptanceCriteria: [] }, { projectId: source.id });
    const second = await f.command<Entity>('CreateWorkItem', { title: 'Child', description: `See [[${first.id}|parent]]`, acceptanceCriteria: [], parentId: first.id }, { projectId: source.id });
    const dependency = await f.command<Entity>('AddDependency', { prerequisiteId: first.id }, { targetId: second.id, projectId: source.id, expectedVersions: { [second.id]: second.version } });
    const sourceRaw = (await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${source.id}`)).body.raw;
    const input = copyCommand(f, source, 'copy');
    const response = await f.send(input); assert.equal(response.status, 200, JSON.stringify(response.body));
    const copied = response.body.result as ProjectCopyResult;
    assert.notEqual(copied.id, source.id); assert.equal(copied.copiedTaskCount, 2); assert.equal(copied.projectId, copied.id);
    const child = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${copied.taskIdMap[dependency.id]}`);
    assert.equal(child.body.entity.parent, copied.taskIdMap[first.id]); assert.deepEqual(child.body.entity.blocked_by, [copied.taskIdMap[first.id]]);
    assert.deepEqual(child.body.entity.links, [copied.taskIdMap[first.id]]); assert.equal(child.body.entity.project, copied.id);
    assert.equal((await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${source.id}`)).body.raw, sourceRaw);
    await assert.rejects(readFile(join(f.parents[1], 'copy', 'user-code.ts')), { code: 'ENOENT' });
    assert.equal((await f.pool.query('SELECT 1 FROM entities WHERE workspace_id=$1 AND project_id=$2', [f.workspaceId, copied.id])).rowCount, 0);
    await f.restartApi();
    assert.deepEqual((await f.send(input)).body.result, copied);
    assert.equal((await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${child.body.id}`)).body.revision, child.body.revision);
    assert.equal((await f.send({ ...input, payload: { ...input.payload, name: 'Different request' } })).status, 409);
    const stale = copyCommand(f, source, 'stale'); stale.expectedVersions = { [source.id]: source.version + 1 };
    assert.equal((await f.send(stale)).body.error?.code, 'version_conflict');
    const reader = await f.member('Source-only editor');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [source.id] });
    assert.equal((await f.send(copyCommand(f, source, 'denied'), reader.cookie)).status, 403);
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/entities/${copied.id}`, { cookie: reader.cookie })).status, 404);
  });

  it('a binding failure retains the original command/map; GET does not write and explicit recovery after restart produces no second destination', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    const source = await project(f, 'Recovery source', 'source');
    await f.command('CreateWorkItem', { title: 'Frozen task', description: 'Frozen content', acceptanceCriteria: [] }, { projectId: source.id });
    const input = copyCommand(f, source, 'recover');
    await f.pool.query(`CREATE FUNCTION reject_copy_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deterministic copy binding fault'; END $$;
      CREATE TRIGGER reject_copy_binding BEFORE INSERT ON project_blob_stores FOR EACH ROW EXECUTE FUNCTION reject_copy_binding()`);
    const failed = await f.send(input); assert.equal(failed.status, 503);
    const marker = JSON.parse(await readFile(join(f.parents[1], 'recover', '.pm/project.json'), 'utf8')) as { projectId: string };
    const before = (await readdir(join(f.parents[1], 'recover', '.pm/core/work-items'))).sort();
    const receipts = `/api/v1/workspaces/${f.workspaceId}/commands/${input.commandId}`;
    assert.equal((await f.request(receipts)).status, 404, 'unknown is not falsely committed');
    assert.deepEqual((await readdir(join(f.parents[1], 'recover', '.pm/core/work-items'))).sort(), before);
    assert.equal((await f.send(input)).body.error?.code, 'command_outcome_unknown');
    const other = await f.member('Other actor');
    assert.ok([403, 404].includes((await f.request(`${receipts}/recover`, { method: 'POST', body: {}, cookie: other.cookie })).status));
    assert.equal((await f.request(`${receipts}/recover`, { method: 'POST', body: { payload: { name: 'New input forbidden' } } })).status, 400);
    await f.pool.query('DROP TRIGGER reject_copy_binding ON project_blob_stores; DROP FUNCTION reject_copy_binding()');
    await f.restartApi();
    const recovered = await f.request<CommandReceipt>(`${receipts}/recover`, { method: 'POST', body: {} });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body)); assert.equal(recovered.body.status, 'committed');
    const copied = recovered.body.result as ProjectCopyResult;
    assert.equal(copied.id, marker.projectId); assert.deepEqual(Object.values(copied.taskIdMap).map(id => `${id}.md`).sort(), before);
    assert.deepEqual((await f.request<CommandReceipt>(`${receipts}/recover`, { method: 'POST', body: {} })).body.result, copied);
    assert.deepEqual((await f.send(input)).body.result, copied);
    assert.equal((await readdir(f.parents[1])).filter(name => name === 'recover').length, 1);
    assert.equal((await f.pool.query('SELECT 1 FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.workspaceId, input.commandId])).rowCount, copied.copiedTaskCount + 1);
  });

  it('keeps artifacts and immutable business history, enforces both delete transports, but deletes an unreferenced archived project without deleting its code directory', async t => {
    const f = await createLocalProjectFixture(); t.after(() => f.close());
    let retained = await project(f, 'History retained', 'history');
    const upload = await f.command<{ upload: Entity }>('StageUpload', { contentBase64: Buffer.from('Immutable artifact').toString('base64'), fileName: 'history.txt', mediaType: 'text/plain' }, { projectId: retained.id });
    await f.command('RegisterArtifact', { title: 'Historical artifact', kind: 'document', uploadId: upload.upload.id }, { projectId: retained.id, expectedVersions: { [upload.upload.id]: upload.upload.version } });
    retained = await f.command<Entity>('ArchiveObject', { kind: 'project', reason: 'Safe archive' }, { targetId: retained.id, projectId: retained.id, expectedVersions: { [retained.id]: retained.version } });
    const directory = await f.request<{ items: Entity[] }>(`/api/v1/workspaces/${f.workspaceId}/entities?kind=project`);
    assert.equal(directory.status, 200);
    assert.equal(directory.body.items.find(item => item.id === retained.id)?.data.archived, true, 'The PM project directory keeps archived projects reachable for restore and guarded deletion');
    const unsafe = await f.send({ commandId: randomUUID(), commandType: 'DeleteObject', targetId: retained.id, projectId: retained.id, expectedVersions: { [retained.id]: retained.version }, payload: { kind: 'project' } });
    assert.equal(unsafe.body.error?.code, 'DELETE_REFERENCED');
    const raw = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${retained.id}`);
    const unsafeNative = await f.request<{ error: { code: string } }>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${retained.id}`, { method: 'DELETE', body: { revision: raw.body.revision } });
    assert.equal(unsafeNative.body.error.code, 'DELETE_REFERENCED');
    assert.ok((await f.pool.query('SELECT 1 FROM entities WHERE workspace_id=$1 AND project_id=$2', [f.workspaceId, retained.id])).rowCount! > 0);
    let safe = await project(f, 'Truly unreferenced', 'safe');
    await writeFile(join(f.parents[0], 'safe', 'user-code.ts'), 'Must survive permanent PM deletion\n');
    safe = await f.command<Entity>('ArchiveObject', { kind: 'project', reason: 'Allow irreversible delete' }, { targetId: safe.id, projectId: safe.id, expectedVersions: { [safe.id]: safe.version } });
    const deleted = await f.send({ commandId: randomUUID(), commandType: 'DeleteObject', targetId: safe.id, projectId: safe.id, expectedVersions: { [safe.id]: safe.version }, payload: { kind: 'project' } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/core/files/${safe.id}`)).status, 404);
    assert.equal(await readFile(join(f.parents[0], 'safe', 'user-code.ts'), 'utf8'), 'Must survive permanent PM deletion\n');
    assert.ok((await f.pool.query('SELECT 1 FROM project_audit WHERE workspace_id=$1 AND project_id=$2', [f.workspaceId, safe.id])).rowCount! > 0, 'immutable audit survives its tombstoned project');
  });
});
