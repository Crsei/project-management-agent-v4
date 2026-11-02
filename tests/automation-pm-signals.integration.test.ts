import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { lockWorkspace } from '../packages/infrastructure/src/database.ts';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { revisionOf } from '../packages/pm-core/repository.ts';
import { Workspace } from '../packages/pm-core/index.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { captureCoreFacts } from '../apps/server/pm/src/core-facts.ts';
import { CoreCommandJournal } from '../apps/server/pm/src/core-journal.ts';
import { CoreFactImporter } from '../apps/server/pm/src/core-fact-importer.ts';
import { CoreWorkspacePool } from '../apps/server/pm/src/core-routes.ts';
import type { CapturedServiceFact } from '../packages/application/src/service-facts.ts';
import { capturePmAutomationEvents, insertPmAutomationSignal, receivePmAutomationSignal, recordPmAutomationVisit, runPmAutomationSignalBatch, withPmAutomationOrigin } from '../packages/application/src/automation-pm-signals.ts';
import { pmAutomationTemplateVersion, type PmAutomationEvent, type PmAutomationTemplateId } from '../packages/contracts/src/automation-pm.ts';
import type { StudioConfig } from '../packages/contracts/src/automation-studio.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
let database: MailFixtureDatabase;
const rejects = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const rawTask = (description: string): string => `---\nschema: pm/v1\nid: TASK-001\nentity: work_item\nproject: PRJ-001\nstatus: todo\n---\n# Requirement\n\n${description}\n\n- [ ] Actual acceptance\n`;
async function fixture(signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool } = await acquireMailFixtureDatabase(scope, database);
    const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Signal owner', password: 'Isolated-Signal-Only-Password' });
    const other = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Other owner', password: 'Isolated-Signal-Only-Password' });
    const workspaceId = (await createWorkspace(pool, actor.id, 'Native PM signal integration')).id;
    await pool.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,$4)', [workspaceId, other.id, ['domain.read', 'planning.edit'], ['PRJ-001']]);
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-native-signals-')), value => rm(value, { recursive: true, force: true }));
    const workspaceRoot = join(root, workspaceId);
    await mkdir(join(workspaceRoot, 'projects'), { recursive: true });
    await mkdir(join(workspaceRoot, 'work-items'));
    await writeFile(join(workspaceRoot, 'projects/PRJ-001.md'), '---\nschema: pm/v1\nid: PRJ-001\nentity: project\nstatus: active\n---\n# Real project\n');
    await writeFile(join(workspaceRoot, 'projects/PRJ-002.md'), '---\nschema: pm/v1\nid: PRJ-002\nentity: project\nstatus: active\n---\n# Other project\n');
    await writeFile(join(workspaceRoot, 'work-items/TASK-001.md'), rawTask('Before requirement'));
    const core = readonlyCorePort(id => join(root, id));
    const context = { database: () => pool, core };
    async function definition(templateId: PmAutomationTemplateId, key: PmAutomationEvent['key'], ownerId = actor.id, status = 'enabled', filter = {}) {
      const id = randomUUID();
      const config: StudioConfig = { name: 'Native signal', description: '', projectId: 'PRJ-001', tags: [], templateId, templateVersion: pmAutomationTemplateVersion, templateInputs: {},
        action: { kind: 'template', templateId, arguments: {}, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 30 },
        trigger: { kind: 'event', source: 'pm', key, filter }, dailyLimit: 100, cooldownMinutes: 0 };
      await pool.query('INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config,status) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [id, workspaceId, ownerId, config.projectId, JSON.stringify(config), status]);
      return id;
    }
    async function insert(event: PmAutomationEvent) {
      const sql = await pool.connect();
      try { await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); const added = await insertPmAutomationSignal(sql, event); await sql.query('COMMIT'); return added; }
      catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    }
    function taskChange() {
      const beforeRaw = rawTask('Before requirement'), afterRaw = rawTask('After requirement');
      const file = (raw: string) => ({ id: 'TASK-001', path: 'work-items/TASK-001.md', raw, revision: revisionOf(raw), entity: parseMarkdown(raw) });
      return capturePmAutomationEvents({ eventId: randomUUID(), actorId: actor.id, workspaceId, before: file(beforeRaw), after: file(afterRaw) })[0]!;
    }
    return { pool, actor, other, workspaceId, root, workspaceRoot, core, context, definition, insert, taskChange, close: scope.close };
  });
}

describe('durable native PM automation signal boundaries', { skip: !source }, () => {
  before(async t => { assert.ok(source); assertV4WorkerTestDatabase(source); database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(async () => { await database?.close(); }, { timeout: 30000 });

  it('two workers and restart advance bounded definition cursors exactly once and never activate paused/draft definitions', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const ids = await Promise.all(Array.from({ length: 4 }, () => f.definition('pm-requirement-change-impact', 'task.updated')));
    const paused = await f.definition('pm-requirement-change-impact', 'task.updated', f.actor.id, 'paused');
    const draft = await f.definition('pm-requirement-change-impact', 'task.updated', f.actor.id, 'draft');
    const event = f.taskChange();
    assert.equal(await f.insert(event), true);
    assert.equal(await f.insert(event), false);
    await Promise.all([runPmAutomationSignalBatch(f.pool, f.core, { definitionLimit: 1 }), runPmAutomationSignalBatch(f.pool, f.core, { definitionLimit: 1 })]);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_studio_executions WHERE definition_id=ANY($1::uuid[])', [ids])).rows[0].n, 2);
    await runPmAutomationSignalBatch(f.pool, f.core, { definitionLimit: 1 });
    await runPmAutomationSignalBatch(f.pool, f.core, { definitionLimit: 1 });
    await runPmAutomationSignalBatch(f.pool, f.core, { definitionLimit: 1 });
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_studio_executions WHERE definition_id=ANY($1::uuid[])', [ids])).rows[0].n, 4);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_studio_executions WHERE definition_id=ANY($1::uuid[])', [[paused, draft]])).rows[0].n, 0);
    const row = (await f.pool.query('SELECT payload FROM automation_studio_executions WHERE definition_id=$1', [ids[0]])).rows[0];
    assert.equal(row.payload.before.task.description, 'Before requirement');
    assert.equal(row.payload.after.task.description, 'After requirement');
    assert.equal(row.payload.before.task.revision, event.before!.task.revision);
    await assert.rejects(f.insert({ ...event, at: new Date(Date.parse(event.at) + 1).toISOString() }), rejects('automation_signal_identity_conflict'));
  });

  it('freezes actual native before/after in the existing journal and restores queue intent after SQL interruption without replaying the file write', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const definitionId = await f.definition('pm-requirement-change-impact', 'task.updated');
    const workspace = new Workspace(f.workspaceRoot); await workspace.init();
    t.after(() => workspace.close());
    const facts: CapturedServiceFact[] = [], commandId = randomUUID(), sql = await f.pool.connect();
    let beforeRevision = '', afterRevision = '';
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, f.workspaceId);
      const original = workspace.get('TASK-001'); beforeRevision = original.revision;
      const saved = await workspace.captureMutations(captureCoreFacts({ sql, workspaceId: f.workspaceId, root: f.workspaceRoot, sourceKind: 'command', operationId: commandId, requestHash: 'a'.repeat(64), actorId: f.actor.id, facts, configuration: workspace.configuration().config }),
        () => workspace.save(original.id, rawTask('After durable requirement'), original.revision));
      afterRevision = saved.revision;
      await sql.query('ROLLBACK');
    } finally { sql.release(); }
    await workspace.close();
    const completed = new CoreCommandJournal(f.workspaceRoot).entries().find(entry => entry.kind === 'fact_completed' && entry.commandId === commandId);
    assert.ok(completed?.kind === 'fact_completed');
    assert.equal(completed.captured.pmSignals?.[0]?.before?.task.revision, beforeRevision);
    assert.equal(completed.captured.pmSignals?.[0]?.after?.task.revision, afterRevision);
    const workspaces = new CoreWorkspacePool(f.root); t.after(() => workspaces.close());
    const importer = new CoreFactImporter(f.pool, workspaces);
    await importer.importWorkspace(f.workspaceId);
    await importer.importWorkspace(f.workspaceId);
    await runPmAutomationSignalBatch(f.pool, f.core);
    const executions = await f.pool.query('SELECT payload FROM automation_studio_executions WHERE definition_id=$1', [definitionId]);
    assert.equal(executions.rowCount, 1);
    assert.equal(executions.rows[0].payload.before.task.description, 'Before requirement');
    assert.equal(executions.rows[0].payload.after.task.description, 'After durable requirement');
    assert.equal((await workspaces.get(f.workspaceId)).get('TASK-001').revision, afterRevision);
  });

  it('consumes actual durable external core observations once without inventing old requirement bodies or startup creation history', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const impact = await f.definition('pm-requirement-change-impact', 'task.updated');
    const ready = await f.definition('pm-ready-dependencies', 'task.dependencies_changed');
    await writeFile(join(f.workspaceRoot, 'work-items/TASK-002.md'), rawTask('Real prerequisite').replace('id: TASK-001', 'id: TASK-002'));
    const workspaces = new CoreWorkspacePool(f.root); t.after(() => workspaces.close());
    const workspace = await workspaces.get(f.workspaceId);
    const importer = new CoreFactImporter(f.pool, workspaces);
    await importer.importWorkspace(f.workspaceId);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_pm_signals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 0, 'Initial scan is baseline, not a created-task replay');
    await writeFile(join(f.workspaceRoot, 'work-items/TASK-001.md'), rawTask('External actual requirement').replace('status: todo', 'status: todo\nblocked_by: [TASK-002]'));
    await workspace.rescan('explicit-external-change');
    await importer.importWorkspace(f.workspaceId); await importer.importWorkspace(f.workspaceId);
    await runPmAutomationSignalBatch(f.pool, f.core);
    const rows = await f.pool.query('SELECT definition_id,payload FROM automation_studio_executions WHERE definition_id=ANY($1::uuid[])', [[impact, ready]]);
    assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) { assert.equal(row.payload.before, null); assert.equal(row.payload.after, null); }
  });

  it('advances the real outbox cursor durably across concurrent consumers and never reconstructs old body history from metadata', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const definitionId = await f.definition('pm-ready-dependencies', 'task.state_changed');
    await runPmAutomationSignalBatch(f.pool, f.core);
    const eventId = randomUUID(), aggregateId = randomUUID();
    await f.pool.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
      VALUES($1,$2,'PRJ-001',$5,'work_item',2,1,'WorkItemCompleted','{}'::jsonb,$3,$4)`, [eventId, f.workspaceId, f.actor.id, randomUUID(), aggregateId]);
    await Promise.all([runPmAutomationSignalBatch(f.pool, f.core, { outboxLimit: 1 }), runPmAutomationSignalBatch(f.pool, f.core, { outboxLimit: 1 })]);
    await runPmAutomationSignalBatch(f.pool, f.core, { outboxLimit: 1 });
    const rows = await f.pool.query('SELECT source_key,payload FROM automation_studio_executions WHERE definition_id=$1', [definitionId]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].source_key, `event:outbox:${eventId}`);
    assert.equal(rows.rows[0].payload.sourceRef.id, aggregateId);
    assert.equal(rows.rows[0].payload.before, null); assert.equal(rows.rows[0].payload.after, null);
    assert.ok((await f.pool.query('SELECT outbox_id FROM automation_pm_signal_cursors WHERE workspace_id=$1', [f.workspaceId])).rows[0].outbox_id);
  });

  it('stores actor/project visit windows atomically, first visit is not a fabricated since-last interval, and old request replay does not overwrite a later watermark', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const ownDefinition = await f.definition('pm-since-last-visit', 'project.visited');
    const otherDefinition = await f.definition('pm-since-last-visit', 'project.visited', f.other.id);
    const requestId = randomUUID();
    const first = await recordPmAutomationVisit(f.context, f.actor, f.workspaceId, { requestId, projectId: 'PRJ-001' });
    assert.equal(first.lastVisitAt, null);
    const second = await recordPmAutomationVisit(f.context, f.actor, f.workspaceId, { requestId: randomUUID(), projectId: 'PRJ-001' });
    assert.equal(second.lastVisitAt, first.visitedAt);
    assert.deepEqual(await recordPmAutomationVisit(f.context, f.actor, f.workspaceId, { requestId, projectId: 'PRJ-001' }), first);
    const otherRequestId = randomUUID();
    const other = await recordPmAutomationVisit(f.context, f.other, f.workspaceId, { requestId: otherRequestId, projectId: 'PRJ-001' });
    assert.equal(other.lastVisitAt, null);
    assert.equal((await f.pool.query('SELECT last_visit_at FROM automation_pm_visits WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3', [f.workspaceId, f.actor.id, 'PRJ-001'])).rows[0].last_visit_at.toISOString(), second.visitedAt);
    await runPmAutomationSignalBatch(f.pool, f.core);
    const visits = await f.pool.query('SELECT definition_id,actor_id,payload FROM automation_studio_executions WHERE definition_id=ANY($1::uuid[])', [[ownDefinition, otherDefinition]]);
    assert.equal(visits.rows.filter(row => row.definition_id === ownDefinition && row.actor_id === f.actor.id).length, 2);
    assert.equal(visits.rows.filter(row => row.definition_id === otherDefinition && row.actor_id === f.other.id).length, 1);
    await assert.rejects(recordPmAutomationVisit(f.context, f.actor, f.workspaceId, { requestId, projectId: 'PRJ-002' }), rejects('automation_signal_identity_conflict'));
    await assert.rejects(recordPmAutomationVisit(f.context, f.other, f.workspaceId, { requestId: randomUUID(), projectId: 'PRJ-002' }), rejects('not_found_or_forbidden'));
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.other.id]);
    await assert.rejects(recordPmAutomationVisit(f.context, f.other, f.workspaceId, { requestId: otherRequestId, projectId: 'PRJ-001' }), rejects('not_found_or_forbidden'));
  });

  it('reauthorizes queued definitions, filters enabled definitions, isolates Agent events to their original actor, and suppresses trusted automation loops', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const own = await f.definition('pm-run-summary', 'agent.run.terminal');
    const other = await f.definition('pm-run-summary', 'agent.run.terminal', f.other.id);
    const filtered = await f.definition('pm-run-summary', 'agent.run.terminal', f.actor.id, 'enabled', { 'sourceRef.id': 'different-generation' });
    const now = new Date().toISOString();
    const event: PmAutomationEvent = { eventId: `generation:${randomUUID()}:terminal`, source: 'pm', key: 'agent.run.terminal', actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', at: now,
      sourceRef: { refId: `execution:${randomUUID()}`, kind: 'execution', id: randomUUID(), revision: 'terminal-v1', actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', label: 'Actual durable generation', url: null, updatedAt: now },
      originExecutionId: null, before: null, after: null, lastVisitAt: null, visitedAt: null };
    assert.equal((await receivePmAutomationSignal(f.context, { workspaceId: f.workspaceId, event })).accepted, true);
    assert.equal((await receivePmAutomationSignal(f.context, { workspaceId: f.workspaceId, event })).accepted, false);
    await runPmAutomationSignalBatch(f.pool, f.core);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_studio_executions WHERE definition_id=$1', [own])).rows[0].n, 1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_studio_executions WHERE definition_id=ANY($1::uuid[])', [[other, filtered]])).rows[0].n, 0);
    const generated = await withPmAutomationOrigin(randomUUID(), async () => f.taskChange());
    assert.equal(await f.insert(generated), false);
    await assert.rejects(receivePmAutomationSignal(f.context, { workspaceId: f.workspaceId, event: { ...event, projectId: 'PRJ-002' } }), rejects('automation_signal_scope_mismatch'));
    await f.definition('pm-requirement-change-impact', 'task.updated', f.other.id); const changed = f.taskChange(); await f.insert(changed);
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.other.id]);
    await runPmAutomationSignalBatch(f.pool, f.core);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM automation_studio_executions WHERE actor_id=$1', [f.other.id])).rows[0].n, 0);
  });
});
