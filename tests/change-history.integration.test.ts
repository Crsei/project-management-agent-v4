import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Entity } from '../packages/domain/src/core.ts';
import type { FileRecord, ProtocolConfiguration } from '../packages/pm-schema/index.ts';
import type { ChangeHistoryPage, ChangeDetail, ChangeComparison, ChangeAcknowledgement, TaskAttentionPage, ChangeHistoryTarget } from '../packages/contracts/src/change-history.ts';
import type { NotificationInboxPage } from '../packages/domain/src/notifications.ts';
import { CoreWorkspacePool } from '../apps/server/pm/src/core-routes.ts';
import { CoreFactImporter } from '../apps/server/pm/src/core-fact-importer.ts';
import { CoreCommandJournal } from '../apps/server/pm/src/core-journal.ts';
import { captureCoreFacts } from '../apps/server/pm/src/core-facts.ts';
import { Workspace } from '../packages/pm-core/index.ts';
import { DurableState } from '../packages/pm-core/state.ts';
import { FileRepository, revisionOf } from '../packages/pm-core/repository.ts';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';
import { readServiceFactObservations } from '../packages/pm-core/service-facts.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { routeNotificationBatch } from '../packages/application/src/notification-routing.ts';
import { createDashboardFixture, dashboardDatabaseUrl, type DashboardFixture } from './dashboard-fixture.ts';

const target = (entityId: string): ChangeHistoryTarget => ({ kind: 'core', entityId });
const base = (f: DashboardFixture) => `/api/v1/workspaces/${f.workspaceId}`;
async function project(f: DashboardFixture) {
  return f.command<Entity>('CreateProject', { name: 'History project', goal: '', ownerId: f.owner.id, completionCriteria: [] });
}
async function create(f: DashboardFixture, input: Record<string, unknown>): Promise<FileRecord> {
  const response = await f.request<FileRecord>(`${base(f)}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: input });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function patch(f: DashboardFixture, file: FileRecord, changes: Record<string, unknown>): Promise<FileRecord> {
  const response = await f.request<FileRecord>(`${base(f)}/core/entities/${file.id}`, { method: 'PATCH', body: { revision: file.revision, changes } });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function save(f: DashboardFixture, file: FileRecord, raw: string): Promise<FileRecord> {
  const response = await f.request<FileRecord>(`${base(f)}/core/files/${file.id}`, { method: 'PUT', body: { revision: file.revision, raw } });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function history(f: DashboardFixture, id: string, options: Record<string, unknown> = {}, cookie = f.ownerCookie): Promise<ChangeHistoryPage> {
  const response = await f.request<ChangeHistoryPage>(`${base(f)}/change-history/query`, { method: 'POST', cookie, body: { target: target(id), ...options } });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function acknowledge(f: DashboardFixture, id: string, page: ChangeHistoryPage, cookie = f.ownerCookie): Promise<ChangeAcknowledgement> {
  const response = await f.request<ChangeAcknowledgement>(`${base(f)}/change-history/acknowledge`, { method: 'POST', cookie, body: { target: target(id), through: page.head, observationToken: page.observationToken } });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function attention(f: DashboardFixture, ids: string[], cookie = f.ownerCookie): Promise<TaskAttentionPage> {
  const response = await f.request<TaskAttentionPage>(`${base(f)}/change-history/attention`, { method: 'POST', cookie, body: { taskIds: ids } });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function drain(f: DashboardFixture) {
  const core = readonlyCorePort(id => join(f.coreRoot, id));
  for (let round = 0; round < 40; round++) if (!(await routeNotificationBatch(f.pool, core, `history-${randomUUID()}`, { jobLimit: 20, candidateLimit: 100 })).jobs) return;
  throw new Error('Isolated notification routing did not settle');
}
async function inbox(f: DashboardFixture, cookie: string) {
  const response = await f.request<NotificationInboxPage>(`${base(f)}/notification-inbox`, { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.items;
}

describe('immutable change history and personal review cursors on an isolated real database', { skip: !dashboardDatabaseUrl }, () => {
  it('keeps exact body/metadata endpoints, bounded heads, actor-bound grants and concurrent personal acknowledgement', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f), reader = await f.member('Independent history reader');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [p.id] });
    const initial = await create(f, { entity: 'work_item', project: p.id, title: 'Exact task', body: 'Initial task body\n\n- [ ] Keep human acceptance separate' });
    const middle = await patch(f, initial, { priority: 'high' });
    const seen = await history(f, initial.id, { limit: 1 }, reader.cookie);
    assert.equal(seen.items.length, 1); assert.ok(seen.nextCursor);
    assert.equal(JSON.stringify(seen).includes('Initial task body'), false);
    assert.ok(seen.items[0]!.changedFields.includes('priority'));
    const current = await save(f, middle, middle.raw.replace('Initial task body', 'Concurrent newer body'));
    const acknowledged = await acknowledge(f, initial.id, seen, reader.cookie);
    assert.equal(acknowledged.reviewedThrough, seen.head); assert.equal(acknowledged.pendingCount, 1);
    assert.deepEqual(await acknowledge(f, initial.id, seen, reader.cookie), acknowledged);
    assert.equal((await attention(f, [initial.id], reader.cookie)).items[0]!.pendingCount, 1);
    assert.ok((await attention(f, [initial.id])).items[0]!.pendingCount > 1, 'another user is independent');
    const newest = (await history(f, initial.id)).items[0]!;
    const detail = await f.request<ChangeDetail>(`${base(f)}/change-history/${newest.changeId}`);
    assert.equal(detail.status, 200); assert.equal(detail.body.before!.raw, middle.raw); assert.equal(detail.body.after!.raw, current.raw);
    const cumulative = await f.request<ChangeComparison>(`${base(f)}/change-history/compare`, { method: 'POST', cookie: reader.cookie, body: { target: target(initial.id) } });
    assert.equal(cumulative.status, 200); assert.equal(cumulative.body.before!.raw, middle.raw); assert.equal(cumulative.body.after!.raw, current.raw);
    const bounded = await f.request<ChangeComparison>(`${base(f)}/change-history/compare`, { method: 'POST', cookie: reader.cookie, body: { target: target(initial.id), through: seen.head } });
    assert.equal(bounded.status, 200); assert.equal(bounded.body.after!.raw, middle.raw);
    const endpointOutsideHead = await f.request(`${base(f)}/change-history/compare`, { method: 'POST', body: { target: target(initial.id), through: seen.head, toChangeId: newest.changeId } });
    assert.equal(endpointOutsideHead.status, 409);
    const older = await history(f, initial.id, { limit: 1, head: seen.head, cursor: seen.nextCursor }, reader.cookie);
    assert.equal(older.head, seen.head); assert.equal(older.items[0]!.afterRevision, initial.revision);
    for (const body of [
      { target: target(initial.id), through: (BigInt(seen.head) + 1n).toString(), observationToken: seen.observationToken },
      { target: target(p.id), through: seen.head, observationToken: seen.observationToken },
    ]) assert.equal((await f.request(`${base(f)}/change-history/acknowledge`, { method: 'POST', cookie: reader.cookie, body })).status, 409);
    assert.equal((await f.request(`${base(f)}/change-history/acknowledge`, { method: 'POST', body: { target: target(initial.id), through: seen.head, observationToken: seen.observationToken } })).status, 409);
    for (const through of ['not-a-sequence', `${seen.head}\n`, '9223372036854775808']) {
      assert.equal((await f.request(`${base(f)}/change-history/acknowledge`, { method: 'POST', cookie: reader.cookie, body: { target: target(initial.id), through, observationToken: seen.observationToken } })).status, 400);
    }
    const count = (await f.pool.query('SELECT count(*)::int AS n FROM change_history_entries')).rows[0].n;
    assert.equal((await f.request(`${base(f)}/core/entities/${initial.id}`, { method: 'PATCH', body: { revision: initial.revision, changes: { priority: 'low' } } })).status, 409);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM change_history_entries')).rows[0].n, count);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM notification_recipients WHERE read_at IS NOT NULL')).rows[0].n, 0);
  });

  it('orders and paginates numeric history sequences across decimal boundaries and compares the latest endpoint', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f);
    let file = await create(f, { entity: 'work_item', project: p.id, title: 'Numeric history order', body: 'Version 0' });
    const versions = [file.revision];
    for (let version = 1; version <= 12; version++) {
      file = await save(f, file, file.raw.replace(`Version ${version - 1}`, `Version ${version}`));
      versions.push(file.revision);
    }
    const first = await history(f, file.id, { limit: 3 });
    assert.ok(BigInt(first.head) > 10n);
    assert.equal(first.items[0]!.afterRevision, file.revision);
    const revisions = first.items.map(item => item.afterRevision);
    let page = first;
    while (page.nextCursor) {
      page = await history(f, file.id, { limit: 3, head: first.head, cursor: page.nextCursor });
      revisions.push(...page.items.map(item => item.afterRevision));
    }
    assert.deepEqual(revisions, versions.toReversed(), 'Pagination must neither omit nor duplicate earlier saves');
    const compare = await f.request<ChangeComparison>(`${base(f)}/change-history/compare`, { method: 'POST', body: { target: target(file.id), through: first.head } });
    assert.equal(compare.status, 200); assert.equal(compare.body.after!.raw, file.raw);
    await acknowledge(f, file.id, first);
    const next = await save(f, file, file.raw.replace('Version 12', 'Version 13'));
    const sinceRead = await f.request<ChangeComparison>(`${base(f)}/change-history/compare`, { method: 'POST', body: { target: target(file.id) } });
    assert.equal(sinceRead.status, 200); assert.equal(sinceRead.body.before!.raw, file.raw); assert.equal(sinceRead.body.after!.raw, next.raw);
  });

  it('reviews only formal related sources, rejects changed link scopes, and does not clear unseen related history with a self-only grant', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f);
    let task = await create(f, { entity: 'work_item', project: p.id, title: 'Related changes', body: 'Task body' });
    const requirement = await create(f, { entity: 'requirement', project: p.id, title: 'Formal requirement', body: 'Requirement before' });
    let document = await create(f, { entity: 'document', project: p.id, title: 'Formal document', related_to: [task.id], body: 'Document before' });
    await create(f, { entity: 'document', project: p.id, title: 'Mention only', body: `A wikilink mention [[${task.id}]] is not a formal relation` });
    const previouslyUnlinked = await create(f, { entity: 'document', project: p.id, title: 'Old unrelated document', body: 'Older document history' });
    task = await patch(f, task, { requirement: requirement.id });
    const self = await history(f, task.id, { includeRelated: false });
    assert.ok(self.items.every(item => item.relation === 'self'));
    await acknowledge(f, task.id, self);
    let summary = (await attention(f, [task.id])).items[0]!;
    assert.equal(summary.ownPendingCount, 0); assert.equal(summary.relatedPendingCount, 2);
    const all = await history(f, task.id);
    assert.equal(all.items.filter(item => item.relation === 'related_requirement').length, 1);
    assert.equal(all.items.filter(item => item.relation === 'related_document').length, 1);
    document = await save(f, document, document.raw.replace('Document before', 'Document after concurrent edit'));
    assert.equal((await acknowledge(f, task.id, all)).pendingCount, 1, 'a newer related edit survives the old head');
    const beforeLink = await history(f, task.id);
    task = await patch(f, task, { related_to: [previouslyUnlinked.id] });
    assert.equal((await f.request(`${base(f)}/change-history/acknowledge`, { method: 'POST', body: { target: target(task.id), through: beforeLink.head, observationToken: beforeLink.observationToken } })).status, 409);
    await acknowledge(f, task.id, await history(f, task.id, { includeRelated: false }));
    summary = (await attention(f, [task.id])).items[0]!;
    assert.equal(summary.ownPendingCount, 0); assert.equal(summary.relatedPendingCount, 2, 'newly linked old history has its own personal cursor');
    const beforeUnlink = await history(f, task.id);
    task = await patch(f, task, { requirement: null });
    assert.equal((await f.request(`${base(f)}/change-history/acknowledge`, { method: 'POST', body: { target: target(task.id), through: beforeUnlink.head, observationToken: beforeUnlink.observationToken } })).status, 409);
    assert.equal((await acknowledge(f, task.id, await history(f, task.id))).pendingCount, 0);
    assert.equal((await history(f, document.id)).items[0]!.afterRevision, document.revision);
  });

  it('routes only completion additions to assignee/requester using configured categories, retains trusted Agent self-results and deduplicates', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f), assignee = await f.member('Unwatched assignee'), watcher = await f.member('Explicit watcher');
    for (const member of [assignee, watcher]) await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'intent.propose'], projectIds: [p.id] });
    const configured = (await f.request<{ config: ProtocolConfiguration; revision: string }>(`${base(f)}/core/config`)).body;
    const workflow = configured.config.workflows.work_item; assert.ok(workflow);
    workflow.states.push({ id: 'delivered_custom', label: 'Delivered custom', category: 'completed' }, { id: 'verified_custom', label: 'Another completed label', category: 'completed' });
    for (const state of workflow.states) for (const status of ['delivered_custom', 'verified_custom']) if (state.id !== status) workflow.transitions.push({ from: state.id, to: status });
    assert.equal((await f.request(`${base(f)}/core/config`, { method: 'PUT', body: { config: configured.config, revision: configured.revision } })).status, 200);
    let task = await create(f, { entity: 'work_item', project: p.id, title: 'Semantic completion', assignee: assignee.user.id, body: 'Completion body' });
    await f.command('WatchTask', { taskId: task.id }, { cookie: watcher.cookie, extra: { projectId: p.id } });
    await f.command('WatchTask', { taskId: task.id }, { extra: { projectId: p.id } });
    task = await save(f, task, task.raw.replace('Completion body', 'Ordinary manual body edit'));
    await drain(f);
    assert.equal((await inbox(f, assignee.cookie)).length, 0, 'ordinary edits do not auto-subscribe the assignee');
    assert.equal((await inbox(f, f.ownerCookie)).length, 0, 'manual self edits remain quiet');
    const forged = await f.request(`${base(f)}/commands`, { method: 'POST', body: { commandId: randomUUID(), commandType: 'CreateTaskComment', targetId: task.id, projectId: p.id, payload: { content: 'Browser must not claim Agent provenance' }, trustedSource: { kind: 'agent' } } });
    assert.equal(forged.status, 400);
    const comment = await f.request<{ status: string }>(`${base(f)}/agent-tools/call`, { method: 'POST', body: { operationId: randomUUID(), name: 'pm_create_comment', arguments: { projectId: p.id, taskId: task.id, content: 'Trusted Agent tool comment' }, target: { workspaceId: f.workspaceId, projectId: p.id }, threadId: 'isolated-comment-thread', messageId: 'isolated-comment-message', generationId: 'isolated-comment-generation' } });
    assert.equal(comment.status, 200, JSON.stringify(comment.body)); assert.equal(comment.body.status, 'succeeded'); await drain(f);
    assert.ok((await inbox(f, f.ownerCookie)).some(item => item.target?.commentId && item.event.origin === 'agent'), 'a trusted Agent comment is not suppressed as a manual self edit');
    assert.equal((await inbox(f, assignee.cookie)).length, 0);
    const input = { operationId: randomUUID(), name: 'pm_transition_task', arguments: { id: task.id, revision: task.revision, status: 'delivered_custom' }, target: { workspaceId: f.workspaceId, projectId: p.id }, threadId: 'isolated-agent-thread', messageId: 'isolated-agent-message', generationId: 'isolated-agent-generation' };
    const call = await f.request<{ status: string }>(`${base(f)}/agent-tools/call`, { method: 'POST', body: input });
    assert.equal(call.status, 200, JSON.stringify(call.body)); assert.equal(call.body.status, 'succeeded');
    await drain(f);
    for (const cookie of [assignee.cookie, watcher.cookie, f.ownerCookie]) {
      const completed = (await inbox(f, cookie)).filter(item => item.event.completion);
      assert.equal(completed.length, 1); assert.ok(completed[0]!.reasons.includes('completion')); assert.ok(completed[0]!.target?.changeId);
      assert.equal(completed[0]!.event.origin, 'agent');
      const detail = await f.request<ChangeDetail>(`${base(f)}/change-history/${completed[0]!.target!.changeId}`);
      assert.equal(detail.body.after!.metadata?.status, 'delivered_custom');
    }
    assert.equal((await f.request<{ status: string }>(`${base(f)}/agent-tools/call`, { method: 'POST', body: input })).body.status, 'succeeded');
    task = (await f.request<FileRecord>(`${base(f)}/core/files/${task.id}`)).body;
    await patch(f, task, { status: 'verified_custom' });
    await drain(f);
    assert.equal((await inbox(f, assignee.cookie)).length, 1, 'completed-to-completed is not another completion');
    assert.equal((await inbox(f, f.ownerCookie)).filter(item => item.event.completion).length, 1);
    const facts = await f.pool.query('SELECT * FROM service_fact_events WHERE workspace_id=$1', [f.workspaceId]);
    assert.equal(JSON.stringify(facts.rows).includes('Ordinary manual body edit'), false);
  });

  it('exposes exact invalid source bytes when a raw repair replaces stale parsed content', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f), original = await create(f, { entity: 'work_item', project: p.id, title: 'Invalid source repair', body: 'Original parsed body' });
    const invalid = original.raw.replace('status: todo', 'status: unknown-state').replace('Original parsed body', 'Actual externally changed body');
    assert.notEqual(invalid, original.raw);
    await writeFile(join(f.coreRoot, f.workspaceId, original.path), invalid);
    const repaired = await save(f, { ...original, revision: revisionOf(invalid) }, original.raw.replace('Original parsed body', 'Repaired valid body'));
    const page = await history(f, original.id);
    const entry = page.items.find(item => item.afterRevision === repaired.revision);
    assert.ok(entry);
    const detail = await f.request<ChangeDetail>(`${base(f)}/change-history/${entry.changeId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.before?.raw, invalid);
    assert.equal(detail.body.before?.body, null);
    assert.equal(detail.body.before?.metadata, null);
    assert.equal(detail.body.after?.raw, repaired.raw);
    assert.deepEqual(detail.body.change.changedFields, []);
  });

  it('recovers exact saved snapshots from durable mutation proof after publication failure even when the current file has advanced', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f), original = await create(f, { entity: 'work_item', project: p.id, title: 'Proof recovery', body: 'Exact before A' });
    await f.app.close();
    const roots = new CoreWorkspacePool(f.coreRoot), workspace = await roots.get(f.workspaceId), sql = await f.pool.connect();
    const operationId = randomUUID(), rawB = original.raw.replace('Exact before A', 'Saved endpoint B'), root = join(f.coreRoot, f.workspaceId);
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, f.workspaceId);
      const capture = captureCoreFacts({ sql, workspaceId: f.workspaceId, root, sourceKind: 'core_http', operationId, requestHash: 'c'.repeat(64), actorId: f.owner.id, facts: [], configuration: workspace.configuration().config });
      await assert.rejects(workspace.captureMutations({ ...capture, committed() { throw new Error('Isolated interruption before fact_completed'); } }, () => workspace.save(original.id, rawB, original.revision)));
      await sql.query('ROLLBACK');
    } finally { sql.release(); await roots.close(); }
    const prepared = new CoreCommandJournal(root).entries().find(entry => entry.kind === 'fact_prepared' && entry.commandId === operationId);
    assert.ok(prepared && prepared.kind === 'fact_prepared');
    assert.ok(Workspace.mutationProofs(root).has(prepared.captured.fact.factId));
    assert.ok(prepared.captured.history?.afterKey);
    const snapshotChunk = join(root, '.pm/state/change-snapshots', `${prepared.captured.history.afterKey}-0.txt`), retainedChunk = await readFile(snapshotChunk, 'utf8');
    await unlink(snapshotChunk);
    const rawC = rawB.replace('Saved endpoint B', 'Later unobserved endpoint C'); await writeFile(join(root, original.path), rawC);
    const reopened = new CoreWorkspacePool(f.coreRoot); t.after(() => reopened.close()); const importer = new CoreFactImporter(f.pool, reopened);
    await assert.rejects(importer.importWorkspace(f.workspaceId));
    assert.equal((await f.pool.query('SELECT 1 FROM change_history_entries WHERE change_id=$1', [prepared.captured.fact.factId])).rows.length, 0, 'missing retained bytes are never rebuilt from the current file');
    await writeFile(snapshotChunk, retainedChunk);
    await importer.importWorkspace(f.workspaceId); await importer.importWorkspace(f.workspaceId);
    const exact = (await f.pool.query<{ before_snapshot: { raw: string }; after_snapshot: { raw: string } }>('SELECT before_snapshot,after_snapshot FROM change_history_entries WHERE change_id=$1', [prepared.captured.fact.factId])).rows[0]!;
    assert.equal(exact.before_snapshot.raw, original.raw); assert.equal(exact.after_snapshot.raw, rawB);
    const observed = await f.pool.query<{ before_snapshot: { raw: string }; after_snapshot: { raw: string }; actor_id: string | null; occurred_at: Date | null }>(`SELECT before_snapshot,after_snapshot,actor_id,occurred_at FROM change_history_entries WHERE workspace_id=$1 AND stream_key=$2 AND origin='observation'`, [f.workspaceId, `core:${original.id}`]);
    assert.equal(observed.rows.length, 1); assert.equal(observed.rows[0]!.before_snapshot.raw, rawB); assert.equal(observed.rows[0]!.after_snapshot.raw, rawC); assert.equal(observed.rows[0]!.actor_id, null); assert.equal(observed.rows[0]!.occurred_at, null);
    assert.equal(Workspace.mutationProofs(root).size, 0, 'durably completed journal entries retire their temporary proof');
    assert.equal(await readFile(join(root, original.path), 'utf8'), rawC);
  });

  it('never replays a merely prepared ordinary save, and preserves external bytes when an uncertain write conflicts', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f), original = await create(f, { entity: 'work_item', project: p.id, title: 'No false save', body: 'Original unchanged A' });
    await f.app.close();
    const root = join(f.coreRoot, f.workspaceId), roots = new CoreWorkspacePool(f.coreRoot), workspace = await roots.get(f.workspaceId), config = workspace.configuration().config;
    const raw = original.raw.replace('Original unchanged A', 'Intended but never written B'), candidate: FileRecord = { ...original, raw, revision: revisionOf(raw), entity: parseMarkdown(raw, config) };
    await roots.close();
    const sql = await f.pool.connect(), operationId = randomUUID(); let mutationId: string | void;
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, f.workspaceId);
      mutationId = await captureCoreFacts({ sql, workspaceId: f.workspaceId, root, sourceKind: 'core_http', operationId, requestHash: 'd'.repeat(64), actorId: f.owner.id, facts: [], configuration: config }).prepare(original, candidate);
      assert.ok(mutationId);
      new DurableState(new FileRepository(root)).begin({ kind: 'write', id: original.id, path: original.path, raw, beforeRevision: original.revision, mutationId });
      await sql.query('ROLLBACK');
    } finally { sql.release(); }
    const reopened = new CoreWorkspacePool(f.coreRoot); t.after(() => reopened.close()); const importer = new CoreFactImporter(f.pool, reopened);
    await importer.importWorkspace(f.workspaceId);
    assert.equal(await readFile(join(root, original.path), 'utf8'), original.raw, 'an unchanged before revision cancels the uncertain save instead of rolling it forward');
    assert.equal((await f.pool.query('SELECT 1 FROM change_history_entries WHERE change_id=$1', [mutationId!])).rows.length, 0);
    assert.equal(Workspace.mutationProofs(root).size, 0);
    await reopened.close();
    const conflictId = randomUUID(); new DurableState(new FileRepository(root)).begin({ kind: 'write', id: original.id, path: original.path, raw, beforeRevision: original.revision, mutationId: conflictId });
    const external = original.raw.replace('Original unchanged A', 'External writer C'); await writeFile(join(root, original.path), external);
    const conflicting = new CoreWorkspacePool(f.coreRoot); t.after(() => conflicting.close());
    await assert.rejects(new CoreFactImporter(f.pool, conflicting).importWorkspace(f.workspaceId));
    assert.equal(await readFile(join(root, original.path), 'utf8'), external, 'unknown external effects are never overwritten');
  });

  it('labels a legacy hash-only observation as missing-before rather than rebuilding a prior snapshot from current content', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const p = await project(f), original = await create(f, { entity: 'work_item', project: p.id, title: 'Unknown prior endpoint', body: 'Previously observed A' });
    await f.app.close();
    const root = join(f.coreRoot, f.workspaceId), ledger = readServiceFactObservations(root);
    for (const baseline of ledger.baseline) { delete baseline.snapshotKey; delete baseline.extendedMetadata; delete baseline.statusCategory; }
    await writeFile(join(root, '.pm/state/service-observations.json'), JSON.stringify(ledger));
    const current = original.raw.replace('Previously observed A', 'Current endpoint C'); await writeFile(join(root, original.path), current);
    const workspaces = new CoreWorkspacePool(f.coreRoot); t.after(() => workspaces.close());
    await new CoreFactImporter(f.pool, workspaces).importWorkspace(f.workspaceId);
    const observed = await f.pool.query<{ before_snapshot: null; after_snapshot: { raw: string }; completeness: string; actor_id: string | null }>(`SELECT before_snapshot,after_snapshot,completeness,actor_id FROM change_history_entries WHERE workspace_id=$1 AND stream_key=$2 AND origin='observation'`, [f.workspaceId, `core:${original.id}`]);
    assert.equal(observed.rows.length, 1); assert.equal(observed.rows[0]!.before_snapshot, null); assert.equal(observed.rows[0]!.after_snapshot.raw, current);
    assert.equal(observed.rows[0]!.completeness, 'missing_before'); assert.equal(observed.rows[0]!.actor_id, null);
  });

  it('hides history and attention after current project movement, deletion or permission revocation', { timeout: 180_000 }, async t => {
    const f = await createDashboardFixture({ signal: t.signal }); t.after(() => f.close());
    const first = await project(f), second = await project(f), member = await f.member('Revocable history scope');
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [first.id] });
    const original = await create(f, { entity: 'work_item', project: first.id, title: 'Current authorization', body: 'Private scoped body' });
    const seen = await history(f, original.id, {}, member.cookie), id = seen.items[0]!.changeId;
    const moved = await patch(f, original, { project: second.id });
    assert.equal((await f.request(`${base(f)}/change-history/${id}`, { cookie: member.cookie })).status, 404);
    assert.equal((await f.request(`${base(f)}/change-history/query`, { method: 'POST', cookie: member.cookie, body: { target: target(original.id) } })).status, 404);
    assert.deepEqual((await attention(f, [original.id], member.cookie)).items, []);
    const relocatedMembership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read'], projectIds: [second.id] }, { extra: { expectedVersions: { [member.user.id]: membership.version } } });
    const scoped = await patch(f, moved, { priority: 'high' });
    const visible = await history(f, original.id, {}, member.cookie);
    assert.equal(visible.items.length, 1); assert.equal(visible.items[0]!.afterRevision, scoped.revision);
    const comparison = await f.request<ChangeComparison>(`${base(f)}/change-history/compare`, { method: 'POST', cookie: member.cookie, body: { target: target(original.id) } });
    assert.equal(comparison.status, 200); assert.equal(comparison.body.before!.metadata?.project, second.id); assert.equal(comparison.body.after!.raw, scoped.raw); assert.equal(comparison.body.completeness, 'missing_before');
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: [], projectIds: [] }, { extra: { expectedVersions: { [member.user.id]: relocatedMembership.version } } });
    assert.equal((await f.request(`${base(f)}/change-history/${id}`, { cookie: member.cookie })).status, 403);
    await unlink(join(f.coreRoot, f.workspaceId, moved.path));
    assert.equal((await f.request(`${base(f)}/change-history/${id}`)).status, 404);
    assert.deepEqual((await attention(f, [original.id])).items, []);
  });
});
