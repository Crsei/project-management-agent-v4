import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { documentSourceMutationSchema, type DocumentSourceContent, type DocumentSourceMutation } from '../packages/contracts/src/document-sources.ts';
import { migrate } from '../packages/infrastructure/src/database.ts';
import { DocumentSourceDirectory } from '../packages/infrastructure/src/document-source-files.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';
import { assertDocumentSourceFailure, configureDocumentSources, createDocumentProject, documentSourceOperationsPath, readDocumentSourceCatalog, readDocumentSourceMutation, readSourceContent } from './document-sources-fixture.ts';

// Recreate only the three document-source tables from their actual pre-cutover
// migrations in an owned, stopped fixture schema. All other SQL and disk state
// remains real, so the production migrator and restarted HTTP API see an upgrade.
describe('document source forward migration preserves immutable recovery evidence', { concurrency: 1 }, () => {
  it('migrates active and cleared source identities, set revisions, receipts, applying/unknown blockers and durable legacy proof without changing operation hashes or replaying IO', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const project = await createDocumentProject(f, 'Legacy cleared project source', 'legacy-cleared-project');
    const root = join(f.parents[1], 'legacy-source'); await mkdir(root);
    await writeFile(join(root, 'moved.md'), '# Legacy move already committed\n');
    const directory = new DocumentSourceDirectory(root);
    let content: DocumentSourceContent;
    try { content = directory.content('moved.md', 7, true); } finally { directory.close(); }
    const move = documentSourceMutationSchema.parse({ operationId: randomUUID(), sourceRevision: 7, path: 'before-move.md', action: 'move', expectedRevision: 'legacy-original-file-revision', targetSourceId: 'workspace', targetSourceRevision: 7, targetPath: 'moved.md' });
    const legacyMove = Object.fromEntries(Object.entries(move).map(([key, value]) => [key === 'targetSourceId' ? 'targetScope' : key, value]));
    const legacyScope = { workspaceId: f.workspaceId, projectId: null };
    const moveHash = createHash('sha256').update(JSON.stringify({ scope: legacyScope, input: legacyMove })).digest('hex');
    const legacyReceipt = { operationId: move.operationId, action: 'move', path: move.path, status: 'succeeded', targetScope: 'workspace', targetPath: 'moved.md', content };
    const moveRequest = { action: 'move', path: move.path, sourceRevision: 7, expectedRevision: 'legacy-original-file-revision', targetScope: 'workspace', targetPath: 'moved.md', targetSourceRevision: 7, sourceRoot: root, targetRoot: root };
    const unknownId = randomUUID(), applyingId = randomUUID(), preparedId = randomUUID(), clearedId = randomUUID(), completedId = randomUUID();
    const pendingRequest = { action: 'create', path: 'never-observed.md', sourceRevision: 7, sourceRoot: root };
    const proofRoot = join(f.root, 'document-source-operations', f.workspaceId, f.owner.id);
    await mkdir(proofRoot, { recursive: true, mode: 0o700 });
    const proofPath = join(proofRoot, `${move.operationId}.json`);
    const proofBytes = Buffer.from(JSON.stringify({ requestHash: moveHash, receipt: legacyReceipt }));
    await writeFile(proofPath, proofBytes, { mode: 0o600 });
    await f.stopServices();
    await f.pool.query('DROP TABLE document_source_operations,document_sources,document_source_scopes');
    await f.pool.query(await readFile(new URL('../packages/infrastructure/migrations/0039_document_sources.sql', import.meta.url), 'utf8'));
    await f.pool.query(await readFile(new URL('../packages/infrastructure/migrations/0044_document_source_operations.sql', import.meta.url), 'utf8'));
    await f.pool.query("DELETE FROM schema_migrations WHERE name='0045_document_source_associations.sql'");
    const stat = await lstat(root);
    await f.pool.query(`INSERT INTO document_sources(workspace_id,project_key,path,directory_device,directory_inode,revision,updated_by)
      VALUES($1,'',$2,$3,$4,7,$5),($1,$6,NULL,NULL,NULL,9,$5)`, [f.workspaceId, root, String(stat.dev), String(stat.ino), f.owner.id, project.record.id]);
    const clearedReceipt = { operationId: clearedId, action: 'delete', path: 'removed.md', status: 'not_applied', message: 'Legacy proven no effect' };
    for (const [id, sourceKey, status, request, hash, receipt] of [
      [move.operationId, '', 'unknown', moveRequest, moveHash, null],
      [completedId, '', 'succeeded', moveRequest, 'e'.repeat(64), { ...legacyReceipt, operationId: completedId }],
      [unknownId, '', 'unknown', pendingRequest, 'a'.repeat(64), null],
      [applyingId, '', 'applying', { ...pendingRequest, path: 'applying.md' }, 'b'.repeat(64), null],
      [preparedId, '', 'prepared', { action: 'create', path: 'not-dispatched.md', sourceRevision: 7 }, 'c'.repeat(64), null],
      [clearedId, project.record.id, 'not_applied', { action: 'delete', path: 'removed.md', sourceRevision: 9, expectedRevision: 'old-revision' }, 'd'.repeat(64), clearedReceipt],
    ] as const) {
      await f.pool.query('INSERT INTO document_source_operations(workspace_id,actor_id,operation_id,source_key,status,request,request_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)', [f.workspaceId, f.owner.id, id, sourceKey, status, JSON.stringify(request), hash, receipt === null ? null : JSON.stringify(receipt)]);
    }
    const evidenceBefore = (await f.pool.query('SELECT operation_id,request_hash,request,status,receipt,created_at,updated_at FROM document_source_operations ORDER BY operation_id')).rows;
    await migrate(f.pool);
    assert.deepEqual((await f.pool.query('SELECT operation_id,request_hash,request,status,receipt,created_at,updated_at FROM document_source_operations ORDER BY operation_id')).rows, evidenceBefore, 'Migration never rewrites immutable request/proof identity, receipts or pending outcomes');
    assert.deepEqual(await readFile(proofPath), proofBytes, 'SQL migration does not alter durable disk proof');
    assert.deepEqual((await f.pool.query('SELECT source_id,source_project_key FROM document_source_operations WHERE operation_id=$1', [clearedId])).rows, [{ source_id: project.record.id, source_project_key: project.record.id }]);
    assert.equal((await f.pool.query("SELECT removed_at IS NOT NULL AS removed FROM document_sources WHERE source_id=$1", [project.record.id])).rows[0].removed, true);
    await f.restartApi();
    const catalog = await readDocumentSourceCatalog(f);
    assert.equal(catalog.sources.length, 1); assert.equal(catalog.sources[0]!.sourceId, 'workspace'); assert.equal(catalog.sources[0]!.revision, 7);
    assert.equal(catalog.scopes.find(scope => scope.projectId === null)!.revision, 7);
    assert.equal(catalog.scopes.find(scope => scope.projectId === project.record.id)!.revision, 9);
    assert.deepEqual(await readSourceContent(f, 'workspace', 'moved.md'), content);
    const recovered = await readDocumentSourceMutation(f, 'workspace', move.operationId);
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.targetSourceId, 'workspace'); assert.equal('targetScope' in recovered, false);
    assert.deepEqual(recovered.content, content);
    const completed = await readDocumentSourceMutation(f, 'workspace', completedId);
    assert.equal(completed.status, 'succeeded'); assert.equal(completed.targetSourceId, 'workspace'); assert.equal('targetScope' in completed, false);
    assert.deepEqual(completed.content, content);
    const replay = await f.request(documentSourceOperationsPath(f, 'workspace'), { method: 'POST', body: move satisfies DocumentSourceMutation });
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, recovered, 'The migrated HTTP shape reconciles the original identity rather than creating a second operation');
    assert.equal((await readDocumentSourceMutation(f, 'workspace', unknownId)).status, 'unknown');
    assert.equal((await readDocumentSourceMutation(f, 'workspace', applyingId)).status, 'unknown');
    assert.equal((await readDocumentSourceMutation(f, 'workspace', preparedId)).status, 'not_applied');
    assert.deepEqual(await readDocumentSourceMutation(f, project.record.id, clearedId), clearedReceipt, 'A cleared legacy association still authorizes its original receipt');
    const sameSet = await configureDocumentSources(f, null, [root], 7);
    assert.equal(sameSet.sources[0]!.sourceId, 'workspace'); assert.equal(sameSet.sources[0]!.revision, 7);
    const blocked = await f.request(documentSourceOperationsPath(f, 'workspace'), { method: 'POST', body: { operationId: randomUUID(), action: 'create', sourceRevision: 7, path: 'blocked-by-legacy-unknown.md', content: '# Must not write\n' } });
    assertDocumentSourceFailure(blocked, [409], 'document_source_operation_pending');
    assert.equal((await f.pool.query('SELECT request_hash FROM document_source_operations WHERE operation_id=$1', [move.operationId])).rows[0].request_hash, moveHash);
    assert.deepEqual(await readFile(proofPath), proofBytes);
    assert.equal(await readFile(join(root, 'moved.md'), 'utf8'), '# Legacy move already committed\n');
    for (const path of ['before-move.md', 'never-observed.md', 'applying.md', 'not-dispatched.md', 'blocked-by-legacy-unknown.md']) await assert.rejects(lstat(join(root, path)), { code: 'ENOENT' });
  });
});
