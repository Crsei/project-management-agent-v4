import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { DomainError, type Command, type Entity } from '../packages/domain/src/core.ts';
import type { ProjectAuditPage } from '../packages/domain/src/project-audit.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { runCommand } from '../packages/application/src/kernel.ts';
import { insertDashboardRecord } from '../packages/application/src/dashboard-store.ts';
import type { CommandRegistry } from '../packages/application/src/ports.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';

function command(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command {
  return { commandId: randomUUID(), commandType, payload, ...extra };
}

describe('immutable authorized project business audit', { skip: !dashboardDatabaseUrl, timeout: 240_000 }, () => {
  it('validates nonempty restored audit rows with an empty search_path and keeps the field whitelist', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const sql = await f.pool.connect();
    try {
      const schema = (await sql.query<{ name: string }>('SELECT quote_ident(current_schema()) AS name')).rows[0]!.name;
      await sql.query('BEGIN');
      await sql.query("SET LOCAL search_path = ''");
      const insert = `INSERT INTO ${schema}.project_audit
        (workspace_id,project_id,source,command_id,action,actor_id,target_id,target_kind,changes,dedupe_key)
        VALUES($1,'PRJ-001','core_http',$2,'UpdateCoreProperties',$3,'PRJ-001','project',$4,$2) RETURNING changes`;
      const changes = [{ field: 'title', before: 'Before restore', after: 'After restore' }];
      const restored = await sql.query<{ changes: unknown }>(insert, [f.workspaceId, randomUUID(), f.owner.id, JSON.stringify(changes)]);
      assert.deepEqual(restored.rows[0]!.changes, changes);
      await assert.rejects(
        sql.query(insert, [f.workspaceId, randomUUID(), f.owner.id, JSON.stringify([{ field: 'password', before: null, after: 'must not be retained' }])]),
        (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23514',
      );
    } finally { await sql.query('ROLLBACK'); sql.release(); }
  });

  it('rolls captured SQL changes back with a rejected command and never promotes its replay to success', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Atomic audit', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    let reject = true;
    const registry: CommandRegistry = {
      AuditAtomicityProbe: {
        payload: z.object({}).strict(),
        async handler(ctx) {
          await ctx.require('planning.edit', project.id);
          const row = await insertDashboardRecord(ctx, { kind: 'project_scope', projectId: project.id, data: { items: [] } });
          if (reject) throw new DomainError('probe_rejected', 'Reject after a real row change', 409);
          return row;
        },
      },
    };
    const input = command('AuditAtomicityProbe', {}, { projectId: project.id });
    const first = await runCommand(f.pool, f.owner, f.workspaceId, input, registry);
    assert.equal(first.status, 'rejected');
    assert.equal(first.error?.code, 'probe_rejected');
    assert.equal((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM project_audit WHERE command_id=$1', [input.commandId])).rows[0]!.count, '0');
    assert.equal((await f.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM dashboard_records WHERE workspace_id=$1 AND kind='project_scope'", [f.workspaceId])).rows[0]!.count, '0');
    reject = false;
    assert.deepEqual(await runCommand(f.pool, f.owner, f.workspaceId, input, registry), first, 'A changed handler cannot turn the original rejection into a success');
    const next = { ...input, commandId: randomUUID() };
    assert.equal((await runCommand(f.pool, f.owner, f.workspaceId, next, registry)).status, 'committed');
    assert.equal((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM project_audit WHERE command_id=$1', [next.commandId])).rows[0]!.count, '1');
  });

  it('recovers a completed Markdown command after SQL audit failure without a second write or duplicate history', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Before durable recovery', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const input = command('UpdateProject', { name: 'After durable recovery', goal: '', ownerId: f.owner.id, completionCriteria: [] }, { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } });
    await f.pool.query(`CREATE FUNCTION reject_one_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.command_id='${input.commandId}' THEN RAISE EXCEPTION 'injected audit persistence failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_one_audit BEFORE INSERT ON project_audit FOR EACH ROW EXECUTE FUNCTION reject_one_audit()`);
    const failure = await f.send(input);
    assert.ok(failure.status >= 500, JSON.stringify(failure.body));
    assert.equal((await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM command_receipts WHERE command_id=$1', [input.commandId])).rows[0]!.count, '0', 'Audit and SQL receipt share one transaction');
    const source = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${project.id}`);
    assert.equal(source.status, 200);
    assert.equal(source.body.entity.title, 'After durable recovery', 'The file was committed even though SQL failed');
    const revision = source.body.revision;
    await f.pool.query('DROP TRIGGER reject_one_audit ON project_audit; DROP FUNCTION reject_one_audit()');
    const recovered = await f.send(input);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.status, 'committed');
    assert.deepEqual((await f.send(input)).body, recovered.body);
    const current = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${project.id}`);
    assert.equal(current.body.revision, revision, 'Recovery does not repeat the Markdown write');
    const rows = await f.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM project_audit WHERE command_id=$1', [input.commandId]);
    assert.equal(rows.rows[0]!.count, '1');
    const audit = await f.request<ProjectAuditPage>(`/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/audit`);
    const entry = audit.body.entries.find(row => row.commandId === input.commandId);
    assert.ok(entry);
    assert.equal(entry.actorId, f.owner.id);
    assert.equal(entry.afterVersion, revision);
    assert.ok(entry.changes.some(change => change.field === 'title' && change.before === 'Before durable recovery' && change.after === 'After durable recovery'));
  });

  it('journals native property/source edits safely and recovers their SQL uncertainty with exact-request replay', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Native audit', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const task = await f.command<Entity>('CreateWorkItem', { title: 'Native task', description: '', acceptanceCriteria: [], priority: 'low', assigneeId: null }, { extra: { projectId: project.id } });
    const filePath = `/api/v1/workspaces/${f.workspaceId}/core/files/${task.id}`;
    const entityPath = `/api/v1/workspaces/${f.workspaceId}/core/entities/${task.id}`;
    const before = await f.request<FileRecord>(filePath);
    const input = { changes: { priority: 'high' }, revision: before.body.revision };
    await f.pool.query(`CREATE FUNCTION reject_native_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.source='core_http' THEN RAISE EXCEPTION 'injected native audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_native_audit BEFORE INSERT ON project_audit FOR EACH ROW EXECUTE FUNCTION reject_native_audit()`);
    const failure = await f.request<{ error: { code: string } }>(entityPath, { method: 'PATCH', body: input });
    assert.equal(failure.status, 503, JSON.stringify(failure.body));
    assert.equal(failure.body.error.code, 'core_audit_pending');
    const committedFile = await f.request<FileRecord>(filePath);
    assert.equal(committedFile.body.entity.priority, 'high');
    await f.pool.query('DROP TRIGGER reject_native_audit ON project_audit; DROP FUNCTION reject_native_audit()');
    const recovered = await f.request<FileRecord>(entityPath, { method: 'PATCH', body: input });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.revision, committedFile.body.revision);
    assert.equal((await f.request<FileRecord>(entityPath, { method: 'PATCH', body: input })).body.revision, committedFile.body.revision);
    const secret = `NATIVE-SOURCE-SECRET-${randomUUID()}`;
    const sourceInput = { raw: `${recovered.body.raw}\n${secret}\n`, revision: recovered.body.revision };
    const source = await f.request<FileRecord>(filePath, { method: 'PUT', body: sourceInput });
    assert.equal(source.status, 200, JSON.stringify(source.body));
    const rejected = await f.request(entityPath, { method: 'PATCH', body: { changes: { priority: 'low' }, revision: before.body.revision } });
    assert.equal(rejected.status, 409);
    const audit = await f.request<ProjectAuditPage>(`/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/audit?limit=100`);
    const native = audit.body.entries.filter(row => row.source === 'core_http');
    assert.equal(native.filter(row => row.action === 'UpdateCoreProperties').length, 1, 'Native recovery and rejected stale writes do not duplicate success');
    const metadata = native.find(row => row.action === 'UpdateCoreProperties')!;
    assert.equal(metadata.beforeVersion, before.body.revision);
    assert.equal(metadata.afterVersion, committedFile.body.revision);
    assert.deepEqual(metadata.changes, [{ field: 'priority', before: 'low', after: 'high' }]);
    assert.equal(native.filter(row => row.action === 'UpdateCoreSource').length, 1);
    assert.equal(JSON.stringify(audit.body).includes(secret), false);
  });

  it('does not attribute external filesystem edits or a stale refused API command to an authenticated actor', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'External source baseline', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const path = `/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/audit`;
    const initial = await f.request<ProjectAuditPage>(path);
    const source = await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${project.id}`);
    const externalText = `EXTERNAL-UNATTRIBUTED-${randomUUID()}`;
    await writeFile(join(f.coreRoot, f.workspaceId, source.body.path), `${source.body.raw}\n${externalText}\n`);
    const stale = command('UpdateProject', { name: 'Must not overwrite external source', goal: '', ownerId: f.owner.id, completionCriteria: [] },
      { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } });
    const refused = await f.send(stale);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.status, 'rejected');
    const history = await f.request<ProjectAuditPage>(path);
    assert.deepEqual(history.body.entries, initial.body.entries, 'A watcher observation is not an authenticated business write');
    assert.equal(JSON.stringify(history.body).includes(externalText), false);
  });

  it('filters private actors before pagination, excludes prose, and preserves immutable history after later edits', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    // Cross a decimal-width boundary: the text DTO ID must never determine SQL order.
    await f.pool.query("SELECT setval(pg_get_serial_sequence('project_audit','id'),98,false)");
    const project = await f.command<Entity>('CreateProject', { name: 'Mixed privacy audit', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const reader = await f.member('Auditor');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read', 'audit.read'], projectIds: [project.id] });
    const ownerFavorite = command('SetProjectFavorite', { favorite: true }, { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } });
    assert.equal((await f.send(ownerFavorite)).status, 200);
    const secret = `SCOPE-NOTE-SECRET-${randomUUID()}`;
    const scope = await f.command<{ id: string; version: number }>('SetProjectScope', { items: [{ id: randomUUID(), text: secret, completed: false }] }, { extra: { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } } });
    const readerFavorite = command('SetProjectFavorite', { favorite: true }, { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version } });
    assert.equal((await f.send(readerFavorite, { cookie: reader.cookie })).status, 200);
    const path = `/api/v1/workspaces/${f.workspaceId}/projects/${project.id}/audit`;
    const visible = await f.request<ProjectAuditPage>(`${path}?limit=100`, { cookie: reader.cookie });
    assert.equal(visible.status, 200);
    assert.equal(visible.body.entries[0]?.commandId, readerFavorite.commandId, 'Newest numeric sequence sorts before earlier two-digit IDs');
    assert.equal(visible.body.entries.some(row => row.commandId === ownerFavorite.commandId), false);
    assert.equal(visible.body.entries.find(row => row.commandId === readerFavorite.commandId)?.private, true);
    const owner = await f.request<ProjectAuditPage>(`${path}?limit=100`);
    assert.equal(owner.body.entries.some(row => row.commandId === readerFavorite.commandId), false);
    assert.equal(owner.body.entries.find(row => row.commandId === ownerFavorite.commandId)?.private, true);
    assert.equal(JSON.stringify(visible.body).includes(secret), false);
    const first = await f.request<ProjectAuditPage>(`${path}?limit=1`, { cookie: reader.cookie });
    const entries = [...first.body.entries];
    let cursor = first.body.nextCursor;
    while (cursor) {
      const page = await f.request<ProjectAuditPage>(`${path}?limit=1&cursor=${encodeURIComponent(cursor)}`, { cookie: reader.cookie });
      assert.equal(page.status, 200);
      entries.push(...page.body.entries);
      cursor = page.body.nextCursor;
    }
    assert.deepEqual(entries.map(row => row.id), visible.body.entries.map(row => row.id), 'Private rows cannot create gaps, empty pages, or cursor leaks');
    const history = JSON.stringify(visible.body.entries);
    await f.command('SetProjectScope', { items: [] }, { extra: { targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version, [scope.id]: scope.version } } });
    const later = await f.request<ProjectAuditPage>(`${path}?limit=100`, { cookie: reader.cookie });
    assert.equal(JSON.stringify(later.body.entries.filter(row => visible.body.entries.some(old => old.id === row.id))), history, 'Later changes cannot rewrite original actors, diffs, versions, or times');
    const id = visible.body.entries[0]!.id;
    for (const statement of ['UPDATE project_audit SET action=\'tampered\' WHERE id=$1', 'DELETE FROM project_audit WHERE id=$1']) {
      await assert.rejects(f.pool.query(statement, [id]), error => typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'project_audit_immutable');
    }
    await assert.rejects(f.pool.query('TRUNCATE project_audit'), error => typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'project_audit_immutable');
    const forged = Buffer.from(JSON.stringify({ workspaceId: f.workspaceId, projectId: project.id, actorId: reader.user.id, through: '999999999999999999999999999999', before: '1' })).toString('base64url');
    assert.equal((await f.request(`${path}?cursor=${forged}`, { cookie: reader.cookie })).status, 400, 'A forged bigint cannot overflow the SQL cursor');
  });
});
