import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { DomainError } from '../packages/domain/src/core.ts';
import { inspectDocumentSourceMutation, mutateDocumentSource, readDocumentSourceMutationResult, type DocumentSourceContext } from '../packages/application/src/document-sources.ts';
import { documentSourceMutationSchema } from '../packages/contracts/src/document-sources.ts';
import { Workspace } from '../packages/pm-core/index.ts';
import { readDocumentSourceOperation } from '../packages/infrastructure/src/document-sources.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';
import { configureDocumentSource, configureDocumentSources, createDocumentProject, mutateDocumentSource as nativeMutation } from './document-sources-fixture.ts';

it('original filesystem inspection and receipt hydration are read-only, hash-bound and enforce current source/project binding', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const project = await createDocumentProject(f, 'Pure original file evidence', 'pure-evidence');
  const root = join(f.parents[1], 'pure-source'); await mkdir(root);
  const source = await configureDocumentSource(f, project.record.id, root, 0);
  const workspace = new Workspace(join(f.coreRoot, f.workspaceId));
  t.after(() => workspace.close()); await workspace.init();
  const reference = { workspaceId: f.workspaceId, sourceId: source.sourceId };
  const input = documentSourceMutationSchema.parse({ action: 'create', operationId: randomUUID(), sourceRevision: source.revision, path: 'original.md', content: '# Original persisted bytes\n' });
  const writer = await f.member('Original document evidence writer');
  const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: writer.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [project.record.id] });
  const result = await nativeMutation(f, source.sourceId, input, writer.cookie);
  const hash = createHash('sha256').update(JSON.stringify({ reference, input })).digest('hex');
  const sql = await f.pool.connect();
  const context: DocumentSourceContext = { sql, actor: writer.user, workspace: async () => workspace, config: { enabled: true, dataRoot: f.root, coreRoot: f.coreRoot, backupRoot: join(f.root, 'backups'), allowedRoots: f.parents, defaultParent: f.parents[0], chatSpaceRoot: join(f.root, '.pmv4') }, history: async () => { throw new Error('Pure inspection must not publish history'); }, checkProject(projectId) { assert.equal(projectId, project.record.id); } };
  try {
    await sql.query('BEGIN READ ONLY');
    const original = await readDocumentSourceOperation(sql, reference, writer.user.id, input.operationId);
    assert.ok(original, 'The native API must persist the original operation evidence');
    assert.equal(original.status, 'succeeded');
    assert.equal(original.request_hash, hash);
    assert.equal(original.source_project_key, project.record.id);
    assert.deepEqual(original.receipt, result);
    assert.equal(await inspectDocumentSourceMutation(context, reference, { operationId: input.operationId, hash, action: input.action }), 'succeeded');
    assert.deepEqual(await readDocumentSourceMutationResult(context, reference, input.operationId, { hash, action: input.action }), result);
    assert.equal(await inspectDocumentSourceMutation(context, reference, { operationId: input.operationId, hash: '0'.repeat(64), action: input.action }), 'unknown');
    assert.equal(await readDocumentSourceMutationResult(context, reference, input.operationId, { hash: '0'.repeat(64), action: input.action }), null);
    assert.equal(await inspectDocumentSourceMutation(context, reference, { operationId: input.operationId, hash, action: 'delete' }), 'unknown');
    assert.equal(await readDocumentSourceMutationResult(context, reference, input.operationId, { hash, action: 'delete' }), null);
    assert.equal(await readDocumentSourceMutationResult(context, reference, randomUUID()), null);
    const delegatedRevocation = { ...context, checkProject() { throw new DomainError('not_found_or_forbidden', 'Scope revoked', 404); } };
    await assert.rejects(inspectDocumentSourceMutation(delegatedRevocation, reference, { operationId: input.operationId, hash, action: input.action }), (error: unknown) => error instanceof DomainError && error.status === 404);
    await assert.rejects(readDocumentSourceMutationResult(delegatedRevocation, reference, input.operationId), (error: unknown) => error instanceof DomainError && error.status === 404);
    const restricted = await f.command<{ version: number }>('SetWorkspaceMember', { userId: writer.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [] }, { expectedVersions: { [writer.user.id]: membership.version } });
    await assert.rejects(inspectDocumentSourceMutation(context, reference, { operationId: input.operationId, hash, action: input.action }), (error: unknown) => error instanceof DomainError && error.status === 404);
    await assert.rejects(readDocumentSourceMutationResult(context, reference, input.operationId, { hash, action: input.action }), (error: unknown) => error instanceof DomainError && error.status === 404);
    await f.command('SetWorkspaceMember', { userId: writer.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [project.record.id] }, { expectedVersions: { [writer.user.id]: restricted.version } });
    await configureDocumentSources(f, project.record.id, [], 1);
    assert.equal(await inspectDocumentSourceMutation(context, reference, { operationId: input.operationId, hash, action: input.action }), 'succeeded', 'Status-only evidence survives source removal without returning historical bytes');
    await assert.rejects(readDocumentSourceMutationResult(context, reference, input.operationId, { hash, action: input.action }), (error: unknown) => error instanceof DomainError && error.status === 404);
    assert.deepEqual(await readDocumentSourceOperation(sql, reference, writer.user.id, input.operationId), original, 'Inspection and hydration must not reconcile or rewrite the original operation');
    await sql.query('COMMIT');
  } finally { await sql.query('ROLLBACK').catch(() => undefined); sql.release(); }
  assert.equal(await readFile(join(root, 'original.md'), 'utf8'), '# Original persisted bytes\n');
});

it('direct source authorization is rechecked after the original attempt but before filesystem dispatch', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const project = await createDocumentProject(f, 'Commit authorization hook', 'commit-hook');
  const root = join(f.parents[1], 'commit-source'); await mkdir(root);
  const source = await configureDocumentSource(f, project.record.id, root, 0);
  const workspace = new Workspace(join(f.coreRoot, f.workspaceId)); t.after(() => workspace.close()); await workspace.init();
  const reference = { workspaceId: f.workspaceId, sourceId: source.sourceId };
  const input = documentSourceMutationSchema.parse({ action: 'create', operationId: randomUUID(), sourceRevision: source.revision, path: 'forbidden.md', content: '# Must not dispatch\n' });
  const hash = createHash('sha256').update(JSON.stringify({ reference, input })).digest('hex');
  const sql = await f.pool.connect(); let authorizedBeforeAttempt = false, reauthorizedPreparedAttempt = false;
  const context: DocumentSourceContext = { sql, actor: f.owner, workspace: async () => workspace, config: { enabled: true, dataRoot: f.root, coreRoot: f.coreRoot, backupRoot: join(f.root, 'backups'), allowedRoots: f.parents, defaultParent: f.parents[0], chatSpaceRoot: join(f.root, '.pmv4') }, checkAuthorization: async () => {
    const original = await readDocumentSourceOperation(sql, reference, f.owner.id, input.operationId);
    if (!original) { authorizedBeforeAttempt = true; return; }
    assert.equal(original.status, 'prepared', 'Authorization must be rechecked after the durable attempt and before dispatch');
    assert.equal(original.receipt, null);
    assert.equal(original.source_id, source.sourceId);
    assert.equal(original.source_project_key, project.record.id);
    assert.equal(original.request_hash, hash);
    reauthorizedPreparedAttempt = true;
    throw new DomainError('not_found_or_forbidden', 'Authorization revoked before dispatch', 404);
  } };
  try {
    await sql.query('SELECT pg_advisory_lock(hashtextextended($1::uuid::text,724631))', [f.workspaceId]);
    await sql.query("SELECT pg_advisory_lock(hashtextextended('local-project-directories',724631))");
    await assert.rejects(mutateDocumentSource(context, reference, input), (error: unknown) => error instanceof DomainError && error.status === 404);
    assert.equal(authorizedBeforeAttempt, true); assert.equal(reauthorizedPreparedAttempt, true);
    await assert.rejects(lstat(join(root, 'forbidden.md')), { code: 'ENOENT' });
    const { checkAuthorization: _checkAuthorization, ...readContext } = context;
    assert.equal(await inspectDocumentSourceMutation(readContext, reference, { operationId: input.operationId, hash, action: input.action }), 'failed');
  } finally {
    await sql.query("SELECT pg_advisory_unlock(hashtextextended('local-project-directories',724631))");
    await sql.query('SELECT pg_advisory_unlock(hashtextextended($1::uuid::text,724631))', [f.workspaceId]); sql.release();
  }
});
