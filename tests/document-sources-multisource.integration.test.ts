import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DocumentSourceContent, DocumentSourceMutation, DocumentSourceMutationReceipt } from '../packages/contracts/src/document-sources.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';
import { assertDocumentSourceFailure, collectDocumentFiles, configureDocumentSource, configureDocumentSources, createDocumentProject, documentSourcesPath, mutateDocumentSource, readDocumentSourceCatalog, readDocumentSourceMutation, readSourceContent } from './document-sources-fixture.ts';

describe('multiple document sources: real physical aliases and authorization', { concurrency: 1 }, () => {
  it('identifies physical locations within a workspace, keeps equal bytes/names distinct, rejects stale aliases and same-file moves, and isolates unlinking', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const a = await createDocumentProject(f, 'Alias project A', 'alias-project-a');
    const b = await createDocumentProject(f, 'Alias project B', 'alias-project-b');
    const root = join(f.parents[1], 'shared-tree'), child = join(root, 'nested'), sibling = join(f.parents[1], 'equal-bytes');
    await mkdir(child, { recursive: true }); await mkdir(sibling);
    const bytes = '# Same bytes are not file identity\n';
    await writeFile(join(child, 'same.md'), bytes); await writeFile(join(sibling, 'same.md'), bytes);
    const common = await configureDocumentSources(f, null, [root, sibling], 0);
    const parent = common.sources.find(source => source.path === root)!;
    const separate = common.sources.find(source => source.path === sibling)!;
    const aliasA = await configureDocumentSource(f, a.record.id, child, 0);
    const aliasB = await configureDocumentSource(f, b.record.id, child, 0);
    assert.notEqual(aliasA.sourceId, aliasB.sourceId);
    const parentEntry = (await collectDocumentFiles(f, parent.sourceId)).entries.find(entry => entry.path === 'nested/same.md')!;
    const aliasEntry = (await collectDocumentFiles(f, aliasA.sourceId)).entries[0]!;
    const separateEntry = (await collectDocumentFiles(f, separate.sourceId)).entries[0]!;
    assert.equal(parentEntry.fileKey, aliasEntry.fileKey, 'Nested aliases resolve to the same absolute physical location');
    assert.notEqual(aliasEntry.fileKey, separateEntry.fileKey, 'Same basename and content at another location must not merge');
    assert.equal(aliasEntry.fileKey.includes(child), false); assert.equal(aliasEntry.fileKey.includes('same.md'), false);
    const before = await readSourceContent(f, aliasB.sourceId, 'same.md');
    const saved = await mutateDocumentSource(f, aliasA.sourceId, { operationId: randomUUID(), action: 'save', sourceRevision: aliasA.revision, path: 'same.md', expectedRevision: before.revision, content: '# Written through alias A\n' });
    assert.equal((await readSourceContent(f, parent.sourceId, 'nested/same.md')).content, saved.content!.content);
    assert.equal((await collectDocumentFiles(f, aliasB.sourceId)).entries[0]!.fileKey, aliasEntry.fileKey, 'Editing bytes does not change location identity');
    const stale: DocumentSourceMutation[] = [
      { operationId: randomUUID(), action: 'save', sourceRevision: aliasB.revision, path: 'same.md', expectedRevision: before.revision, content: '# Must not overwrite\n' },
      { operationId: randomUUID(), action: 'delete', sourceRevision: aliasB.revision, path: 'same.md', expectedRevision: before.revision },
      { operationId: randomUUID(), action: 'move', sourceRevision: aliasB.revision, path: 'same.md', expectedRevision: before.revision, targetSourceId: separate.sourceId, targetSourceRevision: separate.revision, targetPath: 'stale-move.md' },
    ];
    for (const input of stale) assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, aliasB.sourceId)}/operations`, { method: 'POST', body: input }), [409], 'document_source_file_revision_conflict');
    const samePhysical = await f.request(`${documentSourcesPath(f, parent.sourceId)}/operations`, { method: 'POST', body: { operationId: randomUUID(), action: 'move', sourceRevision: parent.revision, path: 'nested/same.md', expectedRevision: saved.content!.revision, targetSourceId: aliasA.sourceId, targetSourceRevision: aliasA.revision, targetPath: 'same.md' } });
    assertDocumentSourceFailure(samePhysical, [409], 'document_source_same_path');
    await configureDocumentSources(f, a.record.id, [], 1);
    assert.equal((await readSourceContent(f, aliasB.sourceId, 'same.md')).content, '# Written through alias A\n');
    assert.equal((await readSourceContent(f, parent.sourceId, 'nested/same.md')).content, '# Written through alias A\n');
    const other = await createWorkspace(f.pool, f.owner.id, 'Shared root, isolated metadata');
    const otherConfiguration = await configureDocumentSources(f, null, [child], 0, { workspaceId: other.id });
    const otherSource = otherConfiguration.sources[0]!;
    const otherList = await f.request<{ entries: { fileKey: string }[] }>(`${documentSourcesPath(f, otherSource.sourceId, other.id)}/files`);
    assert.equal(otherList.status, 200);
    assert.notEqual(otherList.body.entries[0]!.fileKey, aliasEntry.fileKey, 'File keys are workspace-scoped, not a cross-workspace tracking identifier');
    const foreignStale = await f.request(`${documentSourcesPath(f, otherSource.sourceId, other.id)}/operations`, { method: 'POST', body: { operationId: randomUUID(), action: 'save', sourceRevision: otherSource.revision, path: 'same.md', expectedRevision: before.revision, content: '# Stale foreign alias\n' } });
    assertDocumentSourceFailure(foreignStale, [409], 'document_source_file_revision_conflict');
    assert.equal((await f.request(`${documentSourcesPath(f, otherSource.sourceId, other.id)}/content?path=same.md`)).status, 200);
    assert.equal((await readDocumentSourceMutation(f, aliasA.sourceId, saved.operationId)).status, 'succeeded', 'Unlinking retains owner-authorized receipts');
    await f.restartApi();
    assert.equal((await readSourceContent(f, aliasB.sourceId, 'same.md')).content, '# Written through alias A\n');
    assert.equal(await readFile(join(sibling, 'same.md'), 'utf8'), bytes);
    await assert.rejects(lstat(join(sibling, 'stale-move.md')), { code: 'ENOENT' });
  });

  it('blocks unknown physical writes through aliases in other workspaces on both move roots and destinations, then recovers the original proof even after unlink', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const project = await createDocumentProject(f, 'Unknown move destination', 'unknown-destination-project');
    const sourceRoot = join(f.parents[1], 'unknown-source'), targetRoot = join(f.parents[1], 'unknown-target'), independentRoot = join(f.parents[1], 'independent');
    for (const path of [sourceRoot, targetRoot, independentRoot]) await mkdir(path);
    await writeFile(join(sourceRoot, 'move.md'), '# Original uncertain move\n');
    await writeFile(join(independentRoot, 'independent.md'), '# Independent move source\n');
    const source = await configureDocumentSource(f, null, sourceRoot, 0);
    const target = await configureDocumentSource(f, project.record.id, targetRoot, 0);
    const other = await createWorkspace(f.pool, f.owner.id, 'Foreign physical aliases');
    const aliases = await configureDocumentSources(f, null, [sourceRoot, targetRoot, independentRoot], 0, { workspaceId: other.id });
    const independent = aliases.sources.find(alias => alias.path === independentRoot)!;
    const independentContent = await f.request<DocumentSourceContent>(`${documentSourcesPath(f, independent.sourceId, other.id)}/content?path=independent.md`);
    assert.equal(independentContent.status, 200);
    const original = await readSourceContent(f, source.sourceId, 'move.md');
    const operation: DocumentSourceMutation = { operationId: randomUUID(), action: 'move', sourceRevision: source.revision, path: 'move.md', expectedRevision: original.revision, targetSourceId: target.sourceId, targetSourceRevision: target.revision, targetPath: 'moved.md' };
    await f.pool.query(`CREATE FUNCTION fail_alias_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation_id='${operation.operationId}'::uuid AND NEW.status='succeeded' THEN RAISE EXCEPTION 'isolated alias receipt failure' USING ERRCODE='40001'; END IF;
      RETURN NEW; END $$`);
    await f.pool.query('CREATE TRIGGER fail_alias_receipt BEFORE UPDATE ON document_source_operations FOR EACH ROW EXECUTE FUNCTION fail_alias_receipt()');
    try {
      const uncertain = await f.request<DocumentSourceMutationReceipt>(`${documentSourcesPath(f, source.sourceId)}/operations`, { method: 'POST', body: operation });
      assert.equal(uncertain.status, 200); assert.equal(uncertain.body.status, 'unknown');
      assert.equal(await readFile(join(targetRoot, 'moved.md'), 'utf8'), '# Original uncertain move\n');
      await assert.rejects(lstat(join(sourceRoot, 'move.md')), { code: 'ENOENT' });
      const durable = await f.pool.query<{ status: string; request: { sourceRoot: string; targetRoot: string } }>('SELECT status,request FROM document_source_operations WHERE operation_id=$1', [operation.operationId]);
      assert.equal(durable.rows[0]!.status, 'unknown'); assert.equal(durable.rows[0]!.request.sourceRoot, sourceRoot); assert.equal(durable.rows[0]!.request.targetRoot, targetRoot);
      for (const alias of aliases.sources.filter(alias => alias.path !== independentRoot)) {
        const createBlocked = await f.request(`${documentSourcesPath(f, alias.sourceId, other.id)}/operations`, { method: 'POST', body: { operationId: randomUUID(), action: 'create', sourceRevision: alias.revision, path: 'must-not-create.md', content: '# Blocked physical alias\n' } });
        assertDocumentSourceFailure(createBlocked, [409], 'document_source_operation_pending');
        const destinationBlocked = await f.request(`${documentSourcesPath(f, independent.sourceId, other.id)}/operations`, { method: 'POST', body: { operationId: randomUUID(), action: 'move', sourceRevision: independent.revision, path: 'independent.md', expectedRevision: independentContent.body.revision, targetSourceId: alias.sourceId, targetSourceRevision: alias.revision, targetPath: 'must-not-move.md' } });
        assertDocumentSourceFailure(destinationBlocked, [409], 'document_source_operation_pending');
        await assert.rejects(lstat(join(alias.path!, 'must-not-create.md')), { code: 'ENOENT' });
        await assert.rejects(lstat(join(alias.path!, 'must-not-move.md')), { code: 'ENOENT' });
      }
      const peer = await f.member('Other authorized operation actor');
      await f.command('SetWorkspaceMember', { userId: peer.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: null });
      const denied = await f.request(`${documentSourcesPath(f, source.sourceId)}/operations/${operation.operationId}`, { cookie: peer.cookie });
      assertDocumentSourceFailure(denied, [403, 404]); assert.equal(JSON.stringify(denied.body).includes(f.root), false); assert.equal(JSON.stringify(denied.body).includes('Original uncertain'), false);
      await configureDocumentSources(f, null, [], 1);
    } finally {
      await f.pool.query('DROP TRIGGER fail_alias_receipt ON document_source_operations');
      await f.pool.query('DROP FUNCTION fail_alias_receipt()');
    }
    await f.restartApi();
    const recovered = await readDocumentSourceMutation(f, source.sourceId, operation.operationId);
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.targetSourceId, target.sourceId);
    assert.equal(recovered.content!.content, '# Original uncertain move\n');
    assert.equal((await readDocumentSourceCatalog(f)).sources.some(row => row.sourceId === source.sourceId), false);
    const alias = aliases.sources.find(row => row.path === targetRoot)!;
    const afterRecovery = await f.request<DocumentSourceMutationReceipt>(`${documentSourcesPath(f, alias.sourceId, other.id)}/operations`, { method: 'POST', body: { operationId: randomUUID(), action: 'create', sourceRevision: alias.revision, path: 'after-recovery.md', content: '# Explicit new operation after authoritative recovery\n' } });
    assert.equal(afterRecovery.status, 200); assert.equal(afterRecovery.body.status, 'succeeded');
    assert.equal(await readFile(join(targetRoot, 'after-recovery.md'), 'utf8'), '# Explicit new operation after authoritative recovery\n');
    assert.equal(await readFile(join(independentRoot, 'independent.md'), 'utf8'), '# Independent move source\n');
  });
  it('shares only explicit ordinary directories without granting project metadata, private-root access or unauthorized chooser scopes', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const a = await createDocumentProject(f, 'Authorized alias scope', 'shared-authorization-a');
    const b = await createDocumentProject(f, 'PRIVATE_UNAUTHORIZED_PROJECT', 'shared-authorization-b');
    const parent = join(f.parents[1], 'ordinary-parent'), shared = join(parent, 'ordinary-shared');
    await mkdir(shared, { recursive: true }); await writeFile(join(shared, 'shared.md'), '# Intentionally shared ordinary body\n');
    for (const component of ['.pm', '.git', '.ssh', '.aws', '.config', '.codex', '.claude', '.agent-workspace', 'provider-homes']) {
      const privateRoot = join(shared, component); await mkdir(privateRoot);
      await writeFile(join(privateRoot, 'secret.md'), '# PRIVATE_CREDENTIAL_BYTES\n');
      const rejected = await f.request(`${documentSourcesPath(f)}/configuration`, { method: 'PUT', body: { projectId: a.record.id, expectedRevision: 0, paths: [privateRoot] } });
      assertDocumentSourceFailure(rejected, [403]);
      const browseRejected = await f.request(`${documentSourcesPath(f)}/directories?${new URLSearchParams({ projectId: a.record.id, path: privateRoot })}`);
      assertDocumentSourceFailure(browseRejected, [403]);
    }
    await configureDocumentSource(f, b.record.id, shared, 0);
    const explicit = await configureDocumentSource(f, a.record.id, shared, 0);
    const scoped = await f.member('Only the explicitly shared project');
    await f.command('SetWorkspaceMember', { userId: scoped.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] });
    const visible = await readDocumentSourceCatalog(f, scoped.cookie);
    assert.deepEqual(visible.sources.map(source => source.sourceId), [explicit.sourceId]);
    assert.deepEqual(visible.scopes.map(scope => scope.projectId), [a.record.id]);
    assert.equal(visible.sources[0]!.path, null); assert.equal(visible.sources[0]!.canManage, false);
    assert.equal(JSON.stringify(visible).includes('PRIVATE_UNAUTHORIZED_PROJECT'), false);
    assert.equal(JSON.stringify(visible).includes(f.root), false);
    assert.equal((await readSourceContent(f, explicit.sourceId, 'shared.md', scoped.cookie)).content, '# Intentionally shared ordinary body\n');
    const files = await collectDocumentFiles(f, explicit.sourceId, { cookie: scoped.cookie });
    assert.deepEqual(files.entries.map(entry => entry.path), ['shared.md']);
    assert.equal(JSON.stringify(files).includes('PRIVATE_CREDENTIAL_BYTES'), false);
    const nativeDenied = await f.request(`/api/v1/workspaces/${f.workspaceId}/core/files/${b.record.id}`, { cookie: scoped.cookie });
    assertDocumentSourceFailure(nativeDenied, [403, 404]);
    for (const projectId of ['', b.record.id]) {
      const browse = await f.request(`${documentSourcesPath(f)}/directories?${new URLSearchParams({ ...(projectId ? { projectId } : {}), path: parent })}`, { cookie: scoped.cookie });
      assertDocumentSourceFailure(browse, [403, 404]); assert.equal(JSON.stringify(browse.body).includes(f.root), false);
    }
    const managerListing = await f.request<{ directories: { path: string }[] }>(`${documentSourcesPath(f)}/directories?${new URLSearchParams({ projectId: a.record.id, path: shared })}`);
    assert.equal(managerListing.status, 200);
    assert.deepEqual(managerListing.body.directories, [], 'Private directories must not become selectable server folders');
  });
});
