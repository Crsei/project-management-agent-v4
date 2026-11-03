import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentSource, DocumentSourceContent, DocumentSourceMutation, DocumentSourceMutationReceipt } from '../../../../../../packages/contracts/src/document-sources.ts';
import { DocumentSourceRequestError } from './document-sources-api.ts';
import { createExternalDocumentStore, externalDocumentKey, restoreExternalDocumentTarget, validExternalMarkdownPath, type ExternalTarget } from './external-document-state.ts';

const source: DocumentSource = { sourceId: 'workspace', projectId: null, name: 'Workspace', path: null, revision: 3, status: 'available', canManage: false, canWrite: true };
const target: ExternalTarget = { kind: 'external', sourceId: 'workspace', revision: 3, path: 'private-title.md' };
const base: DocumentSourceContent = { path: target.path, content: 'Original plain Markdown\n', size: 24, modifiedAt: '2026-11-03T00:00:00.000Z', sourceRevision: 3, revision: 'file-v1', canWrite: true };
const operationId = '5ab0375c-3616-43b8-bd2a-d91b33451fa3';
const input = { operationId, sourceRevision: 3, action: 'save', path: target.path, expectedRevision: base.revision, content: 'Secret unsaved draft\n' } satisfies DocumentSourceMutation;
const success: DocumentSourceMutationReceipt = { operationId, action: 'save', path: target.path, status: 'succeeded', content: { ...base, content: input.content, revision: 'file-v2' } };
function fixture() {
  let stored = '[]';
  let current = true;
  let writes = 0;
  let queries = 0;
  let mutate: (sourceId: string, value: DocumentSourceMutation) => Promise<DocumentSourceMutationReceipt> = async () => success;
  let reconcile: (sourceId: string, id: string) => Promise<DocumentSourceMutationReceipt> = async () => success;
  const dependencies = { storage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } }, storageKey: 'identities-only', current: () => current, mutate: async (sourceId: string, value: DocumentSourceMutation) => { writes++; return mutate(sourceId, value); }, reconcile: async (sourceId: string, id: string) => { queries++; return reconcile(sourceId, id); } };
  const store = createExternalDocumentStore(dependencies);
  store.receive(target, source, base);
  store.edit(target, input.content);
  return { store, dependencies, stored: () => stored, writes: () => writes, queries: () => queries, setCurrent: (value: boolean) => { current = value; }, setMutate: (value: typeof mutate) => { mutate = value; }, setReconcile: (value: typeof reconcile) => { reconcile = value; } };
}

test('refresh retains dirty plaintext and original CAS until explicit observed-revision adoption', () => {
  const f = fixture();
  const observed = { ...base, revision: 'someone-else-v2', content: 'Changed on disk\n' };
  f.store.receive(target, source, observed);
  let draft = f.store.getSnapshot().drafts[externalDocumentKey(target)]!;
  assert.equal(draft.value, input.content);
  assert.equal(draft.base.revision, base.revision);
  assert.equal(draft.observed?.content, observed.content);
  f.store.adopt(target);
  draft = f.store.getSnapshot().drafts[externalDocumentKey(target)]!;
  assert.equal(draft.base.revision, observed.revision);
  assert.equal(draft.value, input.content);
  assert.equal(draft.observed, undefined);
});

test('lost mutation response journals only identity, blocks a new mutation and reconciles without replay', async () => {
  const f = fixture();
  f.setMutate(async () => { throw new TypeError('response lost'); });
  await assert.rejects(f.store.submit('workspace', input), /response lost/);
  assert.equal(f.writes(), 1);
  assert.equal(f.store.getSnapshot().operations[0]?.phase, 'unknown');
  assert.deepEqual(JSON.parse(f.stored()), [{ sourceId: 'workspace', operationId, action: 'save' }]);
  assert.ok(!f.stored().includes(target.path));
  assert.ok(!f.stored().includes(input.content));
  await assert.rejects(f.store.submit('workspace', { ...input, operationId: crypto.randomUUID() }), /operation_pending/);
  assert.equal(f.writes(), 1);
  f.setReconcile(async (_scope, id) => { assert.equal(id, operationId); return success; });
  await f.store.reconcile(operationId);
  assert.equal(f.queries(), 1);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.store.getSnapshot().operations, []);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(target)]?.base.revision, 'file-v2');
  assert.equal(f.stored(), '[]');
});

test('reload restores an unknown identity but never restores plaintext or blindly retries a missing receipt', async () => {
  const f = fixture();
  f.setMutate(async () => { throw new TypeError('lost'); });
  await assert.rejects(f.store.submit('workspace', input));
  const recovered = createExternalDocumentStore(f.dependencies);
  assert.deepEqual(recovered.getSnapshot().drafts, {});
  assert.equal(recovered.getSnapshot().operations[0]?.input, undefined);
  f.setReconcile(async () => { throw new DocumentSourceRequestError(404, 'document_source_operation_not_found'); });
  await recovered.reconcile(operationId);
  assert.equal(recovered.getSnapshot().operations[0]?.phase, 'unknown');
  assert.equal(recovered.blocks('workspace'), true);
  assert.equal(f.writes(), 1);
  f.setReconcile(async () => ({ operationId, action: 'save', path: target.path, status: 'not_applied' }));
  await recovered.reconcile(operationId);
  assert.equal(recovered.blocks('workspace'), false);
  assert.equal(recovered.getSnapshot().notice, 'not_applied');
  assert.equal(f.writes(), 1);
});

test('definitive collision rejection preserves both file and form drafts and releases only the rejected attempt', async () => {
  const f = fixture();
  f.store.form('create', { sourceId: 'workspace', path: 'collision.md', content: 'New file draft' });
  f.setMutate(async () => { throw new DocumentSourceRequestError(409, 'document_source_collision'); });
  await assert.rejects(f.store.submit('workspace', input), cause => cause instanceof DocumentSourceRequestError && cause.status === 409);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(target)]?.value, input.content);
  assert.equal(f.store.getSnapshot().forms.create?.content, 'New file draft');
  assert.equal(f.store.blocks('workspace'), false);
  assert.equal(f.stored(), '[]');
});

test('unavailable recovery storage prevents dispatch and retains unsaved text', async () => {
  let writes = 0;
  const store = createExternalDocumentStore({ storage: { getItem: () => '[]', setItem: () => { throw new Error('quota'); } }, storageKey: 'journal', current: () => true, mutate: async () => { writes++; return success; }, reconcile: async () => success });
  store.receive(target, source, base); store.edit(target, input.content);
  await assert.rejects(store.submit('workspace', input), /journal_unavailable/);
  assert.equal(writes, 0);
  assert.equal(store.getSnapshot().drafts[externalDocumentKey(target)]?.value, input.content);
});

test('source revocation clears cached plaintext and frozen payload but retains safe unknown identity', async () => {
  const f = fixture();
  f.setMutate(async () => { throw new TypeError('lost'); });
  await assert.rejects(f.store.submit('workspace', input));
  f.store.authorize([]);
  assert.deepEqual(f.store.getSnapshot().drafts, {});
  assert.equal(f.store.getSnapshot().operations[0]?.input, undefined);
  assert.ok(!JSON.stringify(f.store.getSnapshot()).includes(input.content));
  assert.equal(f.store.getSnapshot().operations[0]?.operationId, operationId);
  assert.equal(f.store.getSnapshot().notice, 'access_cleared');
});

test('late success cannot repopulate a departed identity with receipt plaintext', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<DocumentSourceMutationReceipt>();
  f.setMutate(() => pending.promise);
  const submission = f.store.submit('workspace', input);
  f.setCurrent(false); f.store.clearSource();
  pending.resolve(success);
  await submission;
  assert.deepEqual(f.store.getSnapshot().drafts, {});
  assert.deepEqual(f.store.getSnapshot().completions, []);
});

test('a mismatched move receipt remains unresolved instead of retargeting tabs to another file', async () => {
  const f = fixture();
  const move: DocumentSourceMutation = { operationId, sourceRevision: 3, action: 'move', path: target.path, expectedRevision: base.revision, targetSourceId: 'PRJ-001', targetSourceRevision: 2, targetPath: 'nested/renamed.md' };
  f.setMutate(async () => ({ operationId, action: 'move', path: target.path, status: 'succeeded', targetSourceId: 'PRJ-002', targetPath: move.targetPath, content: { ...base, path: move.targetPath, sourceRevision: 2 } }));
  await assert.rejects(f.store.submit('workspace', move), /invalid_response/);
  assert.equal(f.store.blocks('workspace'), true);
  assert.equal(f.store.blocks('PRJ-001'), true);
  assert.deepEqual(f.store.getSnapshot().completions, []);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(target)]?.value, input.content);
});

test('relative Markdown paths preserve Unicode and spaces without allowing traversal or host paths', () => {
  for (const path of ['中文 笔记/README.MD', 'notes/plain.md']) assert.equal(validExternalMarkdownPath(path), true);
  for (const path of ['../file.md', 'notes/../file.md', 'notes//file.md', '/file.md', 'C:\\file.md', 'notes\\file.md', 'notes/./file.md', 'file.txt']) assert.equal(validExternalMarkdownPath(path), false, path);
});

test('an unrecorded operation lookup is not permission revocation and does not discard dirty text', async () => {
  const f = fixture();
  f.setMutate(async () => { throw new TypeError('lost'); });
  await assert.rejects(f.store.submit('workspace', input));
  f.setReconcile(async () => { throw new DocumentSourceRequestError(404, 'document_source_operation_not_found'); });
  await f.store.reconcile(operationId);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(target)]?.value, input.content);
  assert.equal(f.store.getSnapshot().operations[0]?.phase, 'unknown');
});

test('confirmed historical success without authorized content resolves identity and clears cached plaintext', async () => {
  const f = fixture();
  f.setMutate(async () => { throw new TypeError('lost'); });
  await assert.rejects(f.store.submit('workspace', input));
  f.setReconcile(async () => ({ operationId, action: 'save', path: target.path, status: 'succeeded' }));
  await f.store.reconcile(operationId);
  assert.deepEqual(f.store.getSnapshot().drafts, {});
  assert.deepEqual(f.store.getSnapshot().operations, []);
  assert.equal(f.store.getSnapshot().notice, 'succeeded_unreadable');
  assert.equal(f.stored(), '[]');
  assert.equal(f.writes(), 1);
});

test('a corrupt recovery journal fails closed instead of silently forgetting unknown operations', async () => {
  let writes = 0;
  const store = createExternalDocumentStore({ storage: { getItem: () => JSON.stringify([{ operationId, sourceId: 'workspace', action: 'unrecognized' }]), setItem: () => {} }, storageKey: 'journal', current: () => true, mutate: async () => { writes++; return success; }, reconcile: async () => success });
  await assert.rejects(store.submit('workspace', input), /journal_unavailable/);
  assert.equal(writes, 0);
  assert.equal(store.getSnapshot().notice, 'journal_unavailable');
});

test('explicit recreation updates the missing-file draft baseline only after confirmed creation', async () => {
  const f = fixture();
  const create: DocumentSourceMutation = { operationId, sourceRevision: 3, action: 'create', path: target.path, content: input.content };
  f.setMutate(async () => ({ ...success, action: 'create' }));
  await f.store.submit('workspace', create);
  const draft = f.store.getSnapshot().drafts[externalDocumentKey(target)]!;
  assert.equal(draft.value, input.content);
  assert.equal(draft.base.revision, 'file-v2');
  assert.equal(draft.value, draft.base.content);
});

test('a move cannot overwrite an unsaved destination draft even when the disk destination is absent', async () => {
  const f = fixture();
  const destination: ExternalTarget = { kind: 'external', sourceId: 'PRJ-001', revision: 2, path: 'missing.md' };
  f.store.receive(destination, { ...source, sourceId: destination.sourceId, projectId: 'PRJ-001', revision: 2 }, { ...base, path: destination.path, sourceRevision: 2 });
  f.store.edit(destination, 'Retained destination draft');
  const move: DocumentSourceMutation = { operationId, sourceRevision: 3, action: 'move', path: target.path, expectedRevision: base.revision, targetSourceId: destination.sourceId, targetSourceRevision: 2, targetPath: destination.path };
  await assert.rejects(f.store.submit('workspace', move), cause => cause instanceof DocumentSourceRequestError && cause.code === 'document_source_destination_draft_conflict');
  assert.equal(f.writes(), 0);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(destination)]?.value, 'Retained destination draft');
  assert.equal(f.stored(), '[]');
});

test('legacy pending identities migrate to sourceId without replay or changing operation identity', async () => {
  const destinationId = '22c49071-9a4d-4656-b014-3c4aa621de48';
  const secondOperationId = 'c1862c67-2441-48f1-b718-83a6827f810d';
  let persisted = JSON.stringify([{ scope: 'workspace', operationId, action: 'move', targetScope: destinationId }, { sourceId: destinationId, operationId: secondOperationId, action: 'save' }]);
  let writes = 0;
  const queries: string[][] = [];
  const store = createExternalDocumentStore({
    storage: { getItem: () => persisted, setItem: (_key, value) => { persisted = value; } },
    storageKey: 'journal', current: () => true,
    mutate: async () => { writes++; return success; },
    reconcile: async (sourceId, id) => { queries.push([sourceId, id]); return { operationId: id, action: 'move', path: 'old.md', targetSourceId: destinationId, targetPath: 'new.md', status: 'not_applied' }; },
  });
  assert.equal(store.getSnapshot().operations.length, 2);
  assert.equal(store.getSnapshot().operations[0]?.sourceId, 'workspace');
  assert.equal(store.getSnapshot().operations[0]?.targetSourceId, destinationId);
  assert.equal(store.blocks('unrelated-authorized-alias'), true);
  assert.ok(!persisted.includes('targetScope'));
  assert.ok(!persisted.includes('"scope"'));
  await store.reconcile(operationId);
  assert.deepEqual(queries, [['workspace', operationId]]);
  assert.equal(writes, 0);
  assert.deepEqual(JSON.parse(persisted), [{ sourceId: destinationId, operationId: secondOperationId, action: 'save' }]);
  assert.equal(store.blocks('workspace'), true, 'Another unknown alias operation still blocks writes');
});

test('a mixed corrupt journal preserves its raw unknown blockers and every recoverable identity', async () => {
  const raw = JSON.stringify([{ scope: 'workspace', operationId, action: 'save' }, { sourceId: 'future-source', operationId: 'future-operation', action: 'future-action' }]);
  let writes = 0, journalWrites = 0;
  const store = createExternalDocumentStore({
    storage: { getItem: () => raw, setItem: () => { journalWrites++; } }, storageKey: 'journal', current: () => true,
    mutate: async () => { writes++; return success; }, reconcile: async () => success,
  });
  assert.equal(store.getSnapshot().operations[0]?.operationId, operationId);
  assert.equal(store.blocks('any-authorized-folder'), true);
  assert.equal(store.protected(), true);
  await assert.rejects(store.submit('workspace', input), /journal_unavailable/);
  assert.equal(writes, 0);
  assert.equal(journalWrites, 0);
});

test('legacy tab targets migrate once and opaque IDs never imply project ownership', () => {
  assert.deepEqual(restoreExternalDocumentTarget({ kind: 'external', scope: 'PRJ-001', revision: 3, path: 'old.md' }), { kind: 'external', sourceId: 'PRJ-001', revision: 3, path: 'old.md' });
  assert.deepEqual(restoreExternalDocumentTarget(target), target);
  assert.equal(restoreExternalDocumentTarget({ ...target, sourceId: '../secret' }), undefined);
  assert.equal(restoreExternalDocumentTarget({ ...target, revision: 0 }), undefined);
  assert.equal(restoreExternalDocumentTarget({ ...target, scope: 'different-source' }), undefined);
  const f = fixture();
  f.store.authorize([{ ...source, sourceId: 'different-folder', projectId: null }]);
  assert.deepEqual(f.store.getSnapshot().drafts, {});
});

test('late successful receipt cannot repopulate plaintext after source authorization changes', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<DocumentSourceMutationReceipt>();
  f.setMutate(() => pending.promise);
  const submission = f.store.submit('workspace', input);
  f.store.authorize([]);
  pending.resolve(success);
  await submission;
  assert.deepEqual(f.store.getSnapshot().drafts, {});
  assert.equal(f.store.getSnapshot().completions[0]?.receipt.content, undefined);
  assert.equal(f.store.getSnapshot().completions[0]?.input, undefined);
  assert.equal(f.stored(), '[]');
});

test('successful move retargets the draft and uses the destination source metadata', async () => {
  const f = fixture();
  const destination = { ...source, sourceId: 'destination-folder', projectId: 'PRJ-001', name: 'Destination directory', revision: 9 };
  f.store.edit(target, base.content);
  f.store.authorize([source, destination]);
  const move: DocumentSourceMutation = { operationId, action: 'move', sourceRevision: 3, path: target.path, expectedRevision: base.revision, targetSourceId: destination.sourceId, targetSourceRevision: destination.revision, targetPath: 'renamed.md' };
  f.setMutate(async () => ({ operationId, action: 'move', status: 'succeeded', path: target.path, targetSourceId: destination.sourceId, targetPath: move.targetPath, content: { ...base, path: move.targetPath, sourceRevision: destination.revision } }));
  await f.store.submit(source.sourceId, move);
  const moved = { kind: 'external' as const, sourceId: destination.sourceId, revision: destination.revision, path: move.targetPath };
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(target)], undefined);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(moved)]?.source.sourceId, destination.sourceId);
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(moved)]?.source.projectId, 'PRJ-001');
  assert.equal(f.store.blocks(destination.sourceId), false);
});

test('successful deletion removes only the selected source document draft', async () => {
  const f = fixture();
  f.setMutate(async () => ({ operationId, action: 'delete', path: target.path, status: 'succeeded' }));
  await f.store.submit(source.sourceId, { operationId, action: 'delete', sourceRevision: source.revision, path: target.path, expectedRevision: base.revision });
  assert.equal(f.store.getSnapshot().drafts[externalDocumentKey(target)], undefined);
  assert.equal(f.store.getSnapshot().completions[0]?.receipt.action, 'delete');
  assert.equal(f.stored(), '[]');
});

test('temporary journal write failure can be retried after storage recovers without losing a draft', async () => {
  let unavailable = true, persisted = '[]', writes = 0;
  const store = createExternalDocumentStore({
    storage: { getItem: () => persisted, setItem: (_key, value) => { if (unavailable) throw new Error('quota'); persisted = value; } },
    storageKey: 'journal', current: () => true, mutate: async () => { writes++; return success; }, reconcile: async () => success,
  });
  store.receive(target, source, base);
  store.edit(target, input.content);
  await assert.rejects(store.submit(source.sourceId, input), /journal_unavailable/);
  assert.equal(writes, 0);
  assert.equal(store.getSnapshot().drafts[externalDocumentKey(target)]?.value, input.content);
  unavailable = false;
  await store.submit(source.sourceId, input);
  assert.equal(writes, 1);
  assert.equal(persisted, '[]');
});
