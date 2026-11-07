import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { changeDetailSchema, changeHistoryPageSchema, type ChangeDetail, type ChangeHistoryPage, type ChangeHistoryTarget } from '../packages/contracts/src/change-history.ts';
import type { DocumentSourceMutation, DocumentSourceMutationReceipt } from '../packages/contracts/src/document-sources.ts';
import { createLocalProjectFixture, localProjectCaseTimeout, localProjectEventually, type LocalProjectFixture } from './local-project-fixture.ts';
import { assertDocumentSourceFailure, assertPrivateDocumentResponse, collectDocumentFiles, configureDocumentSource, configureDocumentSources, createDocumentProject, documentSourceOperationsPath, documentSourcesPath, mutateDocumentSource, readDocumentSourceMutation, readSourceContent } from './document-sources-fixture.ts';

const external = (sourceId: string, path: string): ChangeHistoryTarget => ({ kind: 'external', sourceId, path });
const historyBase = (f: LocalProjectFixture): string => `/api/v1/workspaces/${f.workspaceId}/change-history`;
async function history(f: LocalProjectFixture, sourceId: string, path: string, cookie?: string): Promise<ChangeHistoryPage> {
  const response = await f.request<ChangeHistoryPage>(`${historyBase(f)}/query`, { method: 'POST', body: { target: external(sourceId, path) }, ...(cookie ? { cookie } : {}) });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assertPrivateDocumentResponse(response);
  assert.equal(JSON.stringify(response.body).includes(f.root), false, 'History identities and summaries never expose host paths');
  return changeHistoryPageSchema.parse(response.body);
}
async function detail(f: LocalProjectFixture, changeId: string, cookie?: string): Promise<ChangeDetail> {
  const response = await f.request<ChangeDetail>(`${historyBase(f)}/${changeId}`, cookie ? { cookie } : {});
  assert.equal(response.status, 200, JSON.stringify(response.body)); assertPrivateDocumentResponse(response);
  return changeDetailSchema.parse(response.body);
}

// Real isolated PostgreSQL, HTTP, current authorization and protected journal bytes.
describe('external Markdown change history', { concurrency: 1 }, () => {
  it('establishes a baseline, captures only observed endpoints with unknown author, and never infers deletion from missing or incomplete scans', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const root = join(f.parents[1], 'observed-history'); await mkdir(root);
    const first = '# First observed bytes\r\nOriginal external source.\r\n';
    await writeFile(join(root, 'observed.md'), first);
    const source = await configureDocumentSource(f, null, root, 0);
    await readSourceContent(f, source.sourceId, 'observed.md');
    const baseline = await history(f, source.sourceId, 'observed.md');
    assert.equal(baseline.items.length, 1); assert.equal(baseline.items[0]!.completeness, 'baseline');
    assert.deepEqual(baseline.items[0]!.changeKinds, []); assert.equal(baseline.pendingCount, 0);
    const baselineBytes = await detail(f, baseline.items[0]!.changeId);
    assert.equal(baselineBytes.before, null); assert.equal(baselineBytes.after!.raw, first);
    await writeFile(join(root, 'observed.md'), '# Unobserved intermediate content\n');
    const last = '# Last observed bytes\nNo invented intermediate save or author.\n';
    await writeFile(join(root, 'observed.md'), last);
    await readSourceContent(f, source.sourceId, 'observed.md');
    const changed = await history(f, source.sourceId, 'observed.md');
    assert.equal(changed.items.length, 2); assert.equal(changed.pendingCount, 1);
    const item = changed.items[0]!; assert.equal(item.completeness, 'observed_endpoints');
    assert.equal(item.origin, 'observation'); assert.equal(item.actorId, null); assert.equal(item.occurredAt, null);
    const bytes = await detail(f, item.changeId);
    assert.equal(bytes.before!.raw, first); assert.equal(bytes.after!.raw, last);
    await readSourceContent(f, source.sourceId, 'observed.md');
    assert.equal((await history(f, source.sourceId, 'observed.md')).items.length, 2, 'A repeated read is not another change');
    await rm(join(root, 'observed.md')); await mkdir(join(root, '.git'));
    const scan = await collectDocumentFiles(f, source.sourceId);
    assert.equal(scan.scanComplete, false); assert.deepEqual(scan.entries, []);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, source.sourceId)}/content?path=observed.md`), [404]);
    const retained = await history(f, source.sourceId, 'observed.md');
    assert.deepEqual(retained.items.map(value => value.changeId), changed.items.map(value => value.changeId));
    assert.equal((await detail(f, item.changeId)).after!.raw, last, 'Deleted paths remain diffable while their current source is authorized');
  });

  it('captures exact create/save/move/delete endpoints and keeps a proven moved stream stable when old operations are reconciled', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const a = await createDocumentProject(f, 'History source project', 'history-source-project');
    const b = await createDocumentProject(f, 'History destination project', 'history-destination-project');
    const root = join(f.parents[1], 'controlled-source'), destination = join(f.parents[1], 'controlled-destination');
    await mkdir(root); await mkdir(destination);
    const source = await configureDocumentSource(f, a.record.id, root, 0), target = await configureDocumentSource(f, b.record.id, destination, 0);
    const first = '# Controlled create\r\nExact original bytes.\r\n', second = '# Controlled edit\nExact saved bytes.\n';
    const create: DocumentSourceMutation = { operationId: randomUUID(), action: 'create', path: 'created.md', sourceRevision: source.revision, content: first };
    const created = await mutateDocumentSource(f, source.sourceId, create);
    const save: DocumentSourceMutation = { operationId: randomUUID(), action: 'save', path: create.path, sourceRevision: source.revision, expectedRevision: created.content!.revision, content: second };
    const saved = await mutateDocumentSource(f, source.sourceId, save);
    const stale = { ...save, operationId: randomUUID(), content: '# A rejected stale save must not enter history\n' };
    assertDocumentSourceFailure(await f.request(documentSourceOperationsPath(f, source.sourceId), { method: 'POST', body: stale }), [409], 'document_source_file_revision_conflict');
    assert.equal((await readDocumentSourceMutation(f, source.sourceId, stale.operationId)).status, 'not_applied');
    assert.equal((await history(f, source.sourceId, create.path)).items.length, 2);
    const rename: DocumentSourceMutation = { operationId: randomUUID(), action: 'move', path: create.path, sourceRevision: source.revision, expectedRevision: saved.content!.revision, targetSourceId: source.sourceId, targetSourceRevision: source.revision, targetPath: 'renamed.md' };
    const renamed = await mutateDocumentSource(f, source.sourceId, rename);
    const move: DocumentSourceMutation = { operationId: randomUUID(), action: 'move', path: rename.targetPath, sourceRevision: source.revision, expectedRevision: renamed.content!.revision, targetSourceId: target.sourceId, targetSourceRevision: target.revision, targetPath: 'moved/final.md' };
    const moved = await mutateDocumentSource(f, source.sourceId, move);
    const remove: DocumentSourceMutation = { operationId: randomUUID(), action: 'delete', path: move.targetPath, sourceRevision: target.revision, expectedRevision: moved.content!.revision };
    await mutateDocumentSource(f, target.sourceId, remove);
    const original = await history(f, target.sourceId, move.targetPath);
    assert.equal(original.items.length, 5); assert.ok(original.items.every(item => item.completeness === 'exact'));
    const endpoints = await Promise.all(original.items.map(item => detail(f, item.changeId)));
    assert.equal(endpoints[0]!.before!.raw, second); assert.equal(endpoints[0]!.after, null);
    assert.equal(endpoints[1]!.before!.raw, second); assert.equal(endpoints[1]!.after!.raw, second);
    assert.equal(endpoints[3]!.before!.raw, first); assert.equal(endpoints[3]!.after!.raw, second);
    assert.equal(endpoints[4]!.before, null); assert.equal(endpoints[4]!.after!.raw, first);
    await f.restartApi();
    for (const input of [create, save, rename, move]) assert.equal((await readDocumentSourceMutation(f, source.sourceId, input.operationId)).status, 'succeeded');
    assert.equal((await readDocumentSourceMutation(f, target.sourceId, remove.operationId)).status, 'succeeded');
    assert.deepEqual((await history(f, target.sourceId, move.targetPath)).items.map(item => item.changeId), original.items.map(item => item.changeId));
    assert.deepEqual((await history(f, source.sourceId, create.path)).items.map(item => item.changeId), original.items.map(item => item.changeId));
    await assert.rejects(lstat(join(root, create.path)), { code: 'ENOENT' }); await assert.rejects(lstat(join(destination, move.targetPath)), { code: 'ENOENT' });
    const reader = await f.member('Source-only history reader');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [a.record.id] });
    const denied = await f.request(`${historyBase(f)}/query`, { method: 'POST', body: { target: external(source.sourceId, create.path) }, cookie: reader.cookie });
    assertDocumentSourceFailure(denied, [403, 404]);
    assert.equal(JSON.stringify(denied.body).includes(second), false, 'Old aliases cannot disclose a currently unauthorized move destination');
  });

  it('recovers the original protected before/after history after SQL persistence failure without reading or replaying a later disk edit', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const root = join(f.parents[1], 'recover-history'); await mkdir(root);
    const before = '# Before the original mutation\r\n', after = '# Exact committed original save\n', later = '# A later external edit must not become the original snapshot\n';
    await writeFile(join(root, 'capture.md'), before);
    const source = await configureDocumentSource(f, null, root, 0), initial = await readSourceContent(f, source.sourceId, 'capture.md');
    const input: DocumentSourceMutation = { operationId: randomUUID(), action: 'save', path: 'capture.md', sourceRevision: source.revision, expectedRevision: initial.revision, content: after };
    await f.pool.query(`CREATE FUNCTION fail_external_history_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_kind='external_document' AND NEW.origin='manual' THEN RAISE EXCEPTION 'isolated history capture failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
    await f.pool.query('CREATE TRIGGER fail_external_history_capture BEFORE INSERT ON change_history_entries FOR EACH ROW EXECUTE FUNCTION fail_external_history_capture()');
    try {
      const response = await f.request<DocumentSourceMutationReceipt>(documentSourceOperationsPath(f, source.sourceId), { method: 'POST', body: input });
      assert.equal(response.status, 200); assert.equal(response.body.status, 'unknown');
      assert.equal(await readFile(join(root, input.path), 'utf8'), after);
      assert.equal((await history(f, source.sourceId, input.path)).items.length, 1, 'A failed history transaction does not publish a false successful capture');
    } finally {
      await f.pool.query('DROP TRIGGER fail_external_history_capture ON change_history_entries');
      await f.pool.query('DROP FUNCTION fail_external_history_capture()');
    }
    const prepared = join(f.root, 'document-source-operations', f.workspaceId, f.owner.id, `${input.operationId}.history.json`);
    assert.equal((await lstat(prepared)).mode & 0o077, 0, 'Prepared snapshot bytes are private');
    assert.equal(JSON.parse(await readFile(prepared, 'utf8')).capture.before.content, before);
    await writeFile(join(root, input.path), later); await f.restartApi();
    const recovered = await readDocumentSourceMutation(f, source.sourceId, input.operationId);
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.content!.content, after);
    assert.equal(await readFile(join(root, input.path), 'utf8'), later, 'Recovery never repeats the filesystem save');
    const page = await history(f, source.sourceId, input.path); assert.equal(page.items.length, 2);
    const original = await detail(f, page.items[0]!.changeId);
    assert.equal(original.before!.raw, before); assert.equal(original.after!.raw, after); assert.equal(original.change.completeness, 'exact');
    await readDocumentSourceMutation(f, source.sourceId, input.operationId);
    assert.equal((await history(f, source.sourceId, input.path)).items.length, 2, 'Repeated reconciliation is idempotent');
  });

  it('never publishes prepared snapshots when dispatch has an unknown filesystem outcome but no completion proof', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const root = join(f.parents[1], 'unknown-history'); await mkdir(root);
    const source = await configureDocumentSource(f, null, root, 0);
    const input: DocumentSourceMutation = { operationId: randomUUID(), action: 'create', sourceRevision: source.revision, path: 'uncertain.md', content: '# Must not be recorded as a successful save\n' };
    const lock = randomInt(1, 2_147_483_647), blocker = await f.pool.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [lock]);
      await f.pool.query(`CREATE FUNCTION pause_external_history_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='${input.operationId}'::uuid AND NEW.status='applying' THEN PERFORM pg_advisory_lock(${lock}); PERFORM pg_advisory_unlock(${lock}); END IF; RETURN NEW; END $$`);
      await f.pool.query('CREATE TRIGGER pause_external_history_dispatch BEFORE UPDATE ON document_source_operations FOR EACH ROW EXECUTE FUNCTION pause_external_history_dispatch()');
      const pending = f.request<DocumentSourceMutationReceipt>(documentSourceOperationsPath(f, source.sourceId), { method: 'POST', body: input });
      await localProjectEventually(async () => (await f.pool.query('SELECT 1 FROM pg_locks WHERE locktype=$1 AND classid=0 AND objid=$2 AND NOT granted', ['advisory', lock])).rowCount! > 0, 'the original prepared attempt waiting before dispatch commits', 20_000, f.signal);
      await chmod(root, 0o555); await blocker.query('SELECT pg_advisory_unlock($1)', [lock]);
      const response = await pending; assert.equal(response.status, 200); assert.equal(response.body.status, 'unknown');
    } finally {
      await chmod(root, 0o755);
      try { await blocker.query('SELECT pg_advisory_unlock($1)', [lock]); } finally { blocker.release(); }
      await f.pool.query('DROP TRIGGER IF EXISTS pause_external_history_dispatch ON document_source_operations');
      await f.pool.query('DROP FUNCTION IF EXISTS pause_external_history_dispatch()');
    }
    await assert.rejects(lstat(join(root, input.path)), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.root, 'document-source-operations', f.workspaceId, f.owner.id, `${input.operationId}.json`)), { code: 'ENOENT' });
    assert.equal((await readDocumentSourceMutation(f, source.sourceId, input.operationId)).status, 'unknown');
    assert.deepEqual((await history(f, source.sourceId, input.path)).items, []);
  });

  it('shares one verified physical history through parent and nested source roots without inventing a move or duplicate baseline', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const a = await createDocumentProject(f, 'Parent-root history project', 'history-parent-root'), b = await createDocumentProject(f, 'Nested-root history project', 'history-nested-root');
    const root = join(f.parents[1], 'history-parent-source'), nested = join(root, 'nested'); await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'document.md'), '# One physical baseline\n');
    const parentSource = await configureDocumentSource(f, a.record.id, root, 0), nestedSource = await configureDocumentSource(f, b.record.id, nested, 0);
    await readSourceContent(f, parentSource.sourceId, 'nested/document.md');
    const reader = await f.member('Nested-root-only reader');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [b.record.id] });
    const initial = await history(f, parentSource.sourceId, 'nested/document.md');
    assert.deepEqual((await history(f, nestedSource.sourceId, 'document.md', reader.cookie)).items.map(item => item.changeId), initial.items.map(item => item.changeId));
    await readSourceContent(f, nestedSource.sourceId, 'document.md', reader.cookie);
    assert.equal((await history(f, parentSource.sourceId, 'nested/document.md')).items.length, 1);
    await writeFile(join(nested, 'document.md'), '# Observed via a different root\n');
    const observed = await readSourceContent(f, nestedSource.sourceId, 'document.md', reader.cookie);
    const saved = await mutateDocumentSource(f, nestedSource.sourceId, { operationId: randomUUID(), action: 'save', sourceRevision: nestedSource.revision, path: 'document.md', expectedRevision: observed.revision, content: '# Controlled save through the nested alias\n' });
    const parentHistory = await history(f, parentSource.sourceId, 'nested/document.md'), nestedHistory = await history(f, nestedSource.sourceId, 'document.md', reader.cookie);
    assert.equal(parentHistory.items.length, 3); assert.deepEqual(parentHistory.items.map(item => item.changeId), nestedHistory.items.map(item => item.changeId));
    const changed = await detail(f, nestedHistory.items[0]!.changeId, reader.cookie);
    assert.equal(changed.before!.raw, '# Observed via a different root\n'); assert.equal(changed.after!.raw, saved.content!.content);
    assert.ok(parentHistory.items.every(item => !item.changedFields.includes('sourceId')), 'Viewing or saving an alias is not a filesystem move');
  });

  it('authorizes intentional physical aliases with current permissions and rejects revoked, removed, unsafe or rebound history sources', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const a = await createDocumentProject(f, 'History association A', 'history-alias-a'), b = await createDocumentProject(f, 'History association B', 'history-alias-b');
    const root = join(f.parents[1], 'history-shared-root'); await mkdir(root); await writeFile(join(root, 'shared.md'), '# Shared baseline\n');
    const sourceA = await configureDocumentSource(f, a.record.id, root, 0), sourceB = await configureDocumentSource(f, b.record.id, root, 0);
    const initial = await readSourceContent(f, sourceA.sourceId, 'shared.md');
    await mutateDocumentSource(f, sourceA.sourceId, { operationId: randomUUID(), action: 'save', sourceRevision: sourceA.revision, path: 'shared.md', expectedRevision: initial.revision, content: '# Shared saved content\n' });
    const ownerHistory = await history(f, sourceA.sourceId, 'shared.md'), reader = await f.member('Alias B-only reader');
    const grant = await f.command<{ version: number }>('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: [b.record.id] });
    assert.deepEqual((await history(f, sourceB.sourceId, 'shared.md', reader.cookie)).items.map(item => item.changeId), ownerHistory.items.map(item => item.changeId));
    assert.equal((await detail(f, ownerHistory.items[0]!.changeId, reader.cookie)).after!.raw, '# Shared saved content\n');
    await configureDocumentSources(f, a.record.id, [], 1);
    assert.equal((await history(f, sourceB.sourceId, 'shared.md', reader.cookie)).items.length, 2, 'Removed aliases do not erase history exposed by another current authorized association');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: [], projectIds: [b.record.id] }, { expectedVersions: { [reader.user.id]: grant.version } });
    const denied = await f.request(`${historyBase(f)}/${ownerHistory.items[0]!.changeId}`, { cookie: reader.cookie });
    assertDocumentSourceFailure(denied, [403, 404]); assert.equal(JSON.stringify(denied.body).includes('Shared saved'), false);
    await chmod(join(root, 'shared.md'), 0o000);
    try { assertDocumentSourceFailure(await f.request(`${historyBase(f)}/${ownerHistory.items[0]!.changeId}`), [403, 404]); }
    finally { await chmod(join(root, 'shared.md'), 0o600); }
    const held = join(root, 'retained-original.txt'); await rename(join(root, 'shared.md'), held);
    await symlink(held, join(root, 'shared.md'), 'file');
    assertDocumentSourceFailure(await f.request(`${historyBase(f)}/${ownerHistory.items[0]!.changeId}`), [403, 404]);
    await rm(join(root, 'shared.md')); await link(held, join(root, 'shared.md'));
    assertDocumentSourceFailure(await f.request(`${historyBase(f)}/${ownerHistory.items[0]!.changeId}`), [403, 404]);
    await rm(join(root, 'shared.md')); await rename(held, join(root, 'shared.md'));
    await rename(root, `${root}-original`); await mkdir(root); await writeFile(join(root, 'shared.md'), '# Rebound directory content, not old history\n');
    const rebound = await configureDocumentSource(f, b.record.id, root, 1);
    assert.equal(rebound.sourceId, sourceB.sourceId); assert.equal(rebound.revision, sourceB.revision + 1);
    await readSourceContent(f, rebound.sourceId, 'shared.md');
    const fresh = await history(f, rebound.sourceId, 'shared.md'); assert.equal(fresh.items.length, 1); assert.equal(fresh.items[0]!.completeness, 'baseline');
    assertDocumentSourceFailure(await f.request(`${historyBase(f)}/${ownerHistory.items[0]!.changeId}`), [403, 404, 409]);
    await configureDocumentSources(f, b.record.id, [], 2);
    assertDocumentSourceFailure(await f.request(`${historyBase(f)}/query`, { method: 'POST', body: { target: external(rebound.sourceId, 'shared.md') } }), [403, 404]);
  });
});
