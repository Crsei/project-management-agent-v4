import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import type { Membership } from '../packages/application/src/access.ts';
import { patchMarkdown } from '../packages/pm-markdown/index.ts';
import type { FileRecord, ProtocolConfiguration } from '../packages/pm-schema/index.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture, type DashboardResponse } from './dashboard-fixture.ts';
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';

describe('task creation rules: real HTTP, SQL membership and authoritative Markdown', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let f: DashboardFixture;
  before(async () => { f = await createDashboardFixture(); });
  after(async () => { await f?.close(); });
  const base = () => `/api/v1/workspaces/${f.workspaceId}`;
  async function project(name: string): Promise<Entity> {
    return f.command('CreateProject', { name, goal: '', ownerId: f.owner.id, completionCriteria: [] });
  }
  async function file(id: string): Promise<FileRecord> {
    const response = await f.request<FileRecord>(`${base()}/core/files/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function patch(id: string, changes: Record<string, unknown>): Promise<FileRecord> {
    const current = await file(id);
    const response = await f.request<FileRecord>(`${base()}/core/entities/${id}`, { method: 'PATCH', body: { changes, revision: current.revision } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function grant(userId: string, projectIds: string[] | null, capabilities = ['domain.read', 'planning.edit'], previous?: Membership): Promise<Membership> {
    return f.command('SetWorkspaceMember', { userId, projectIds, capabilities }, previous ? { extra: { expectedVersions: { [userId]: previous.version } } } : {});
  }
  async function native(input: Record<string, unknown>, cookie?: string) {
    return f.request<FileRecord>(`${base()}/core/entities`, { method: 'POST', body: input, headers: { 'idempotency-key': randomUUID() }, ...(cookie ? { cookie } : {}) });
  }

  it('rejects a stale second command after both writers wait on the same workspace lock', async () => {
    const p = await project('Concurrent task edits');
    const task = await f.command<Entity>('CreateWorkItem', { title: 'Original title', description: '', acceptanceCriteria: [] }, { extra: { projectId: p.id } });
    const original = await file(task.id);
    const gate = await f.pool.connect();
    const requests: Promise<DashboardResponse<CommandReceipt>>[] = [];
    try {
      await gate.query('BEGIN');
      await lockWorkspace(gate, f.workspaceId);
      const pid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      for (const title of ['First proposed title', 'Second proposed title']) requests.push(f.send({
        commandId: randomUUID(), commandType: 'UpdateWorkItemContent', targetId: task.id, projectId: p.id,
        expectedVersions: { [task.id]: task.version }, payload: { title, description: '', acceptanceCriteria: [] },
      }));
      const deadline = Date.now() + 10_000;
      let blocked = 0;
      while (blocked < 2 && Date.now() < deadline) {
        blocked = Number((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0]!.count);
        if (blocked < 2) await delay(10);
      }
      assert.equal(blocked, 2, 'Both requests must reach the actual SQL serialization boundary');
    } finally {
      await gate.query('ROLLBACK');
      gate.release();
    }
    const results = await Promise.all(requests);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const committed = results.find(result => result.body.status === 'committed')!;
    const rejected = results.find(result => result.body.status === 'rejected')!;
    assert.equal(rejected.body.error?.code, 'version_conflict');
    const current = await file(task.id);
    assert.equal(current.entity.title, (committed.body.result as Entity).data.title);
    const audit = (await f.pool.query<{ before_version: string; after_version: string }>('SELECT before_version,after_version FROM project_audit WHERE command_id=$1', [committed.body.commandId])).rows[0]!;
    assert.equal(audit.before_version, original.revision);
    assert.equal(audit.after_version, current.revision);
  });

  it('persists every explicit command field in the first Markdown result with one ID, one file and one command audit action', async () => {
    const p = await project('Full command fields');
    const parent = await f.command<Entity>('CreateWorkItem', { title: 'Parent', description: '', acceptanceCriteria: [] }, { extra: { projectId: p.id } });
    const commandId = randomUUID();
    const input = { commandId, commandType: 'CreateWorkItem', projectId: p.id, payload: {
      title: 'One complete creation', description: 'Preserved **Markdown** and [[DOC-99]].', acceptanceCriteria: [{ id: randomUUID(), text: 'The first result contains all fields' }],
      assigneeId: f.owner.id, priority: 'normal', startDate: '2028-02-29', dueDate: '2028-03-01', labels: ['unicode-标签', 'release'], kind: 'subtask', parentId: parent.id, estimatePoints: 0, location: '  Room: East #12  ',
    } };
    const response = await f.send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const created = response.body.result as Entity;
    const saved = await file(created.id);
    assert.deepEqual({ project: saved.entity.project, kind: saved.entity.kind, parent: saved.entity.parent, assignee: saved.entity.assignee, priority: saved.entity.priority, start: saved.entity['x-pm-start'], due: saved.entity.due, estimate: saved.entity['x-pm-estimate'], location: saved.entity['x-pm-location'], labels: saved.entity.labels }, {
      project: p.id, kind: 'subtask', parent: parent.id, assignee: f.owner.id, priority: 'medium', start: '2028-02-29', due: '2028-03-01', estimate: 0, location: 'Room: East #12', labels: ['unicode-标签', 'release'],
    });
    assert.equal(created.data.parentId, parent.id);
    assert.equal(created.data.kind, 'subtask');
    assert.equal(created.data.location, 'Room: East #12');
    assert.equal(created.data.startDate, '2028-02-29');
    assert.equal(created.data.estimatePoints, 0);
    assert.ok(saved.raw.includes('Preserved **Markdown** and [[DOC-99]].'));
    assert.ok(saved.raw.includes('- [ ] The first result contains all fields'));
    assert.equal(await readFile(join(f.coreRoot, f.workspaceId, saved.path), 'utf8'), saved.raw);
    assert.equal((await readdir(join(f.coreRoot, f.workspaceId, 'work-items'))).filter(name => name === `${created.id}.md`).length, 1);
    const repeated = await f.send(input);
    assert.deepEqual(repeated.body, response.body);
    assert.equal((await file(created.id)).revision, saved.revision);
    assert.equal((await f.pool.query("SELECT count(*)::text AS count FROM entities WHERE workspace_id=$1 AND kind='work_item'", [f.workspaceId])).rows[0].count, '0');
    assert.equal((await f.pool.query('SELECT count(*)::text AS count FROM project_audit WHERE workspace_id=$1 AND command_id=$2', [f.workspaceId, commandId])).rows[0].count, '1');
  });

  it('native creation retains labels, custom metadata, parent and Markdown without command receipts or follow-up patches', async () => {
    const p = await project('Native full fields');
    const parent = await f.command<Entity>('CreateWorkItem', { title: 'Native parent', description: '', acceptanceCriteria: [] }, { extra: { projectId: p.id } });
    const receiptsBefore = await f.pool.query('SELECT count(*)::text AS count FROM command_receipts WHERE workspace_id=$1', [f.workspaceId]);
    const configuration = await f.request<{ config: ProtocolConfiguration; revision: string }>(`${base()}/core/config`);
    const config = structuredClone(configuration.body.config);
    config.custom_fields.push({ name: 'x-creation-stage', label: 'Creation stage', type: 'select', entities: ['work_item', 'document'], options: ['review', 'ship'], default: 'review' });
    const savedConfig = await f.request(`${base()}/core/config`, { method: 'PUT', body: { config, revision: configuration.body.revision } });
    assert.equal(savedConfig.status, 200, JSON.stringify(savedConfig.body));
    const response = await native({ entity: 'work_item', project: p.id, title: 'Native child', kind: 'subtask', parent: parent.id, labels: ['native'], assignee: f.owner.id, priority: 'high', 'x-pm-start': '2028-02-29', due: '2028-02-29', 'x-pm-estimate': 2.5, 'x-pm-location': '  East wing  ', 'x-creation-detail': { nested: ['retained'] }, 'x-creation-stage': 'ship', body: 'A code block stays Markdown.\n\n```ts\nconst retained = true;\n```' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const saved = await file(response.body.id);
    assert.equal(saved.revision, response.body.revision);
    assert.deepEqual(saved.entity['x-creation-detail'], { nested: ['retained'] });
    assert.equal(saved.entity['x-creation-stage'], 'ship');
    assert.deepEqual(saved.entity.labels, ['native']);
    assert.equal(saved.entity.parent, parent.id);
    assert.equal(saved.entity['x-pm-location'], 'East wing');
    assert.ok(saved.entity.body.includes('const retained = true;'));
    assert.equal((await f.pool.query('SELECT count(*)::text AS count FROM command_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0].count, receiptsBefore.rows[0].count);
    const changed = await patch(saved.id, { 'x-pm-location': '', 'x-pm-start': null, labels: [] });
    assert.equal(changed.entity['x-pm-location'], undefined);
    assert.equal(changed.entity['x-pm-start'], undefined);
    assert.equal(changed.entity.parent, parent.id);
    assert.deepEqual(changed.entity['x-creation-detail'], { nested: ['retained'] });
    assert.equal(changed.entity.body, saved.entity.body);
    assert.equal(changed.entity['x-creation-stage'], 'ship');
    const document = await native({ entity: 'document', project: p.id, title: 'Generic configured document', document_kind: 'design', 'x-creation-stage': 'ship', body: 'Generic creation still preserves **Markdown**.' });
    assert.equal(document.status, 200, JSON.stringify(document.body));
    assert.equal(document.body.entity.entity, 'document');
    assert.equal(document.body.entity['x-creation-stage'], 'ship');
    assert.ok(document.body.raw.includes('Generic creation still preserves **Markdown**.'));
  });

  it('rejects assignment bypasses from native create, properties, source and command metadata while preserving historical assignment', async () => {
    const p = await project('Assignment safety');
    const other = await project('Other assignment scope');
    const member = await f.member('Initially assignable');
    const wrong = await f.member('Wrong project');
    const membership = await grant(member.user.id, [p.id]);
    await grant(wrong.user.id, [other.id]);
    const response = await native({ entity: 'work_item', project: p.id, title: 'Retain history', assignee: member.user.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const task = response.body;
    await f.command('RevokeWorkspaceMember', { userId: member.user.id }, { extra: { expectedVersions: { [member.user.id]: membership.version } } });
    const unrelated = await patch(task.id, { priority: 'urgent' });
    assert.equal(unrelated.entity.assignee, member.user.id);
    const sourceEdit = await f.request<FileRecord>(`${base()}/core/files/${task.id}`, { method: 'PUT', body: { raw: patchMarkdown(unrelated.raw, { title: 'Still historical' }), revision: unrelated.revision } });
    assert.equal(sourceEdit.status, 200, JSON.stringify(sourceEdit.body));
    const entity = await f.request<Entity>(`${base()}/entities/${task.id}`);
    const commandEdit = await f.command<Entity>('UpdateWorkItemMetadata', { priority: 'high' }, { extra: { targetId: task.id, projectId: p.id, expectedVersions: { [task.id]: entity.body.version } } });
    assert.equal(commandEdit.data.assigneeId, member.user.id);
    for (const assignee of [wrong.user.id, member.user.id, randomUUID()]) {
      assert.equal((await native({ entity: 'work_item', project: p.id, title: 'Rejected assignment', assignee })).status, 409);
    }
    const current = await file(task.id);
    const rejectedPatch = await f.request(`${base()}/core/entities/${task.id}`, { method: 'PATCH', body: { changes: { assignee: wrong.user.id }, revision: current.revision } });
    assert.equal(rejectedPatch.status, 409);
    const rejectedSource = await f.request(`${base()}/core/files/${task.id}`, { method: 'PUT', body: { raw: patchMarkdown(current.raw, { assignee: wrong.user.id }), revision: current.revision } });
    assert.equal(rejectedSource.status, 409);
    const rejectedCommand = await f.send({ commandId: randomUUID(), commandType: 'UpdateWorkItemMetadata', targetId: task.id, projectId: p.id, expectedVersions: { [task.id]: commandEdit.version }, payload: { assigneeId: wrong.user.id } });
    assert.equal(rejectedCommand.body.error?.code, 'workspace_member_required');
    const afterRejected = await file(task.id);
    assert.equal(afterRejected.entity.assignee, member.user.id);
    assert.equal(afterRejected.revision, current.revision);
  });

  it('does not permit native/source field writes to evade project, scope, protected metadata or parent restrictions', async () => {
    const p = await project('Project policy');
    const hidden = await project('Hidden parent project');
    const parent = await f.command<Entity>('CreateWorkItem', { title: 'Hidden parent', description: '', acceptanceCriteria: [] }, { extra: { projectId: hidden.id } });
    const task = await native({ entity: 'work_item', project: p.id, title: 'Editable task' });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const member = await f.member('Scoped editor');
    await grant(member.user.id, [p.id]);
    assert.equal((await native({ entity: 'work_item', project: hidden.id, title: 'Invisible project' }, member.cookie)).status, 404);
    const invalidParent = await native({ entity: 'work_item', project: p.id, title: 'Cross-project child', kind: 'subtask', parent: parent.id });
    assert.equal(invalidParent.status, 422);
    assert.equal((await native({ entity: 'work_item', project: p.id, title: 'Forged creator', 'x-pm-created-by': f.owner.id })).status, 400);
    const scopedReference = await f.request(`${base()}/core/entities/${task.body.id}`, { method: 'PATCH', cookie: member.cookie, body: { changes: { related_to: [parent.id] }, revision: task.body.revision } });
    assert.equal(scopedReference.status, 404);
    assert.equal((await f.request(`${base()}/core/entities/${task.body.id}`, { method: 'PATCH', body: { changes: { 'x-pm-command-id': 'forged' }, revision: task.body.revision } })).status, 400);
    assert.equal((await f.request(`${base()}/core/files/${task.body.id}`, { method: 'PUT', body: { raw: patchMarkdown(task.body.raw, { 'x-pm-created-by': f.owner.id }), revision: task.body.revision } })).status, 400);
    assert.equal((await f.request(`${base()}/core/entities/${task.body.id}`, { method: 'PATCH', cookie: member.cookie, body: { changes: { status: 'done' }, revision: task.body.revision } })).status, 403);
    assert.equal((await f.request(`${base()}/core/files/${task.body.id}`, { method: 'PUT', cookie: member.cookie, body: { raw: patchMarkdown(task.body.raw, { status: 'done' }), revision: task.body.revision } })).status, 403);
    const reader = await f.member('Read-only task reader');
    await grant(reader.user.id, [p.id], ['domain.read']);
    assert.equal((await native({ entity: 'work_item', project: p.id, title: 'Read only' }, reader.cookie)).status, 403);
    assert.equal((await f.send({ commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: p.id, payload: { title: 'Read only', description: '', acceptanceCriteria: [] } }, { cookie: reader.cookie })).status, 403);
    await patch(p.id, { status: 'completed' });
    assert.equal((await native({ entity: 'work_item', project: p.id, title: 'Closed project task' })).status, 409);
    const current = await file(task.body.id);
    assert.equal((await f.request(`${base()}/core/entities/${current.id}`, { method: 'PATCH', body: { changes: { priority: 'urgent' }, revision: current.revision } })).status, 409);
    assert.equal((await f.request(`${base()}/core/files/${current.id}`, { method: 'PUT', body: { raw: patchMarkdown(current.raw, { title: 'Cannot bypass closed project' }), revision: current.revision } })).status, 409);
    assert.equal((await file(current.id)).revision, current.revision);
  });

  it('rejects malformed command fields before allocating a task and keeps accepted Intent conversion unique', async () => {
    const p = await project('Intent and command schema');
    for (const fields of [{ startDate: '2027-02-29' }, { startDate: '2028-03-01', dueDate: '2028-02-29' }, { estimatePoints: '8' }, { location: 'x'.repeat(1001) }, { labels: [42] }, { kind: 'invented' }, { parentId: 'fake-id' }]) {
      const response = await f.send({ commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: p.id, payload: { title: 'Invalid fields', description: '', acceptanceCriteria: [], ...fields } });
      assert.ok(response.status >= 400, JSON.stringify(response.body));
    }
    const intent = await f.command<Entity>('ProposeIntent', { summary: 'Accepted idea', goal: 'Preserve conversion semantics' });
    const accepted = await f.command<{ intent: Entity; decision: Entity }>('AcceptIntent', { revision: 1, reason: 'Explicit acceptance', basisRefs: [] }, { extra: { targetId: intent.id, expectedVersions: { [intent.id]: intent.version } } });
    const payload = { title: 'Converted with full fields', description: '', acceptanceCriteria: [], intentId: intent.id, decisionId: accepted.decision.id, acceptedRevision: 1, startDate: '2028-02-29', dueDate: '2028-03-01', labels: ['intent'], estimatePoints: 0, location: 'Room' };
    const original = { commandId: randomUUID(), commandType: 'CreateWorkItemFromIntent', projectId: p.id, payload };
    const first = await f.send(original);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const created = first.body.result as Entity;
    assert.deepEqual((await f.send(original)).body, first.body);
    const saved = await file(created.id);
    assert.equal(saved.entity['x-pm-start'], payload.startDate);
    assert.deepEqual(saved.entity.labels, ['intent']);
    assert.deepEqual(created.data.originIntentRef, { intentId: intent.id, decisionId: accepted.decision.id, acceptedRevision: 1 });
    const duplicate = await f.send({ commandId: randomUUID(), commandType: 'CreateWorkItemFromIntent', projectId: p.id, payload });
    assert.equal(duplicate.body.error?.code, 'intent_already_converted');
    const alternate = await f.member('Another intent converter');
    await grant(alternate.user.id, [p.id]);
    const reusedKey = await f.send(original, { cookie: alternate.cookie });
    assert.equal(reusedKey.status, 409, JSON.stringify(reusedKey.body));
    assert.equal(reusedKey.body.result, undefined);
    assert.equal((await file(created.id)).revision, saved.revision);
  });

  it('uses configured task states and preserves completion-only command authority', async () => {
    const p = await project('Configured task lifecycle');
    const configuration = await f.request<{ config: ProtocolConfiguration; revision: string }>(`${base()}/core/config`);
    const config = structuredClone(configuration.body.config);
    config.workflows.work_item = { initial: 'queued_custom', states: [
      { id: 'queued_custom', label: 'Queued', category: 'unstarted' }, { id: 'working_custom', label: 'Working', category: 'started' }, { id: 'finished_custom', label: 'Finished', category: 'completed' },
    ], transitions: [{ from: 'queued_custom', to: 'working_custom' }, { from: 'working_custom', to: 'finished_custom' }, { from: 'finished_custom', to: 'queued_custom' }] };
    // Keep states used by earlier test sources valid while making the new initial/custom transitions authoritative.
    config.workflows.work_item.states.push(...configuration.body.config.workflows.work_item!.states);
    config.workflows.work_item.transitions.push(...configuration.body.config.workflows.work_item!.transitions);
    const savedConfig = await f.request(`${base()}/core/config`, { method: 'PUT', body: { config, revision: configuration.body.revision } });
    assert.equal(savedConfig.status, 200, JSON.stringify(savedConfig.body));
    const created = await f.command<Entity>('CreateWorkItem', { title: 'Configured states', description: '', acceptanceCriteria: [] }, { extra: { projectId: p.id } });
    assert.equal((await file(created.id)).entity.status, 'queued_custom');
    const started = await f.command<Entity>('StartWorkItem', {}, { extra: { targetId: created.id, projectId: p.id, expectedVersions: { [created.id]: created.version } } });
    assert.equal((await file(created.id)).entity.status, 'working_custom');
    const completer = await f.member('Completion-only actor');
    await grant(completer.user.id, [p.id], ['domain.read', 'workitem.complete']);
    const completed = await f.command<Entity>('CompleteWorkItem', {}, { cookie: completer.cookie, extra: { targetId: started.id, projectId: p.id, expectedVersions: { [started.id]: started.version } } });
    assert.equal((await file(completed.id)).entity.status, 'finished_custom');
    const nativeTask = await native({ entity: 'work_item', project: p.id, title: 'Native category authority', status: 'working_custom' });
    assert.equal(nativeTask.status, 200, JSON.stringify(nativeTask.body));
    const nativeCompletion = await f.request<FileRecord>(`${base()}/core/entities/${nativeTask.body.id}`, { method: 'PATCH', cookie: completer.cookie, body: { revision: nativeTask.body.revision, changes: { status: 'finished_custom' } } });
    assert.equal(nativeCompletion.status, 200, JSON.stringify(nativeCompletion.body));
    assert.equal(nativeCompletion.body.entity.status, 'finished_custom');
    const deniedMetadata = await f.request(`${base()}/core/entities/${nativeTask.body.id}`, { method: 'PATCH', cookie: completer.cookie, body: { revision: nativeCompletion.body.revision, changes: { priority: 'urgent' } } });
    assert.equal(deniedMetadata.status, 403);
    assert.equal((await file(nativeTask.body.id)).revision, nativeCompletion.body.revision);
  });
});
