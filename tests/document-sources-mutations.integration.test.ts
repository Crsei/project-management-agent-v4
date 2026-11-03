import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { DocumentSourceMutation, DocumentSourceMutationReceipt } from '../packages/contracts/src/document-sources.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { createLocalProjectFixture, localProjectCaseTimeout, localProjectEventually, type LocalProjectFixture } from './local-project-fixture.ts';
import { assertDocumentSourceFailure, assertPrivateDocumentResponse, collectDocumentFiles, configureDocumentSource, configureDocumentSources, createDocumentProject, documentSourceOperationsPath, documentSourcesPath, mutateDocumentSource, readDocumentSourceMutation, readDocumentSources, readSourceContent } from './document-sources-fixture.ts';

const execute = promisify(execFile);
const post = (f: LocalProjectFixture, sourceId: string, body: DocumentSourceMutation, cookie?: string) => f.request<DocumentSourceMutationReceipt>(documentSourceOperationsPath(f, sourceId), { method: 'POST', body, ...(cookie === undefined ? {} : { cookie }) });
const missing = (path: string) => assert.rejects(lstat(path), { code: 'ENOENT' });
const create = (path: string, content = '# Created without native metadata\n', sourceRevision = 1): Extract<DocumentSourceMutation, { action: 'create' }> => ({ operationId: randomUUID(), action: 'create', sourceRevision, path, content });

async function discardMutationResponse(f: LocalProjectFixture, sourceId: string, input: DocumentSourceMutation): Promise<void> {
  // The server really performs the request. Only the consumer's receipt body is lost.
  const response = await fetch(`${f.origin}${documentSourceOperationsPath(f, sourceId)}`, {
    method: 'POST', headers: { cookie: f.ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify(input),
    signal: AbortSignal.any([f.signal, AbortSignal.timeout(30_000)]),
  });
  try {
    assert.equal(response.status, 200);
    assertPrivateDocumentResponse({ status: response.status, body: undefined, headers: response.headers });
  } finally { await response.body?.cancel(); }
}

// No fake repository, injected application service, HTTP interception or skipped PG case.
describe('external Markdown mutations: real PostgreSQL, HTTP and filesystem', { concurrency: 1 }, () => {
  it('creates, saves, renames, moves across sources and deletes exact plain Markdown bytes, persisting disk and receipts across API restarts', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const project = await createDocumentProject(f, 'External Markdown destination', 'mutation-project');
    const root = join(f.parents[1], 'workspace-markdown'), target = join(f.parents[1], 'project-markdown');
    await mkdir(root); await mkdir(target);
    const original = Buffer.from('# Existing user source\r\nNo frontmatter or native ID.\r\n');
    const sentinel = Buffer.from([0, 255, 13, 10, 0, 42]);
    await writeFile(join(root, 'same.md'), original);
    await writeFile(join(target, 'same.md'), '# Same basename, different source\n');
    await writeFile(join(root, 'unrelated.bin'), sentinel);
    const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0);
    const { sourceId: projectSourceId } = await configureDocumentSource(f, project.record.id, target, 0);
    for (const source of await readDocumentSources(f)) if (source.status === 'available') assert.equal(source.canWrite, true);
    const nativeBefore = await f.request<{ files: FileRecord[] }>(`/api/v1/workspaces/${f.workspaceId}/core/workspace`);
    assert.equal(nativeBefore.status, 200);
    const existing = await readSourceContent(f, workspaceSourceId, 'same.md');
    assert.equal(existing.canWrite, true); assert.ok(existing.revision);
    assert.equal((await readSourceContent(f, workspaceSourceId, 'same.md')).revision, existing.revision, 'A read never consumes a file revision');

    const firstBytes = '# 新建文档\r\n\r\nPlain Markdown, no PM frontmatter.\r\n';
    const createdInput = create('新目录/更 深/空 格 # ?.MD', firstBytes);
    const created = await mutateDocumentSource(f, workspaceSourceId, createdInput);
    assert.equal(await readFile(join(root, createdInput.path), 'utf8'), firstBytes);
    const editedBytes = '# Edited directly\n\nUnicode 正文 and [ordinary Markdown](https://example.test).\n';
    const savedInput: DocumentSourceMutation = { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: createdInput.path, expectedRevision: created.content!.revision, content: editedBytes };
    const saved = await mutateDocumentSource(f, workspaceSourceId, savedInput);
    assert.notEqual(saved.content!.revision, created.content!.revision);
    assert.equal(await readFile(join(root, createdInput.path), 'utf8'), editedBytes);
    const renameInput: DocumentSourceMutation = { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: createdInput.path, expectedRevision: saved.content!.revision, targetSourceId: workspaceSourceId, targetSourceRevision: 1, targetPath: '重命名.md' };
    const renamed = await mutateDocumentSource(f, workspaceSourceId, renameInput);
    assert.equal(renamed.targetSourceId, workspaceSourceId); assert.equal(renamed.targetPath, renameInput.targetPath);
    await missing(join(root, createdInput.path));
    assert.equal(await readFile(join(root, renameInput.targetPath), 'utf8'), editedBytes);
    const moveInput: DocumentSourceMutation = { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: renameInput.targetPath, expectedRevision: renamed.content!.revision, targetSourceId: projectSourceId, targetSourceRevision: 1, targetPath: '移动后/新子目录/文档.md' };
    const moved = await mutateDocumentSource(f, workspaceSourceId, moveInput);
    assert.equal(moved.targetSourceId, projectSourceId); assert.equal(moved.targetPath, moveInput.targetPath);
    await missing(join(root, renameInput.targetPath));
    assert.equal(await readFile(join(target, moveInput.targetPath), 'utf8'), editedBytes);
    await f.restartApi();
    assert.deepEqual(await readSourceContent(f, projectSourceId, moveInput.targetPath), moved.content);
    for (const [input, receipt] of [[createdInput, created], [savedInput, saved], [renameInput, renamed], [moveInput, moved]] as const) {
      assert.deepEqual(await readDocumentSourceMutation(f, workspaceSourceId, input.operationId), receipt);
    }
    const deleteInput: DocumentSourceMutation = { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: moveInput.targetPath, expectedRevision: moved.content!.revision };
    const deleted = await mutateDocumentSource(f, projectSourceId, deleteInput);
    await missing(join(target, moveInput.targetPath));
    await f.restartApi();
    assert.deepEqual(await readDocumentSourceMutation(f, projectSourceId, deleteInput.operationId), deleted);
    assert.deepEqual((await collectDocumentFiles(f, workspaceSourceId)).entries.map(entry => entry.path), ['same.md']);
    assert.deepEqual((await collectDocumentFiles(f, projectSourceId)).entries.map(entry => entry.path), ['same.md']);
    assert.deepEqual(await readFile(join(root, 'same.md')), original);
    assert.equal(await readFile(join(target, 'same.md'), 'utf8'), '# Same basename, different source\n');
    assert.deepEqual(await readFile(join(root, 'unrelated.bin')), sentinel);
    const nativeAfter = await f.request<{ files: FileRecord[] }>(`/api/v1/workspaces/${f.workspaceId}/core/workspace`);
    assert.equal(nativeAfter.status, 200);
    assert.deepEqual(nativeAfter.body.files, nativeBefore.body.files, 'External mutations do not create PM entities or alter native files');
    for (const source of await readDocumentSources(f)) if (source.status === 'available') assert.equal(source.revision, 1, 'File writes do not change root configuration revisions');
  });

  it('never overwrites a same-name destination, serializes competing creates, and binds an operation ID to its original payload', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const project = await createDocumentProject(f, 'Collision destination', 'collision-project');
    const root = join(f.parents[1], 'collision-source'), target = join(f.parents[1], 'collision-target');
    await mkdir(root); await mkdir(target);
    await writeFile(join(root, 'source.md'), '# Keep source\n');
    await writeFile(join(root, 'occupied.md'), '# Keep same-source destination\n');
    await writeFile(join(target, 'occupied.md'), '# Keep cross-source destination\n');
    const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0); const { sourceId: projectSourceId } = await configureDocumentSource(f, project.record.id, target, 0);
    const candidates = [create('race.md', 'First candidate\n'), create('race.md', 'Second candidate\n')];
    const raced = await Promise.all(candidates.map(input => post(f, workspaceSourceId, input)));
    assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
    const winnerIndex = raced.findIndex(response => response.status === 200);
    assert.equal(raced[winnerIndex]!.body.status, 'succeeded');
    assertDocumentSourceFailure(raced[1 - winnerIndex]!, [409], 'document_source_collision');
    assert.equal(await readFile(join(root, 'race.md'), 'utf8'), (candidates[winnerIndex] as Extract<DocumentSourceMutation, { action: 'create' }>).content);
    const winner = raced[winnerIndex]!.body;
    assert.deepEqual(await post(f, workspaceSourceId, candidates[winnerIndex]!).then(response => response.body), winner);
    const conflicting = { ...candidates[winnerIndex]!, content: 'Different payload with same UUID\n' };
    assertDocumentSourceFailure(await post(f, workspaceSourceId, conflicting), [409], 'document_source_operation_id_conflict');
    assertDocumentSourceFailure(await post(f, workspaceSourceId, create('occupied.md', 'Must not replace\n')), [409], 'document_source_collision');
    const source = await readSourceContent(f, workspaceSourceId, 'source.md');
    for (const targetSourceId of [workspaceSourceId, projectSourceId]) {
      assertDocumentSourceFailure(await post(f, workspaceSourceId, { operationId: randomUUID(), action: 'move', path: 'source.md', sourceRevision: 1, expectedRevision: source.revision, targetSourceId, targetSourceRevision: 1, targetPath: 'occupied.md' }), [409], 'document_source_collision');
    }
    const self = await post(f, workspaceSourceId, { operationId: randomUUID(), action: 'move', path: 'source.md', sourceRevision: 1, expectedRevision: source.revision, targetSourceId: workspaceSourceId, targetSourceRevision: 1, targetPath: 'source.md' });
    assertDocumentSourceFailure(self, [400, 409]);
    assert.deepEqual(await readSourceContent(f, workspaceSourceId, 'source.md'), source);
    assert.equal(await readFile(join(root, 'occupied.md'), 'utf8'), '# Keep same-source destination\n');
    assert.equal(await readFile(join(target, 'occupied.md'), 'utf8'), '# Keep cross-source destination\n');
  });

  it('rejects stale file revisions and stale source/destination configurations without redirecting a write to a replacement root', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const project = await createDocumentProject(f, 'Revision destination', 'revision-project');
    const root = join(f.parents[1], 'revision-source'), replacement = join(f.parents[1], 'revision-replacement');
    const target = join(f.parents[1], 'revision-target'), targetReplacement = join(f.parents[1], 'revision-target-replacement');
    for (const path of [root, replacement, target, targetReplacement]) await mkdir(path);
    await writeFile(join(root, 'edit.md'), '# Original\n'); await writeFile(join(replacement, 'edit.md'), '# Replacement root authority\n');
    const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0); const { sourceId: projectSourceId } = await configureDocumentSource(f, project.record.id, target, 0);
    const initial = await readSourceContent(f, workspaceSourceId, 'edit.md');
    assertDocumentSourceFailure(await post(f, workspaceSourceId, create('wrong-source-revision.md', '# Must not create\n', 2)), [409], 'document_source_revision_conflict');
    assertDocumentSourceFailure(await post(f, workspaceSourceId, { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'edit.md', expectedRevision: initial.revision, targetSourceId: projectSourceId, targetSourceRevision: 2, targetPath: 'wrong-target-revision.md' }), [409], 'document_source_revision_conflict');
    await missing(join(root, 'wrong-source-revision.md')); await missing(join(target, 'wrong-target-revision.md'));
    const saved = await mutateDocumentSource(f, workspaceSourceId, { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: 'edit.md', expectedRevision: initial.revision, content: '# First writer wins\n' });
    const staleActions: Exclude<DocumentSourceMutation, { action: 'create' }>[] = [
      { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: 'edit.md', expectedRevision: initial.revision, content: '# Stale overwrite\n' },
      { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: 'edit.md', expectedRevision: initial.revision },
      { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'edit.md', expectedRevision: initial.revision, targetSourceId: projectSourceId, targetSourceRevision: 1, targetPath: 'stale-move.md' },
    ];
    for (const input of staleActions) assertDocumentSourceFailure(await post(f, workspaceSourceId, input), [409], 'document_source_file_revision_conflict');
    assert.equal(await readFile(join(root, 'edit.md'), 'utf8'), saved.content!.content); await missing(join(target, 'stale-move.md'));
    await writeFile(join(root, 'edit.md'), '# Edited outside the API\n');
    for (const input of staleActions) assertDocumentSourceFailure(await post(f, workspaceSourceId, { ...input, operationId: randomUUID(), expectedRevision: saved.content!.revision }), [409], 'document_source_file_revision_conflict');
    assert.equal(await readFile(join(root, 'edit.md'), 'utf8'), '# Edited outside the API\n');
    const replacementSource = await configureDocumentSource(f, null, replacement, 1);
    assert.notEqual(replacementSource.sourceId, workspaceSourceId, 'A new root is a new association identity, never a redirected old source');
    for (const input of [create('stale-create.md'), ...staleActions]) assertDocumentSourceFailure(await post(f, workspaceSourceId, { ...input, operationId: randomUUID() }), [404, 409]);
    await missing(join(root, 'stale-create.md')); await missing(join(replacement, 'stale-create.md'));
    const current = await readSourceContent(f, replacementSource.sourceId, 'edit.md');
    await configureDocumentSource(f, project.record.id, targetReplacement, 1);
    assertDocumentSourceFailure(await post(f, replacementSource.sourceId, { operationId: randomUUID(), action: 'move', sourceRevision: replacementSource.revision, path: 'edit.md', expectedRevision: current.revision, targetSourceId: projectSourceId, targetSourceRevision: 1, targetPath: 'stale-target.md' }), [404, 409]);
    await missing(join(target, 'stale-target.md')); await missing(join(targetReplacement, 'stale-target.md'));
    assert.equal(await readFile(join(replacement, 'edit.md'), 'utf8'), '# Replacement root authority\n');
    await configureDocumentSources(f, null, [], 2);
    assertDocumentSourceFailure(await post(f, replacementSource.sourceId, create('after-unlink.md', '# Must not create\n', replacementSource.revision)), [404, 409]);
    await missing(join(replacement, 'after-unlink.md'));
  });

  it('recovers each original operation after discarded HTTP responses and restart, never replaying create/save/move/delete on an idempotent resend', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const project = await createDocumentProject(f, 'Response recovery destination', 'recovery-project');
    const root = join(f.parents[1], 'recovery-source'), target = join(f.parents[1], 'recovery-target');
    await mkdir(root); await mkdir(target);
    const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0); const { sourceId: projectSourceId } = await configureDocumentSource(f, project.record.id, target, 0);
    const attempts: { sourceId: string; input: DocumentSourceMutation; receipt: DocumentSourceMutationReceipt }[] = [];
    const first = create('original.md', '# First operation\n');
    await discardMutationResponse(f, workspaceSourceId, first);
    const created = await readDocumentSourceMutation(f, workspaceSourceId, first.operationId);
    assert.equal(created.status, 'succeeded'); assert.equal(created.content!.content, '# First operation\n');
    attempts.push({ sourceId: workspaceSourceId, input: first, receipt: created });
    const save: DocumentSourceMutation = { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: first.path, expectedRevision: created.content!.revision, content: '# Lost save response\n' };
    await discardMutationResponse(f, workspaceSourceId, save);
    const saved = await readDocumentSourceMutation(f, workspaceSourceId, save.operationId);
    assert.equal(saved.status, 'succeeded'); assert.equal(await readFile(join(root, first.path), 'utf8'), '# Lost save response\n');
    attempts.push({ sourceId: workspaceSourceId, input: save, receipt: saved });
    const move: DocumentSourceMutation = { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: first.path, expectedRevision: saved.content!.revision, targetSourceId: projectSourceId, targetSourceRevision: 1, targetPath: 'moved/receipt.md' };
    await discardMutationResponse(f, workspaceSourceId, move);
    const moved = await readDocumentSourceMutation(f, workspaceSourceId, move.operationId);
    assert.equal(moved.status, 'succeeded'); await missing(join(root, first.path));
    assert.equal(await readFile(join(target, move.targetPath), 'utf8'), '# Lost save response\n');
    attempts.push({ sourceId: workspaceSourceId, input: move, receipt: moved });
    const remove: DocumentSourceMutation = { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: move.targetPath, expectedRevision: moved.content!.revision };
    await discardMutationResponse(f, projectSourceId, remove);
    const deleted = await readDocumentSourceMutation(f, projectSourceId, remove.operationId);
    assert.equal(deleted.status, 'succeeded'); assert.equal(deleted.content, undefined);
    attempts.push({ sourceId: projectSourceId, input: remove, receipt: deleted });
    await f.restartApi();
    for (const { sourceId, input, receipt } of attempts) {
      assert.deepEqual(await readDocumentSourceMutation(f, sourceId, input.operationId), receipt);
      const replay = await post(f, sourceId, input);
      assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.deepEqual(replay.body, receipt);
    }
    await missing(join(root, first.path)); await missing(join(target, move.targetPath));
    assert.deepEqual((await collectDocumentFiles(f, workspaceSourceId)).entries, []);
    assert.deepEqual((await collectDocumentFiles(f, projectSourceId)).entries, []);
    assertDocumentSourceFailure(await f.request(documentSourceOperationsPath(f, workspaceSourceId, randomUUID())), [404], 'document_source_operation_not_found');
    assertDocumentSourceFailure(await f.request(documentSourceOperationsPath(f, projectSourceId, first.operationId)), [404]);
  });

  it('distinguishes authoritative no-effect from unknown disk outcomes and recovers durable proof after SQL receipt failure and an in-flight API SIGKILL', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'durable-proof'); await mkdir(root); const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0);
    const notDispatched = create('not-dispatched.md', '# Explicit retry after proven no effect\n');
    await f.pool.query(`CREATE FUNCTION fail_document_mutation_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id = '${notDispatched.operationId}'::uuid AND NEW.status = 'applying' THEN
        RAISE EXCEPTION 'isolated acceptance pre-dispatch failure' USING ERRCODE = '40001';
      END IF; RETURN NEW; END $$`);
    await f.pool.query('CREATE TRIGGER fail_document_mutation_dispatch BEFORE UPDATE ON document_source_operations FOR EACH ROW EXECUTE FUNCTION fail_document_mutation_dispatch()');
    try {
      assertDocumentSourceFailure(await post(f, workspaceSourceId, notDispatched), [503], 'document_source_operation_unavailable');
      await missing(join(root, notDispatched.path));
    } finally {
      await f.pool.query('DROP TRIGGER fail_document_mutation_dispatch ON document_source_operations');
      await f.pool.query('DROP FUNCTION fail_document_mutation_dispatch()');
    }
    await f.restartApi();
    const noEffect = await readDocumentSourceMutation(f, workspaceSourceId, notDispatched.operationId);
    assert.equal(noEffect.status, 'not_applied'); assert.equal(noEffect.content, undefined);
    const noEffectReplay = await post(f, workspaceSourceId, notDispatched);
    assert.equal(noEffectReplay.status, 200); assert.deepEqual(noEffectReplay.body, noEffect);
    await missing(join(root, notDispatched.path));
    await mutateDocumentSource(f, workspaceSourceId, { ...notDispatched, operationId: randomUUID() });
    assert.equal(await readFile(join(root, notDispatched.path), 'utf8'), '# Explicit retry after proven no effect\n');

    const input = create('committed-before-receipt.md', '# Disk was really committed\n');
    await f.pool.query(`CREATE FUNCTION fail_document_mutation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id = '${input.operationId}'::uuid AND NEW.status = 'succeeded' THEN
        RAISE EXCEPTION 'isolated acceptance final receipt failure' USING ERRCODE = '40001';
      END IF; RETURN NEW; END $$`);
    await f.pool.query('CREATE TRIGGER fail_document_mutation_receipt BEFORE UPDATE ON document_source_operations FOR EACH ROW EXECUTE FUNCTION fail_document_mutation_receipt()');
    try {
      const response = await post(f, workspaceSourceId, input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.status, 'unknown', 'A failed SQL receipt must not claim that the already-written disk file was rolled back');
      assert.equal(await readFile(join(root, input.path), 'utf8'), '# Disk was really committed\n');
    } finally {
      await f.pool.query('DROP TRIGGER fail_document_mutation_receipt ON document_source_operations');
      await f.pool.query('DROP FUNCTION fail_document_mutation_receipt()');
    }
    await f.restartApi();
    const recovered = await readDocumentSourceMutation(f, workspaceSourceId, input.operationId);
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.content!.content, '# Disk was really committed\n');
    assert.deepEqual((await post(f, workspaceSourceId, input)).body, recovered);

    const crashInput = create('committed-before-crash.md', '# Survives an API SIGKILL\n');
    const lock = randomInt(1, 2_147_483_647), blocker = await f.pool.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [lock]);
      await f.pool.query(`CREATE FUNCTION block_document_mutation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.operation_id = '${crashInput.operationId}'::uuid AND NEW.status = 'succeeded' THEN
          PERFORM pg_advisory_lock(${lock}); PERFORM pg_advisory_unlock(${lock});
        END IF; RETURN NEW; END $$`);
      await f.pool.query('CREATE TRIGGER block_document_mutation_receipt BEFORE UPDATE ON document_source_operations FOR EACH ROW EXECUTE FUNCTION block_document_mutation_receipt()');
      const pending = post(f, workspaceSourceId, crashInput).then(response => ({ response, error: undefined }), error => ({ response: undefined, error }));
      await localProjectEventually(async () => {
        const waiting = await f.pool.query('SELECT 1 FROM pg_locks WHERE locktype = $1 AND classid = 0 AND objid = $2 AND NOT granted', ['advisory', lock]);
        return waiting.rowCount! > 0;
      }, 'the API final receipt update blocked on the isolated PostgreSQL advisory lock', 20_000, f.signal);
      assert.equal(await readFile(join(root, crashInput.path), 'utf8'), '# Survives an API SIGKILL\n');
      await f.crashApi();
      const disconnected = await pending;
      assert.ok(disconnected.error, 'SIGKILL loses the actual outstanding HTTP response');
    } finally {
      try { await blocker.query('SELECT pg_advisory_unlock($1)', [lock]); }
      finally { blocker.release(); }
      await f.pool.query('DROP TRIGGER IF EXISTS block_document_mutation_receipt ON document_source_operations');
      await f.pool.query('DROP FUNCTION IF EXISTS block_document_mutation_receipt()');
    }
    await f.restartApi();
    const crashRecovered = await readDocumentSourceMutation(f, workspaceSourceId, crashInput.operationId);
    assert.equal(crashRecovered.status, 'succeeded'); assert.equal(crashRecovered.content!.content, '# Survives an API SIGKILL\n');
    assert.deepEqual((await post(f, workspaceSourceId, crashInput)).body, crashRecovered);
    assert.equal(await readFile(join(root, crashInput.path), 'utf8'), '# Survives an API SIGKILL\n');
  });

  it('rejects unsafe source and target paths, links, private directories and special entries without following, overwriting or deleting them', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'unsafe-mutations'), outside = join(f.parents[1], 'outside-mutations');
    await mkdir(root); await mkdir(outside);
    const secret = '# PRIVATE OUTSIDE BYTES\n';
    await writeFile(join(outside, 'secret.md'), secret); await writeFile(join(root, 'safe.md'), '# Safe source\n');
    const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0);
    const safe = await readSourceContent(f, workspaceSourceId, 'safe.md');
    const unsafePaths = ['../outside-mutations/secret.md', 'nested/../../outside-mutations/secret.md', 'nested/../safe.md', '/etc/secret.md', join(outside, 'secret.md'), '..\\outside-mutations\\secret.md', 'C:\\secret.md', 'a//b.md', './safe.md', 'non-markdown.txt', '.pm/core/private.md', '.git/config.md', '.ssh/key.md', '.aws/credentials.md', '.config/private.md', '.codex/private.md', '.claude/private.md', '.agent-workspace/private.md', 'provider-homes/account.md'];
    for (const path of unsafePaths) {
      const requests: DocumentSourceMutation[] = [
        create(path, '# Must never write\n'),
        { operationId: randomUUID(), action: 'save', sourceRevision: 1, path, expectedRevision: safe.revision, content: '# Must never overwrite\n' },
        { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path, expectedRevision: safe.revision },
        { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'safe.md', expectedRevision: safe.revision, targetSourceId: workspaceSourceId, targetSourceRevision: 1, targetPath: path },
      ];
      for (const input of requests) assertDocumentSourceFailure(await post(f, workspaceSourceId, input), [400, 403]);
    }
    await symlink(join(outside, 'secret.md'), join(root, 'leaf-link.md'), 'file');
    await symlink(join(root, 'safe.md'), join(root, 'internal-link.md'), 'file');
    await symlink(outside, join(root, 'linked-directory'), 'dir');
    await link(join(outside, 'secret.md'), join(root, 'hard-link.md'));
    await execute('mkfifo', [join(root, 'special-pipe.md')], { timeout: 5_000 });
    await mkdir(join(root, 'directory.md'));
    for (const path of ['leaf-link.md', 'internal-link.md', 'linked-directory/secret.md', 'hard-link.md', 'special-pipe.md', 'directory.md']) {
      for (const action of ['save', 'delete', 'move'] as const) {
        const input: DocumentSourceMutation = action === 'save'
          ? { operationId: randomUUID(), action, sourceRevision: 1, path, expectedRevision: safe.revision, content: '# Unsafe leaf write\n' }
          : action === 'delete'
            ? { operationId: randomUUID(), action, sourceRevision: 1, path, expectedRevision: safe.revision }
            : { operationId: randomUUID(), action, sourceRevision: 1, path, expectedRevision: safe.revision, targetSourceId: workspaceSourceId, targetSourceRevision: 1, targetPath: 'must-not-move.md' };
        assertDocumentSourceFailure(await post(f, workspaceSourceId, input), [403]);
      }
      assertDocumentSourceFailure(await post(f, workspaceSourceId, create(path)), [403, 409]);
      assertDocumentSourceFailure(await post(f, workspaceSourceId, { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'safe.md', expectedRevision: safe.revision, targetSourceId: workspaceSourceId, targetSourceRevision: 1, targetPath: path }), [403, 409]);
    }
    assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), secret);
    assert.equal(await readFile(join(root, 'safe.md'), 'utf8'), '# Safe source\n');
    assert.equal((await lstat(join(root, 'leaf-link.md'))).isSymbolicLink(), true);
    assert.equal((await lstat(join(root, 'linked-directory'))).isSymbolicLink(), true);
    assert.equal((await lstat(join(root, 'hard-link.md'))).nlink, 2);
    assert.equal((await lstat(join(root, 'special-pipe.md'))).isFIFO(), true);
    assert.equal((await lstat(join(root, 'directory.md'))).isDirectory(), true);
    await missing(join(root, 'must-not-move.md')); await missing(join(outside, 'must-not-move.md'));
    for (const path of ['.pm', '.git', '.ssh', '.aws', '.config', '.codex', '.claude', '.agent-workspace', 'provider-homes']) await missing(join(root, path));
  });

  it('accepts the full 4 MiB content boundary over real HTTP and rejects oversized UTF-8 writes without truncation', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'body-boundary'); await mkdir(root); const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0);
    const prefix = '# Full four MiB plain Markdown\n';
    const content = prefix + 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(prefix));
    const created = await mutateDocumentSource(f, workspaceSourceId, create('full-size.md', content));
    assert.equal(created.content!.size, 4 * 1024 * 1024);
    assert.equal((await readFile(join(root, 'full-size.md'))).byteLength, 4 * 1024 * 1024);
    assert.equal((await readSourceContent(f, workspaceSourceId, 'full-size.md')).content, content);
    const tooLarge = 'é'.repeat(2 * 1024 * 1024 + 1);
    assertDocumentSourceFailure(await post(f, workspaceSourceId, create('too-large.md', tooLarge)), [413]);
    assertDocumentSourceFailure(await post(f, workspaceSourceId, { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: 'full-size.md', expectedRevision: created.content!.revision, content: tooLarge }), [413]);
    await missing(join(root, 'too-large.md'));
    assert.equal(await readFile(join(root, 'full-size.md'), 'utf8'), content);
  });

  it('requires current read and planning-edit authorization for source, destination and original-operation queries without leaking host paths or bodies', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Allowed writable project', 'write-acl-a'), b = await createDocumentProject(f, 'Restricted writable project', 'write-acl-b');
    const scopes = [null, a.record.id, b.record.id];
    const roots = scopes.map((_, index) => join(f.parents[1], `write-acl-source-${index}`));
    const sourceIds: string[] = [];
    for (const [index, scope] of scopes.entries()) {
      await mkdir(roots[index]!); await writeFile(join(roots[index]!, 'same.md'), `PRIVATE_BODY_${scope}\n`);
      sourceIds.push((await configureDocumentSource(f, scope!, roots[index]!, 0)).sourceId);
    }
    const [workspaceSourceId, aSourceId, bSourceId] = sourceIds as [string, string, string];
    const reader = await f.member('Read-only external user'), scoped = await f.member('Scoped external editor');
    const blind = await f.member('Editor without read'), outsider = await f.member('No external membership');
    await f.command('SetWorkspaceMember', { userId: reader.user.id, capabilities: ['domain.read'], projectIds: null });
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: scoped.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] });
    await f.command('SetWorkspaceMember', { userId: blind.user.id, capabilities: ['planning.edit'], projectIds: null });
    assert.ok((await readDocumentSources(f, reader.cookie)).every(source => source.canWrite === false));
    const visible = await readDocumentSources(f, scoped.cookie);
    assert.deepEqual(visible.map(source => source.projectId), [a.record.id]); assert.equal(visible[0]!.canWrite, true); assert.equal(visible[0]!.canManage, false);
    const original = await readSourceContent(f, aSourceId, 'same.md');
    assert.equal((await readSourceContent(f, aSourceId, 'same.md', reader.cookie)).canWrite, false);
    const deniedInputs: DocumentSourceMutation[] = [
      create('denied-create.md'),
      { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: 'same.md', expectedRevision: original.revision, content: '# Denied write\n' },
      { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: 'same.md', expectedRevision: original.revision },
      { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'same.md', expectedRevision: original.revision, targetSourceId: aSourceId, targetSourceRevision: 1, targetPath: 'denied-move.md' },
    ];
    for (const cookie of [reader.cookie, blind.cookie, outsider.cookie, '']) for (const input of deniedInputs) {
      const denied = await post(f, aSourceId, input, cookie);
      assertDocumentSourceFailure(denied, cookie ? [403, 404] : [401]);
      assert.equal(JSON.stringify(denied.body).includes(f.root), false); assert.equal(JSON.stringify(denied.body).includes('PRIVATE_BODY'), false);
    }
    const allowed = await mutateDocumentSource(f, aSourceId, create('scoped-created.md', '# Scoped editor is allowed by default\n'), scoped.cookie);
    assert.equal(await readFile(join(roots[1]!, 'scoped-created.md'), 'utf8'), '# Scoped editor is allowed by default\n');
    for (const targetSourceId of [workspaceSourceId, bSourceId]) {
      assertDocumentSourceFailure(await post(f, aSourceId, { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'scoped-created.md', expectedRevision: allowed.content!.revision, targetSourceId, targetSourceRevision: 1, targetPath: 'forbidden-target.md' }, scoped.cookie), [403, 404]);
      assertDocumentSourceFailure(await post(f, targetSourceId, create('forbidden-source.md'), scoped.cookie), [403, 404]);
    }
    for (const cookie of [reader.cookie, outsider.cookie, '']) assertDocumentSourceFailure(await f.request(documentSourceOperationsPath(f, aSourceId, allowed.operationId), { cookie }), cookie ? [403, 404] : [401]);
    assert.equal((await readDocumentSourceMutation(f, aSourceId, allowed.operationId, scoped.cookie)).status, 'succeeded');
    for (const headers of [{ origin: 'https://hostile.example' }, { 'sec-fetch-site': 'cross-site' }]) assertDocumentSourceFailure(await f.request(documentSourceOperationsPath(f, workspaceSourceId), { method: 'POST', headers, body: create('cross-origin.md') }), [403]);
    const foreign = await createWorkspace(f.pool, outsider.user.id, 'Foreign write workspace');
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, workspaceSourceId, foreign.id)}/operations`, { method: 'POST', body: create('cross-workspace.md') }), [403, 404]);
    assertDocumentSourceFailure(await f.request(`${documentSourcesPath(f, aSourceId, foreign.id)}/operations/${allowed.operationId}`, { cookie: outsider.cookie }), [403, 404]);
    await f.command('RevokeWorkspaceMember', { userId: scoped.user.id }, { expectedVersions: { [scoped.user.id]: membership.version } });
    assertDocumentSourceFailure(await f.request(documentSourceOperationsPath(f, aSourceId, allowed.operationId), { cookie: scoped.cookie }), [403, 404]);
    assertDocumentSourceFailure(await post(f, aSourceId, { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: 'scoped-created.md', expectedRevision: allowed.content!.revision }, scoped.cookie), [403, 404]);
    for (const [index, scope] of scopes.entries()) {
      assert.equal(await readFile(join(roots[index]!, 'same.md'), 'utf8'), `PRIVATE_BODY_${scope}\n`);
      for (const path of ['denied-create.md', 'denied-move.md', 'forbidden-source.md', 'forbidden-target.md', 'cross-origin.md']) await missing(join(roots[index]!, path));
    }
  });

  it('applies finer project-subtree authorization to new paths as well as existing files and rechecks a moved receipt destination after scope revocation', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const a = await createDocumentProject(f, 'Allowed parent source project', 'allowed-subtree'), b = await createDocumentProject(f, 'Hidden project subtree', 'hidden-subtree');
    await writeFile(join(f.parents[0], 'shared.md'), '# Shared editable document\n');
    await writeFile(join(b.location.path!, 'secret.md'), '# PRIVATE_PROJECT_BODY\n');
    const { sourceId: aSourceId } = await configureDocumentSource(f, a.record.id, f.parents[0], 0);
    const target = join(f.parents[1], 'revoked-target'); await mkdir(target); const { sourceId: bSourceId } = await configureDocumentSource(f, b.record.id, target, 0);
    const editor = await f.member('Parent-source project editor');
    const membership = await f.command<{ version: number }>('SetWorkspaceMember', { userId: editor.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] });
    const shared = await readSourceContent(f, aSourceId, 'shared.md', editor.cookie);
    assert.equal(shared.canWrite, true);
    const hidden = 'hidden-subtree/secret.md';
    const hiddenInputs: DocumentSourceMutation[] = [
      create('hidden-subtree/new-directory/new.md'),
      { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: hidden, expectedRevision: shared.revision, content: '# Must stay secret\n' },
      { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: hidden, expectedRevision: shared.revision },
      { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: hidden, expectedRevision: shared.revision, targetSourceId: aSourceId, targetSourceRevision: 1, targetPath: 'leaked.md' },
      { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'shared.md', expectedRevision: shared.revision, targetSourceId: aSourceId, targetSourceRevision: 1, targetPath: 'hidden-subtree/new-directory/moved.md' },
    ];
    for (const input of hiddenInputs) {
      const denied = await post(f, aSourceId, input, editor.cookie);
      assertDocumentSourceFailure(denied, [403, 404]);
      assert.equal(JSON.stringify(denied.body).includes('PRIVATE_PROJECT_BODY'), false); assert.equal(JSON.stringify(denied.body).includes(f.root), false);
    }
    await missing(join(b.location.path!, 'new-directory')); await missing(join(f.parents[0], 'leaked.md'));
    assert.equal(await readFile(join(b.location.path!, 'secret.md'), 'utf8'), '# PRIVATE_PROJECT_BODY\n');
    assert.equal(await readFile(join(f.parents[0], 'shared.md'), 'utf8'), '# Shared editable document\n');
    const expanded = await f.command<{ version: number }>('SetWorkspaceMember', { userId: editor.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id, b.record.id] }, { expectedVersions: { [editor.user.id]: membership.version } });
    const moved = await mutateDocumentSource(f, aSourceId, { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'shared.md', expectedRevision: shared.revision, targetSourceId: bSourceId, targetSourceRevision: 1, targetPath: 'private-after-revocation.md' }, editor.cookie);
    assert.equal((await readDocumentSourceMutation(f, aSourceId, moved.operationId, editor.cookie)).status, 'succeeded');
    await f.command('SetWorkspaceMember', { userId: editor.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [a.record.id] }, { expectedVersions: { [editor.user.id]: expanded.version } });
    const receiptDenied = await f.request(documentSourceOperationsPath(f, aSourceId, moved.operationId), { cookie: editor.cookie });
    assertDocumentSourceFailure(receiptDenied, [403, 404]);
    assert.equal(JSON.stringify(receiptDenied.body).includes('Shared editable document'), false);
    assert.equal(await readFile(join(target, 'private-after-revocation.md'), 'utf8'), '# Shared editable document\n');
  });

  it('fails closed on replaced directories, unwritable parents, missing roots and replacement root identities, never recreating the configured source', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal });
    t.after(() => f.close());
    const root = join(f.parents[1], 'identity-mutation-source'), outside = join(f.parents[1], 'identity-outside');
    await mkdir(join(root, 'nested'), { recursive: true }); await mkdir(outside);
    await writeFile(join(root, 'nested', 'edit.md'), '# Original directory leaf\n'); await writeFile(join(outside, 'edit.md'), '# Outside directory leaf\n');
    const { sourceId: workspaceSourceId } = await configureDocumentSource(f, null, root, 0);
    const original = await readSourceContent(f, workspaceSourceId, 'nested/edit.md');
    await rename(join(root, 'nested'), join(root, 'nested-original')); await symlink(outside, join(root, 'nested'), 'dir');
    const inputs: DocumentSourceMutation[] = [
      create('nested/new/deep.md'),
      { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: 'nested/edit.md', expectedRevision: original.revision, content: '# No redirect\n' },
      { operationId: randomUUID(), action: 'delete', sourceRevision: 1, path: 'nested/edit.md', expectedRevision: original.revision },
      { operationId: randomUUID(), action: 'move', sourceRevision: 1, path: 'nested/edit.md', expectedRevision: original.revision, targetSourceId: workspaceSourceId, targetSourceRevision: 1, targetPath: 'moved.md' },
    ];
    for (const input of inputs) assertDocumentSourceFailure(await post(f, workspaceSourceId, input), [403]);
    assert.equal(await readFile(join(outside, 'edit.md'), 'utf8'), '# Outside directory leaf\n'); await missing(join(outside, 'new'));
    await rm(join(root, 'nested')); await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'edit.md'), '# Original directory leaf\n');
    assertDocumentSourceFailure(await post(f, workspaceSourceId, { operationId: randomUUID(), action: 'save', sourceRevision: 1, path: 'nested/edit.md', expectedRevision: original.revision, content: '# Stale directory identity\n' }), [409], 'document_source_file_revision_conflict');
    await rm(join(root, 'nested'), { recursive: true }); await rename(join(root, 'nested-original'), join(root, 'nested'));
    await mkdir(join(root, 'read-only')); await chmod(join(root, 'read-only'), 0o555);
    try { assertDocumentSourceFailure(await post(f, workspaceSourceId, create('read-only/new.md')), [403]); }
    finally { await chmod(join(root, 'read-only'), 0o755); }
    await rename(root, `${root}-original`);
    for (const input of inputs) assertDocumentSourceFailure(await post(f, workspaceSourceId, { ...input, operationId: randomUUID() }), [409], 'document_source_unavailable');
    await missing(root);
    await f.restartApi();
    assertDocumentSourceFailure(await post(f, workspaceSourceId, create('new/after-restart.md')), [409], 'document_source_unavailable'); await missing(root);
    await mkdir(root); await writeFile(join(root, 'replacement.md'), '# Different root inode\n');
    assertDocumentSourceFailure(await post(f, workspaceSourceId, create('new/replacement-write.md')), [409], 'document_source_unavailable');
    assert.equal(await readFile(join(root, 'replacement.md'), 'utf8'), '# Different root inode\n'); await missing(join(root, 'new'));
    assert.equal(await readFile(join(`${root}-original`, 'nested', 'edit.md'), 'utf8'), '# Original directory leaf\n');
    await rm(root, { recursive: true }); await symlink(outside, root, 'dir');
    assertDocumentSourceFailure(await post(f, workspaceSourceId, create('new/symlink-root.md')), [403, 409]);
    await missing(join(outside, 'new'));
    assert.equal((await lstat(root)).isSymbolicLink(), true);
  });
});
