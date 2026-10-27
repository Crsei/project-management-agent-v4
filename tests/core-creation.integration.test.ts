import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/api/src/app.ts';
import { CoreCommandJournal } from '../apps/api/src/core-journal.ts';
import { requestHash } from '../packages/application/src/kernel.ts';
import type { Entity } from '../packages/domain/src/core.ts';
import { coreCreationAttemptSchema, type CoreCreationAttempt } from '../packages/contracts/src/core-creation.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import { Workspace } from '../packages/pm-core/index.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';

function nativeIdentity(workspaceId: string, actorId: string, key: string): string {
  return createHash('sha256').update(JSON.stringify([workspaceId, actorId, 'CreateCoreEntity', null, key])).digest('hex');
}

describe('authorized durable native creation outcomes', { skip: !dashboardDatabaseUrl, timeout: 240_000 }, () => {
  it('retains original identity/revision after source changes and deletion, never recreating the original', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Creation outcome project', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const base = `/api/v1/workspaces/${f.workspaceId}/core`;
    const key = randomUUID();
    const input = { entity: 'work_item', project: project.id, title: 'One durable native task', body: 'Original Markdown body', 'x-pm-start': '2026-10-21', due: '2026-10-23', labels: ['real'], 'x-pm-estimate': 0, 'x-pm-location': 'Room A' };
    const created = await f.request<FileRecord>(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: input });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const outcome = `${base}/creation-attempts/${key}`;
    const original = coreCreationAttemptSchema.parse((await f.request(outcome)).body);
    assert.equal(original.status, 'committed');
    if (original.status !== 'committed') throw new Error('Expected committed original');
    assert.equal(original.entityId, created.body.id);
    assert.equal(original.revision, created.body.revision);
    assert.equal(original.current.status, 'present');
    const changed = await f.request<FileRecord>(`${base}/entities/${created.body.id}`, { method: 'PATCH', body: { revision: created.body.revision, changes: { title: 'Changed after creation' } } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const later = coreCreationAttemptSchema.parse((await f.request(outcome)).body);
    assert.equal(later.status, 'committed');
    if (later.status !== 'committed' || later.current.status !== 'present') throw new Error('Expected current source');
    assert.equal(later.revision, created.body.revision);
    assert.equal(later.current.record.revision, changed.body.revision);
    const replay = await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: input });
    assert.equal(replay.status, 409);
    const conflicting = await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { ...input, title: 'Different intent' } });
    assert.equal(conflicting.status, 409);
    const archived = await f.request<FileRecord>(`${base}/entities/${created.body.id}/archive`, { method: 'POST', body: { revision: changed.body.revision } });
    assert.equal(archived.status, 200);
    assert.equal((await f.request(`${base}/entities/${created.body.id}`, { method: 'DELETE', body: { revision: archived.body.revision } })).status, 200);
    const deleted = coreCreationAttemptSchema.parse((await f.request(outcome)).body);
    assert.deepEqual(deleted, { status: 'committed', entityId: created.body.id, revision: created.body.revision, current: { status: 'deleted' } });
    assert.equal((await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: input })).status, 409);
    const files = await readdir(join(f.coreRoot, f.workspaceId, 'work-items'));
    assert.equal(files.filter(name => name.endsWith('.md')).length, 0);
    const commandReceipts = await f.pool.query('SELECT 1 FROM command_receipts WHERE command_id::text=$1', [nativeIdentity(f.workspaceId, f.owner.id, key)]);
    assert.equal(commandReceipts.rows.length, 0, 'A native outcome is never a PM command receipt');
  });

  it('GET remains read-only during SQL audit failure; explicit recovery commits the exact original audit once', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Audit recovery', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    await f.pool.query(`CREATE FUNCTION reject_creation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.source='core_http' THEN RAISE EXCEPTION 'injected creation audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_creation_audit BEFORE INSERT ON project_audit FOR EACH ROW EXECUTE FUNCTION reject_creation_audit()`);
    const base = `/api/v1/workspaces/${f.workspaceId}/core`, key = randomUUID();
    const failed = await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { entity: 'work_item', project: project.id, title: 'File committed before SQL' } });
    assert.equal(failed.status, 503);
    const stateFile = join(f.coreRoot, f.workspaceId, '.pm/state/state.json');
    const journalFile = join(f.coreRoot, f.workspaceId, '.pm/state/pm-command-journal.ndjson');
    const state = await readFile(stateFile, 'utf8'), journal = await readFile(journalFile, 'utf8');
    const endpoint = `${base}/creation-attempts/${key}`;
    assert.deepEqual((await f.request(endpoint)).body, { status: 'pending', reason: 'audit_pending' });
    assert.equal(await readFile(stateFile, 'utf8'), state);
    assert.equal(await readFile(journalFile, 'utf8'), journal);
    const commandId = nativeIdentity(f.workspaceId, f.owner.id, key);
    assert.equal((await f.pool.query('SELECT 1 FROM project_audit WHERE command_id=$1', [commandId])).rows.length, 0);
    await f.pool.query('DROP TRIGGER reject_creation_audit ON project_audit; DROP FUNCTION reject_creation_audit()');
    const creation = new CoreCommandJournal(join(f.coreRoot, f.workspaceId)).httpOutcome(commandId, f.owner.id);
    assert.equal(creation?.kind, 'http_completed');
    if (creation?.kind !== 'http_completed') throw new Error('Expected original durable file fact');
    const directory = join(f.coreRoot, f.workspaceId, 'work-items');
    const name = (await readdir(directory)).find(name => name.endsWith('.md'))!;
    const originalRaw = await readFile(join(directory, name), 'utf8');
    await writeFile(join(directory, name), originalRaw.replace('# File committed before SQL', '# External later title') + '\nA later external change must not become the creation audit snapshot.\n');
    const recovered = coreCreationAttemptSchema.parse((await f.request(`${endpoint}/recover`, { method: 'POST', body: {} })).body);
    assert.equal(recovered.status, 'committed');
    if (recovered.status !== 'committed' || recovered.current.status !== 'present') throw new Error('Expected current changed file');
    assert.equal(recovered.revision, creation.revision);
    assert.notEqual(recovered.current.record.revision, recovered.revision);
    assert.match(recovered.current.record.raw, /later external change/);
    assert.deepEqual((await f.request(`${endpoint}/recover`, { method: 'POST', body: {} })).body, recovered);
    assert.equal((await f.pool.query('SELECT 1 FROM project_audit WHERE command_id=$1', [commandId])).rows.length, 1);
    const audit = (await f.pool.query<{ after_version: string; changes: unknown }>('SELECT after_version,changes FROM project_audit WHERE command_id=$1', [commandId])).rows[0]!;
    assert.equal(audit.after_version, creation.revision);
    assert.match(JSON.stringify(audit.changes), /File committed before SQL/);
    assert.equal(JSON.stringify(audit.changes).includes('External later title'), false);
    assert.equal((await readdir(join(f.coreRoot, f.workspaceId, 'work-items'))).filter(name => name.endsWith('.md')).length, 1);
  });

  it('recovers a real process interruption after the file commit from the original durable journals after restart', async t => {
    const f = await createDashboardFixture();
    const restarted: { app?: FastifyInstance } = {};
    t.after(async () => { await restarted.app?.close(); await f.close(); });
    const project = await f.command<Entity>('CreateProject', { name: 'Crash project', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    await f.app.close();
    const key = randomUUID(), commandId = nativeIdentity(f.workspaceId, f.owner.id, key);
    const input = { entity: 'work_item', project: project.id, title: 'Crash-created task', body: 'Never match this title to recover' };
    const script = `
      import { writeSync } from 'node:fs';
      import { Workspace } from './packages/pm-core/index.ts';
      import { requestHash as inputHash } from './packages/pm-core/state.ts';
      import { requestHash } from './packages/application/src/kernel.ts';
      import { CoreCommandJournal } from './apps/api/src/core-journal.ts';
      import { coreProjectAuditWrites } from './apps/api/src/core-adapter.ts';
      const data=JSON.parse(process.argv[1]);
      const workspace=new Workspace(data.root); await workspace.init();
      const journal=new CoreCommandJournal(data.root);
      const hash=requestHash({action:'CreateCoreEntity',targetId:undefined,input:data.input});
      let creation={coreKey:'native:'+data.commandId,inputHash:inputHash(data.input),scopeProjectIds:[data.input.project]};
      journal.pendingHttp(data.commandId,hash,data.actorId,creation);
      const result=await workspace.createEntity(data.input,creation.coreKey,undefined,record=>{
        const audit=coreProjectAuditWrites(undefined,record,{source:'core_http',commandId:data.commandId,action:'CreateCoreEntity',actorId:data.actorId,occurredAt:new Date().toISOString()});
        creation={...creation,prepared:{targetId:record.id,revision:record.revision,audit}};
        journal.pendingHttp(data.commandId,hash,data.actorId,creation);
      });
      writeSync(1,JSON.stringify({id:result.id,revision:result.revision}));
      process.exit(73);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify({ root: join(f.coreRoot, f.workspaceId), actorId: f.owner.id, commandId, input })], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 73, child.stderr);
    const original = JSON.parse(child.stdout) as { id: string; revision: string };
    const blobRoot = join(dirname(f.coreRoot), 'blobs');
    restarted.app = buildApp({ databaseUrl: f.pool.options.connectionString!, blobStore: new LocalBlobStore(blobRoot), blobStorageLocator: { provider: 'local', root: blobRoot }, coreWorkspaceRoot: f.coreRoot });
    const origin = await restarted.app.listen({ host: '127.0.0.1', port: 0 });
    const endpoint = `${origin}/api/v1/workspaces/${f.workspaceId}/core/creation-attempts/${key}`;
    const before = await fetch(endpoint, { headers: { cookie: f.ownerCookie } });
    assert.deepEqual(await before.json(), { status: 'pending', reason: 'audit_pending' });
    const response = await fetch(`${endpoint}/recover`, { method: 'POST', headers: { cookie: f.ownerCookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const recovered = coreCreationAttemptSchema.parse(await response.json());
    assert.equal(recovered.status, 'committed');
    if (recovered.status !== 'committed') throw new Error('Expected committed recovery');
    assert.equal(recovered.entityId, original.id);
    assert.equal(recovered.revision, original.revision);
    assert.equal((await f.pool.query('SELECT 1 FROM project_audit WHERE command_id=$1', [commandId])).rows.length, 1);
    assert.equal((await readdir(join(f.coreRoot, f.workspaceId, 'work-items'))).filter(name => name.endsWith('.md')).length, 1);
  });

  it('does not report a changed historical creation as the original successful revision', async t => {
    const f = await createDashboardFixture();
    const restarted: { app?: FastifyInstance } = {};
    t.after(async () => { await restarted.app?.close(); await f.close(); });
    const project = await f.command<Entity>('CreateProject', { name: 'Historical creation', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    await f.app.close();
    const workspace = new Workspace(join(f.coreRoot, f.workspaceId));
    const key = randomUUID(), input = { entity: 'work_item', project: project.id, title: 'Historical original' };
    let changed: FileRecord;
    await workspace.init();
    try {
      const original = await workspace.createEntity(input, key);
      changed = await workspace.patch(original.id, { title: 'A later historical edit' }, original.revision);
    } finally { await workspace.close(); }
    const blobRoot = join(dirname(f.coreRoot), 'blobs');
    restarted.app = buildApp({ databaseUrl: f.pool.options.connectionString!, blobStore: new LocalBlobStore(blobRoot), blobStorageLocator: { provider: 'local', root: blobRoot }, coreWorkspaceRoot: f.coreRoot });
    const origin = await restarted.app.listen({ host: '127.0.0.1', port: 0 });
    const endpoint = `${origin}/api/v1/workspaces/${f.workspaceId}/core`;
    const response = await fetch(`${endpoint}/entities`, { method: 'POST', headers: { cookie: f.ownerCookie, 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
    assert.equal(response.status, 409, JSON.stringify(await response.json()));
    const current = await fetch(`${endpoint}/files/${changed.id}`, { headers: { cookie: f.ownerCookie } });
    assert.equal((await current.json() as FileRecord).revision, changed.revision);
    assert.equal((await readdir(join(f.coreRoot, f.workspaceId, 'work-items'))).filter(name => name.endsWith('.md')).length, 1);
  });

  it('keeps historical ambiguous pending blocked and preserves the journal; rejects invalid assignments durably', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'Ambiguous pending', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const root = join(f.coreRoot, f.workspaceId), base = `/api/v1/workspaces/${f.workspaceId}/core`;
    const key = randomUUID(), input = { entity: 'work_item', title: 'Ambiguous', project: project.id };
    const journal = new CoreCommandJournal(root);
    journal.pendingHttp(nativeIdentity(f.workspaceId, f.owner.id, key), requestHash({ action: 'CreateCoreEntity', targetId: undefined, input }), f.owner.id);
    const journalFile = join(root, '.pm/state/pm-command-journal.ndjson'), historical = await readFile(journalFile, 'utf8');
    const outcome = `${base}/creation-attempts/${key}`;
    assert.deepEqual((await f.request(outcome)).body, { status: 'pending', reason: 'write_unconfirmed' });
    assert.deepEqual((await f.request(`${outcome}/recover`, { method: 'POST', body: {} })).body, { status: 'pending', reason: 'write_unconfirmed' });
    assert.equal(await readFile(journalFile, 'utf8'), historical);
    assert.equal((await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: input })).status, 409);
    const invalidKey = randomUUID();
    const invalid = await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': invalidKey }, body: { ...input, assignee: randomUUID() } });
    assert.equal(invalid.status, 409);
    assert.deepEqual((await f.request(`${base}/creation-attempts/${invalidKey}`)).body, { status: 'rejected' });
    assert.equal((await f.request(`${base}/entities`, { method: 'POST', headers: { 'Idempotency-Key': invalidKey }, body: input })).status, 409);
    const items = await f.request<{ items: FileRecord[] }>(`${base}/items`);
    assert.equal(items.body.items.filter(file => file.entity.entity === 'work_item').length, 0);
  });

  it('isolates actor keys, denies revoked/project-hidden outcomes, and applies task policy to source/PATCH/items', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const p1 = await f.command<Entity>('CreateProject', { name: 'Allowed', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const p2 = await f.command<Entity>('CreateProject', { name: 'Hidden', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const member = await f.member('Scoped creator');
    const capabilities = ['domain.read', 'planning.edit'];
    const granted = await f.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities, projectIds: [p1.id] });
    const base = `/api/v1/workspaces/${f.workspaceId}/core`, key = randomUUID();
    const created = await f.request<FileRecord>(`${base}/entities`, { method: 'POST', cookie: member.cookie, headers: { 'Idempotency-Key': key }, body: { entity: 'work_item', project: p1.id, title: 'Actor-private request key' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const outcome = `${base}/creation-attempts/${key}`;
    assert.deepEqual((await f.request(outcome)).body, { status: 'not_found' }, 'Even admins do not read another actor creation key');
    const known = await f.request<CoreCreationAttempt>(outcome, { cookie: member.cookie });
    assert.equal(known.body.status, 'committed');
    const invalidAssignee = await f.request(`${base}/entities/${created.body.id}`, { method: 'PATCH', cookie: member.cookie, body: { revision: created.body.revision, changes: { assignee: randomUUID() } } });
    assert.equal(invalidAssignee.status, 409);
    const source = created.body.raw.replace(`project: ${p1.id}`, `project: ${p2.id}`);
    const deniedSource = await f.request(`${base}/files/${created.body.id}`, { method: 'PUT', cookie: member.cookie, body: { revision: created.body.revision, raw: source } });
    assert.equal(deniedSource.status, 404);
    const deniedItems = await f.request(`${base}/items`, { method: 'POST', cookie: member.cookie, body: { title: 'No bypass', project: p1.id, assignee: randomUUID() } });
    assert.equal(deniedItems.status, 409);
    const moved = await f.command<{ version: number }>('SetWorkspaceMember', { userId: member.user.id, capabilities, projectIds: [p2.id] },
      { extra: { targetId: member.user.id, expectedVersions: { [member.user.id]: granted.version } } });
    const hidden = await f.request(outcome, { cookie: member.cookie });
    assert.equal(hidden.status, 404);
    assert.equal(JSON.stringify(hidden.body).includes(created.body.id), false);
    assert.equal((await f.request(`${outcome}/recover`, { method: 'POST', cookie: member.cookie, body: {} })).status, 404);
    await f.command('RevokeWorkspaceMember', { userId: member.user.id },
      { extra: { targetId: member.user.id, expectedVersions: { [member.user.id]: moved.version } } });
    assert.equal((await f.request(outcome, { cookie: member.cookie })).status, 404);
    assert.equal((await f.request(`${outcome}/recover`, { method: 'POST', cookie: member.cookie, body: {} })).status, 404);
  });

  it('uses configured task state capability without granting ordinary edits or losing checklist authority', async t => {
    const f = await createDashboardFixture();
    t.after(() => f.close());
    const project = await f.command<Entity>('CreateProject', { name: 'State capability', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const member = await f.member('Complete only');
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'workitem.complete'], projectIds: [project.id] });
    const base = `/api/v1/workspaces/${f.workspaceId}/core`;
    const created = await f.request<FileRecord>(`${base}/entities`, { method: 'POST', body: { entity: 'work_item', project: project.id, title: 'Checklist completion', body: '- [ ] A human acceptance item remains unchecked' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const completed = await f.request<FileRecord>(`${base}/entities/${created.body.id}`, { method: 'PATCH', cookie: member.cookie,
      body: { revision: created.body.revision, changes: { status: 'done' } } });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.entity.status, 'done');
    assert.equal(completed.body.entity.checklist[0]?.checked, false);
    const title = await f.request(`${base}/entities/${created.body.id}`, { method: 'PATCH', cookie: member.cookie,
      body: { revision: completed.body.revision, changes: { title: 'Not authorized by completion capability' } } });
    assert.equal(title.status, 403);
    const source = await f.request(`${base}/files/${created.body.id}`, { method: 'PUT', cookie: member.cookie,
      body: { revision: completed.body.revision, raw: completed.body.raw + '\n<!-- A formatting-only source write -->\n' } });
    assert.equal(source.status, 403, 'Raw source still requires planning.edit even when parsed business fields are unchanged');
  });
});
