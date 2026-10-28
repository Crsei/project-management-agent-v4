import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import { createAutomationService, runAutomationBatch } from '../packages/application/src/automation.ts';
import { observeAutomation } from '../packages/application/src/automation-report.ts';
import { recordHeartbeat } from '../packages/application/src/outbox.ts';
import { automationConfigSchema, type AutomationConfig, type AutomationRule, type AutomationRun } from '../packages/contracts/src/automation.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace, login } from '../packages/infrastructure/src/auth.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { closeMailApp, MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV3WorkerTestDatabase } from './worker-environment.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const config: AutomationConfig = { name: 'Observation report', description: 'Read authorized Markdown only', projectId: 'PRJ-001', trigger: { kind: 'manual', time: '09:00', timezone: 'Asia/Shanghai' }, condition: 'all_open', action: 'report', dailyLimit: 10, cooldownMinutes: 0 };
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

let database: MailFixtureDatabase;

async function fixture(signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool, databaseUrl } = await acquireMailFixtureDatabase(scope, database);
    const schema = database.namespace;
    const password = 'Isolated-Automation-Only-Password';
    const owner = await scope.step(() => createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Automation owner', password }));
    const workspaceId = (await scope.step(() => createWorkspace(pool, owner.id, 'Isolated automation'))).id;
    const other = await scope.step(() => createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Other actor', password }));
    await scope.step(() => pool.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,NULL)', [workspaceId, other.id, ['domain.read', 'planning.edit']]));
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-automation-')), root => rm(root, { recursive: true, force: true }));
    const coreRoot = join(root, 'core'), workspaceRoot = join(coreRoot, workspaceId);
    await scope.step(() => mkdir(join(workspaceRoot, 'projects'), { recursive: true }));
    await scope.step(() => mkdir(join(workspaceRoot, 'work-items')));
    for (const id of ['PRJ-001', 'PRJ-002']) await scope.step(() => writeFile(join(workspaceRoot, 'projects', `${id}.md`), `---\nschema: pm/v1\nid: ${id}\nentity: project\nstatus: active\n---\n# ${id}\n`));
    const taskPath = (id: string) => join(workspaceRoot, 'work-items', `${id}.md`);
    const task = (id: string, extra = '', project = 'PRJ-001', status = 'todo') => `---\nschema: pm/v1\nid: ${id}\nentity: work_item\nproject: ${project}\nstatus: ${status}\n${extra}---\n# ${id} real source\n\nUnchanged task body\n`;
    await scope.step(() => writeFile(taskPath('TASK-001'), task('TASK-001', 'due: 2020-01-01\n')));
    await scope.step(() => writeFile(taskPath('TASK-002'), task('TASK-002', 'blocked_by: [TASK-001]\n')));
    await scope.step(() => writeFile(taskPath('TASK-003'), task('TASK-003', '', 'PRJ-001', 'done')));
    const core = readonlyCorePort(id => join(coreRoot, id));
    const service = createAutomationService({ database: () => pool, core });
    const create = (changed: Partial<AutomationConfig> = {}) => service.create(owner, workspaceId, { requestId: randomUUID(), config: automationConfigSchema.parse({ ...config, ...changed }) });
    async function due(rule: AutomationRule, at: string) { await pool.query('UPDATE automation_rules SET next_due_at=$2 WHERE id=$1', [rule.id, at]); }
    return { pool, schema, databaseUrl, owner, other, password, workspaceId, root, coreRoot, workspaceRoot, taskPath, task, core, service, create, due, scope, close: scope.close };
  });
}

async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, item.name);
      if (item.isDirectory()) await visit(path); else result[path] = (await readFile(join(root, path))).toString('base64');
    }
  }
  await visit(''); return result;
}
async function sqlSnapshot(pool: Pool, schema: string) {
  const tables = await pool.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema]);
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables.rows) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
    result[tablename] = (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${schema}"."${tablename}" t`)).rows[0].rows;
  }
  return result;
}

describe('PostgreSQL automation ownership, reports, receipts and independent Worker', { skip: !source }, () => {
  before(async t => {
    assert.ok(source, 'TEST_DATABASE_URL is required for real PostgreSQL behavior tests');
    assertV3WorkerTestDatabase(source);
    database = await createMailFixtureDatabase({ signal: t.signal });
  }, { timeout: mailSchemaInitTimeout });
  after(async () => { await database?.close(); }, { timeout: 30_000 });

  it('creates drafts only; same-key concurrency/recovery, payload conflict and CAS never overwrite or duplicate', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const requestId = randomUUID(); const input = { requestId, config };
    const [first, replay] = await Promise.all([f.service.create(f.owner, f.workspaceId, input), f.service.create(f.owner, f.workspaceId, input)]);
    assert.deepEqual(first, replay); assert.equal(first.status, 'draft'); assert.equal(first.nextDueAt, null); assert.equal(first.lastRunAt, null);
    assert.equal((await f.service.runs(f.owner, f.workspaceId)).items.length, 0);
    await assert.rejects(f.service.create(f.owner, f.workspaceId, { requestId, config: { ...config, name: 'Different payload' } }), rejected('idempotency_conflict'));
    const writes = [randomUUID(), randomUUID()].map(key => f.service.update(f.owner, f.workspaceId, first.id, { requestId: key, expectedRevision: 1, config: { ...config, name: key } }));
    const results = await Promise.allSettled(writes);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && rejected('version_conflict')(result.reason)).length, 1);
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, requestId)).result, first);
    assert.deepEqual(await f.service.create(f.owner, f.workspaceId, input), first, 'Replay returns the original snapshot, not the latest rule');
    assert.equal((await f.pool.query('SELECT count(*)::text AS count FROM automation_rules')).rows[0].count, '1');
    const rejectedReceipt = (await f.pool.query("SELECT request_id FROM automation_receipts WHERE http_status=409")).rows[0];
    assert.ok(rejectedReceipt);
    const receipt = await f.service.receipt(f.owner, f.workspaceId, rejectedReceipt.request_id);
    assert.deepEqual(receipt.result, { error: { code: 'version_conflict', message: 'Automation rule changed; reload before deciding again' }, httpStatus: 409 });
  });

  it('preview observes real current tasks with ZERO SQL/file writes; overdue includes the whole due date and blocked uses current workflow', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const beforeSql = await sqlSnapshot(f.pool, f.schema), beforeFiles = await files(f.workspaceRoot);
    const all = await f.service.test(f.owner, f.workspaceId, config);
    assert.deepEqual(all.evidence.map(item => item.id), ['TASK-001', 'TASK-002']);
    const overdue = await f.service.test(f.owner, f.workspaceId, { ...config, condition: 'overdue' });
    assert.deepEqual(overdue.evidence.map(item => item.id), ['TASK-001']);
    const blocked = await f.service.test(f.owner, f.workspaceId, { ...config, condition: 'blocked' });
    assert.deepEqual(blocked.evidence.map(item => item.id), ['TASK-002']);
    assert.equal(all.evidence[0]?.due, '2020-01-01'); assert.ok(all.evidence[0]?.revision);
    assert.deepEqual(await sqlSnapshot(f.pool, f.schema), beforeSql); assert.deepEqual(await files(f.workspaceRoot), beforeFiles);
    assert.equal((await readdir(f.workspaceRoot)).includes('.pm'), false, 'Readonly port must not initialize state/cache');
    await writeFile(f.taskPath('TASK-001'), f.task('TASK-001', '', 'PRJ-001', 'done'));
    assert.equal((await f.service.test(f.owner, f.workspaceId, { ...config, condition: 'blocked' })).evidence.length, 0);
    await writeFile(f.taskPath('TASK-001'), f.task('TASK-001', 'due: 2024-01-02\n'));
    const boundary = { ...config, condition: 'overdue' as const };
    assert.equal((await observeAutomation(f.pool, f.core, f.owner, f.workspaceId, boundary, new Date('2024-01-02T15:59:59Z'))).evidence.length, 0);
    assert.equal((await observeAutomation(f.pool, f.core, f.owner, f.workspaceId, boundary, new Date('2024-01-02T16:00:00Z'))).evidence.length, 1);
  });

  it('follows a custom authoritative workflow and fails closed for malformed or hidden blocker sources', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    await mkdir(join(f.workspaceRoot, '.pm'));
    await writeFile(join(f.workspaceRoot, '.pm/config.yaml'), 'schema: pm/config/v1\nworkflows:\n  work_item:\n    initial: queued\n    states:\n      - {id: queued, label: Queued, category: unstarted}\n      - {id: shipped, label: Shipped, category: completed}\n    transitions:\n      - {from: queued, to: shipped}\ncustom_fields: []\n');
    await writeFile(f.taskPath('TASK-001'), f.task('TASK-001', '', 'PRJ-001', 'shipped'));
    await writeFile(f.taskPath('TASK-002'), f.task('TASK-002', 'blocked_by: [TASK-001]\n', 'PRJ-001', 'queued'));
    await writeFile(f.taskPath('TASK-003'), f.task('TASK-003', '', 'PRJ-001', 'shipped'));
    assert.deepEqual((await f.service.test(f.owner, f.workspaceId, config)).evidence.map(item => item.id), ['TASK-002']);
    assert.equal((await f.service.test(f.owner, f.workspaceId, { ...config, condition: 'blocked' })).evidence.length, 0);
    await f.pool.query('UPDATE memberships SET project_ids=$3,capabilities=$4 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['PRJ-001'], ['domain.read', 'planning.edit']]);
    await writeFile(f.taskPath('TASK-001'), f.task('TASK-001', '', 'PRJ-002', 'queued'));
    await assert.rejects(f.service.test(f.owner, f.workspaceId, { ...config, condition: 'blocked' }), rejected('automation_source_unavailable'));
    await writeFile(f.taskPath('TASK-002'), 'invalid markdown');
    await assert.rejects(f.service.test(f.owner, f.workspaceId, config), rejected('automation_source_unavailable'));
    assert.equal((await f.pool.query('SELECT count(*)::text AS count FROM automation_runs')).rows[0].count, '0');
  });

  it('real runs keep frozen input/evidence, delete retains history, PostgreSQL forbids history/receipt mutation', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const rule = await f.create(); const originalFiles = await files(f.workspaceRoot);
    const key = randomUUID(); const input = { requestId: key, expectedRevision: rule.revision };
    const run = await f.service.run(f.owner, f.workspaceId, rule.id, input);
    assert.equal(run.status, 'completed'); assert.equal(run.evidence.length, 2);
    assert.deepEqual(await f.service.run(f.owner, f.workspaceId, rule.id, input), run);
    assert.deepEqual((await f.service.receipt(f.owner, f.workspaceId, key)).result, run);
    const edited = await f.service.update(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: 1, config: { ...config, name: 'New name' } });
    assert.deepEqual(await f.service.detail(f.owner, f.workspaceId, run.id), run);
    await f.service.remove(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: edited.revision });
    assert.equal((await f.service.rules(f.owner, f.workspaceId)).items.length, 0);
    assert.deepEqual((await f.service.runs(f.owner, f.workspaceId, rule.id)).items, [run]);
    assert.deepEqual(await files(f.workspaceRoot), originalFiles);
    await assert.rejects(f.pool.query('UPDATE automation_runs SET run=run WHERE id=$1', [run.id]), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23514');
    await assert.rejects(f.pool.query('DELETE FROM automation_receipts WHERE request_id=$1', [key]), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23514');
    await rm(f.taskPath('TASK-002')); await rm(f.taskPath('TASK-001'));
    assert.deepEqual(await f.service.detail(f.owner, f.workspaceId, run.id), run, 'Deleted task sources retain authorized immutable evidence');
  });

  it('current membership, creator privacy, project scope and moved-source permissions gate rules/history/receipts', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const rule = await f.create(); const key = randomUUID();
    const run = await f.service.run(f.owner, f.workspaceId, rule.id, { requestId: key, expectedRevision: 1 });
    assert.equal((await f.service.rules(f.other, f.workspaceId)).items.length, 0);
    assert.equal((await f.service.runs(f.other, f.workspaceId)).items.length, 0);
    await assert.rejects(f.service.detail(f.other, f.workspaceId, run.id), rejected('not_found_or_forbidden'));
    await assert.rejects(f.service.receipt(f.other, f.workspaceId, key), rejected('not_found_or_forbidden'));
    await assert.rejects(f.service.run(f.other, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: 1 }), rejected('not_found_or_forbidden'));
    await f.pool.query('UPDATE memberships SET capabilities=$3,project_ids=$4 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['domain.read'], ['PRJ-001']]);
    assert.equal((await f.service.capabilities(f.owner, f.workspaceId)).canWrite, false);
    await assert.rejects(f.service.update(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: 1, config }), rejected('permission_denied'));
    await assert.rejects(f.create({ projectId: 'PRJ-002' }), rejected('not_found_or_forbidden'));
    await writeFile(f.taskPath('TASK-001'), f.task('TASK-001', '', 'PRJ-002'));
    assert.equal((await f.service.runs(f.owner, f.workspaceId)).items.length, 0);
    await assert.rejects(f.service.detail(f.owner, f.workspaceId, run.id), rejected('not_found_or_forbidden'));
    await assert.rejects(f.service.receipt(f.owner, f.workspaceId, key), rejected('not_found_or_forbidden'));
    await f.pool.query('UPDATE users SET disabled_at=clock_timestamp() WHERE id=$1', [f.owner.id]);
    await assert.rejects(f.service.rules(f.owner, f.workspaceId), rejected('not_found_or_forbidden'));
  });

  it('concurrent Workers deduplicate one due slot and an old generic heartbeat never advertises scheduler readiness', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    await recordHeartbeat(f.pool, 'legacy-worker', { state: 'running' });
    assert.equal((await f.service.capabilities(f.owner, f.workspaceId)).scheduler.ready, false);
    const draft = await f.create({ trigger: { ...config.trigger, kind: 'daily' } });
    const rule = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    assert.ok(rule.nextDueAt); assert.equal(rule.revision, 2); assert.equal(rule.lastRunAt, null);
    await f.due(rule, '2024-01-01T01:00:00Z'); const now = new Date('2024-01-01T01:00:01Z');
    const batches = await Promise.all([runAutomationBatch(f.pool, f.core, 'one', { now }), runAutomationBatch(f.pool, f.core, 'two', { now })]);
    assert.equal(batches.reduce((sum, batch) => sum + batch.processed, 0), 1);
    const runs = (await f.service.runs(f.owner, f.workspaceId)).items;
    assert.equal(runs.length, 1); assert.equal(runs[0]?.trigger, 'scheduled'); assert.equal(runs[0]?.status, 'completed');
    assert.equal((await f.service.capabilities(f.owner, f.workspaceId)).scheduler.ready, true);
    const refreshed = (await f.service.rules(f.owner, f.workspaceId)).items[0]!;
    assert.equal(refreshed.nextDueAt, '2024-01-02T01:00:00.000Z');
    await f.pool.query("UPDATE automation_scheduler_heartbeats SET heartbeat_at=clock_timestamp()-interval '30 seconds'");
    assert.equal((await f.service.capabilities(f.owner, f.workspaceId)).scheduler.ready, false);
    await f.service.setStatus(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: rule.revision, status: 'paused' });
    assert.equal((await runAutomationBatch(f.pool, f.core, 'paused', { now })).processed, 0);
  });

  it('Worker coalesces downtime, rechecks current creator permissions and reports failure without touching tasks', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const draft = await f.create({ trigger: { ...config.trigger, kind: 'daily' } });
    const rule = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    const originalFiles = await files(f.workspaceRoot);
    await f.due(rule, '2024-01-01T01:00:00Z'); const now = new Date('2024-01-10T02:00:00Z');
    assert.equal((await runAutomationBatch(f.pool, f.core, 'restarted', { now })).processed, 1);
    assert.equal((await runAutomationBatch(f.pool, f.core, 'restarted', { now })).processed, 0);
    const missed = (await f.service.runs(f.owner, f.workspaceId)).items[0]!;
    assert.equal(missed.status, 'skipped'); assert.equal(missed.reason, 'schedule_missed');
    assert.equal((await f.service.rules(f.owner, f.workspaceId)).items[0]?.nextDueAt, '2024-01-11T01:00:00.000Z');
    await f.pool.query('UPDATE memberships SET capabilities=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['domain.read']]);
    await f.due(rule, '2024-01-11T01:00:00Z');
    await runAutomationBatch(f.pool, f.core, 'revoked', { now: new Date('2024-01-11T01:00:01Z') });
    assert.ok((await f.service.runs(f.owner, f.workspaceId)).items.some(run => run.status === 'skipped' && run.reason === 'permission_denied' && run.evidence.length === 0));
    assert.deepEqual(await files(f.workspaceRoot), originalFiles);
    await f.pool.query('UPDATE memberships SET capabilities=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['domain.read', 'planning.edit']]);
    await writeFile(f.taskPath('TASK-001'), 'broken source');
    await f.due(rule, '2024-01-12T01:00:00Z');
    await runAutomationBatch(f.pool, f.core, 'invalid-source', { now: new Date('2024-01-12T01:00:01Z') });
    const failed = await f.pool.query<{ run: AutomationRun }>("SELECT run FROM automation_runs WHERE run->>'status'='failed'");
    assert.equal(failed.rows.length, 1); assert.equal(failed.rows[0]?.run.reason, 'automation_source_unavailable');
  });

  it('daily limits use local midnight, cooldown survives midnight and skipped attempts do not consume budgets', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const draft = await f.create({ dailyLimit: 1, trigger: { ...config.trigger, kind: 'daily' } });
    const rule = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    const runAt = async (due: string, now: string) => { await f.due(rule, due); await runAutomationBatch(f.pool, f.core, 'budget', { now: new Date(now) }); };
    await runAt('2024-01-01T01:00Z', '2024-01-01T01:00:01Z');
    await runAt('2024-01-01T15:59Z', '2024-01-01T15:59:01Z');
    await runAt('2024-01-01T16:00Z', '2024-01-01T16:00:01Z');
    const rows = (await f.pool.query<{ run: AutomationRun; budget_consumed: boolean }>('SELECT run,budget_consumed FROM automation_runs ORDER BY started_at')).rows;
    assert.deepEqual(rows.map(row => [row.run.status, row.run.reason, row.budget_consumed]), [['completed', null, true], ['skipped', 'daily_limit', false], ['completed', null, true]]);
    const secondDraft = await f.create({ cooldownMinutes: 60, trigger: { ...config.trigger, kind: 'daily' } });
    const second = await f.service.setStatus(f.owner, f.workspaceId, secondDraft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    await f.due(second, '2024-01-01T15:58Z'); await runAutomationBatch(f.pool, f.core, 'cooldown', { now: new Date('2024-01-01T15:58:01Z') });
    await f.due(second, '2024-01-01T16:01Z'); await runAutomationBatch(f.pool, f.core, 'cooldown', { now: new Date('2024-01-01T16:01:01Z') });
    const cooldown = (await f.pool.query<{ run: AutomationRun }>('SELECT run FROM automation_runs WHERE rule_id=$1 ORDER BY started_at', [second.id])).rows;
    assert.deepEqual(cooldown.map(row => [row.run.status, row.run.reason]), [['completed', null], ['skipped', 'cooldown']]);
  });

  it('pages newest-first history and advances empty authorization-filtered rule pages without duplicates', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const visible = await f.create({ dailyLimit: 100 });
    for (let index = 0; index < 51; index++) await f.create({ projectId: 'PRJ-002', name: `Private scope ${index}` });
    for (let index = 0; index < 51; index++) await f.service.run(f.owner, f.workspaceId, visible.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.pool.query('UPDATE memberships SET project_ids=$3,capabilities=$4 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner.id, ['PRJ-001'], ['domain.read', 'planning.edit']]);
    const first = await f.service.rules(f.owner, f.workspaceId);
    assert.equal(first.items.length, 0); assert.ok(first.nextCursor);
    const second = await f.service.rules(f.owner, f.workspaceId, first.nextCursor);
    assert.deepEqual(second.items.map(rule => rule.id), [visible.id]); assert.equal(second.nextCursor, null);
    const runs = await f.service.runs(f.owner, f.workspaceId, visible.id);
    assert.equal(runs.items.length, 50); assert.ok(runs.nextCursor);
    const older = await f.service.runs(f.owner, f.workspaceId, visible.id, runs.nextCursor);
    assert.equal(older.items.length, 1); assert.equal(older.nextCursor, null);
    const combined = [...runs.items, ...older.items];
    assert.equal(new Set(combined.map(run => run.id)).size, 51);
    for (let index = 1; index < combined.length; index++) assert.ok(combined[index - 1]!.startedAt >= combined[index]!.startedAt);
  });

  it('archived projects cannot enable or dispatch, but authorized owners can pause/delete rules and read old history', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const draft = await f.create({ trigger: { ...config.trigger, kind: 'daily' } });
    const rule = await f.service.setStatus(f.owner, f.workspaceId, draft.id, { requestId: randomUUID(), expectedRevision: 1, status: 'enabled' });
    await writeFile(join(f.workspaceRoot, 'projects/PRJ-001.md'), '---\nschema: pm/v1\nid: PRJ-001\nentity: project\nstatus: active\narchived: true\n---\n# Archived project\n');
    await f.due(rule, '2024-01-01T01:00:00Z');
    await runAutomationBatch(f.pool, f.core, 'archived-project', { now: new Date('2024-01-01T01:00:01Z') });
    const history = (await f.service.runs(f.owner, f.workspaceId)).items;
    assert.equal(history[0]?.status, 'skipped'); assert.equal(history[0]?.evidence.length, 0);
    await assert.rejects(f.service.setStatus(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: 2, status: 'enabled' }), rejected('not_found_or_forbidden'));
    const paused = await f.service.setStatus(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: 2, status: 'paused' });
    assert.equal(paused.nextDueAt, null);
    await f.service.remove(f.owner, f.workspaceId, rule.id, { requestId: randomUUID(), expectedRevision: paused.revision });
    assert.deepEqual((await f.service.runs(f.owner, f.workspaceId)).items, history);
  });

  it('HTTP registration uses current authenticated actor and strict frozen request bodies', { timeout: 60_000 }, async t => {
    const f = await fixture(t.signal); t.after(f.close);
    const app = f.scope.own(buildApp({ databaseUrl: f.databaseUrl, coreWorkspaceRoot: f.coreRoot, signal: f.scope.signal }), closeMailApp);
    const base = `/api/v1/workspaces/${f.workspaceId}/automations`;
    assert.equal((await app.inject({ method: 'GET', url: base + '/rules' })).statusCode, 401);
    const session = await login(f.pool, { email: f.owner.email, password: f.password });
    const headers = { authorization: `Bearer ${session.token}` };
    const saved = await app.inject({ method: 'POST', url: base + '/rules', headers, payload: { requestId: randomUUID(), config } });
    assert.equal(saved.statusCode, 200); const rule = saved.json<AutomationRule>();
    const invalid = await app.inject({ method: 'PUT', url: base + `/rules/${rule.id}`, headers, payload: { requestId: randomUUID(), config, actorId: f.other.id } });
    assert.equal(invalid.statusCode, 400);
    const preview = await app.inject({ method: 'POST', url: base + '/test', headers, payload: { config } });
    assert.equal(preview.statusCode, 200); assert.equal(preview.headers['cache-control'], 'no-store');
    const runKey = randomUUID(); const started = await app.inject({ method: 'POST', url: base + `/rules/${rule.id}/run`, headers, payload: { requestId: runKey, expectedRevision: rule.revision } });
    assert.equal(started.statusCode, 200); const run = started.json<AutomationRun>();
    const receipt = await app.inject({ method: 'GET', url: base + `/receipts/${runKey}`, headers });
    assert.deepEqual(receipt.json(), { requestId: runKey, result: run });
    assert.equal((await app.inject({ method: 'GET', url: base + `/runs/${run.id}`, headers })).statusCode, 200);
  });
});
