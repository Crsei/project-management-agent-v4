import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfiguration, workflowFor } from '../packages/pm-schema/index.ts';
import { inspectFrontmatter, parseMarkdown } from '../packages/pm-markdown/index.ts';
import { applyDocumentUploadReceipt, captureDocumentObjectSource, createDocumentObjectStore, decodeDocumentObjectJournal, documentAttachmentMarkdown, documentObjectSourceMatches, documentTaskReference, documentTaskTitle, flushDocumentTaskFields, recoverDocumentTaskReference, relatedDocumentDraft, type DocumentObjectStorage, type DocumentTaskAction, type DocumentUploadAction } from '../apps/web/src/features/pm/markdown/document-object-model.ts';
import { createCreationStore } from '../apps/web/src/features/pm/markdown/creation-store.ts';
import { creationRequest, editCreationDraft, newCreationDraft, prepareCreationAttempt } from '../apps/web/src/features/pm/markdown/creation-model.ts';

const raw = '---\nschema: pm/v1\nid: DOC-001\nentity: document\nproject: PRJ-001\nrelated_to: []\nx-preserve: "unknown YAML" # keep comment\n---\n# Source\n\n- [ ] 原始😀选区\n\nUntouched **draft**.\n';
const body = inspectFrontmatter(raw).body;
const text = '- [ ] 原始😀选区';
const from = body.indexOf(text);
const source = captureDocumentObjectSource('DOC-001', raw, 'revision-a', { text, from, to: from + text.length });

class BrowserStorage implements DocumentObjectStorage {
  values: Record<string, string> = {};
  blocked = false;
  getItem(key: string) { return this.values[key] ?? null; }
  setItem(key: string, value: string) { if (this.blocked) throw new Error('quota exceeded'); this.values[key] = value; }
}
function stagedAction(): DocumentUploadAction {
  return { kind: 'upload', id: 'upload-intent', source, projectId: 'PRJ-001', name: 'real file.png', mediaType: 'image/png', phase: 'staging', step: 'stage', commandId: 'stage-command', error: '', inserted: false };
}

test('conversion confirmation durably flushes complete buffered title and project after partial keystroke backups', () => {
  const storage = new BrowserStorage();
  const store = createCreationStore('creation', storage);
  const draft = newCreationDraft('conversion-draft', defaultConfiguration, { entity: 'work_item', project: 'PRJ-001' });
  draft.body = `${text}\n\nSource: [[DOC-001]]`;
  draft.values = { ...draft.values, title: '# Cre', related_to: ['DOC-001'] };
  store.commit(current => ({ ...current, [draft.draftId]: draft }));
  for (const title of ['C', 'Co', 'Con']) store.update(current => ({ ...current, [draft.draftId]: editCreationDraft(current[draft.draftId]!, { values: { ...current[draft.draftId]!.values, title } }) }));
  const title = 'Converted from Markdown acceptance';
  flushDocumentTaskFields(store, draft.draftId, { title, project: 'PRJ-002' });
  const flushed = store.getSnapshot()[draft.draftId]!;
  assert.equal(flushed.values.title, title);
  assert.equal(flushed.values.project, 'PRJ-002');
  assert.equal(flushed.body, draft.body);
  assert.deepEqual(flushed.values.related_to, ['DOC-001']);
  const request = creationRequest(flushed.kind, flushed.values, flushed.body, defaultConfiguration);
  assert.equal(request.title, title);
  assert.equal(request.project, 'PRJ-002');
  assert.equal(createCreationStore('creation', storage).getSnapshot()[draft.draftId]!.values.title, title);
  flushDocumentTaskFields(store, draft.draftId, { title: '输入法组合完成后的完整任务标题', project: 'PRJ-002' });
  assert.equal(store.getSnapshot()[draft.draftId]!.values.title, '输入法组合完成后的完整任务标题');
  storage.blocked = true;
  assert.throws(() => flushDocumentTaskFields(store, draft.draftId, { title: 'must not dispatch', project: 'PRJ-001' }), /No create was sent/);
  storage.blocked = false;
  store.commit(current => ({ ...current, [draft.draftId]: { ...current[draft.draftId]!, attempt: { ...prepareCreationAttempt(request, 'original-request'), phase: 'unknown' } } }));
  assert.throws(() => flushDocumentTaskFields(store, draft.draftId, { title: 'must not overwrite unknown', project: 'PRJ-001' }), /frozen/);
  assert.equal(store.getSnapshot()[draft.draftId]!.attempt!.key, 'original-request');
});

test('selection checkpoints use body UTF16 and reject stale text, ranges, revisions and document switches', () => {
  assert.equal(source.selection.to - source.selection.from, text.length);
  assert.equal(documentObjectSourceMatches(source, captureDocumentObjectSource('DOC-001', raw, 'revision-a', source.selection)), true);
  const unsavedRaw = `${raw}\nNew unsaved text`;
  const unsavedSelection = { text: 'New unsaved text', from: inspectFrontmatter(unsavedRaw).body.indexOf('New unsaved text'), to: inspectFrontmatter(unsavedRaw).body.length };
  const unsavedSource = captureDocumentObjectSource('DOC-001', unsavedRaw, 'revision-a', unsavedSelection);
  assert.equal(documentObjectSourceMatches(unsavedSource, captureDocumentObjectSource('DOC-001', unsavedRaw, 'revision-a', unsavedSelection)), true, 'a shared unsaved raw draft is a valid selection authority');
  for (const current of [
    { ...source, id: 'DOC-002' },
    { ...source, raw: raw + '\nexternal edit' },
    { ...source, revision: 'revision-b' },
    { ...source, selection: { ...source.selection, from: from + 1 } },
    { ...source, selection: { ...source.selection, text: 'changed' } },
  ]) assert.equal(documentObjectSourceMatches(source, current), false);
  assert.throws(() => captureDocumentObjectSource('DOC-001', raw, 'revision-a', { ...source.selection, text: 'stale' }), /stale/);
  assert.throws(() => captureDocumentObjectSource('DOC-001', raw, 'revision-a', { text: '', from: -1, to: -1 }), /stale/);
});

test('formal relation edits share raw draft while preserving body, extension values and comments', () => {
  const next = relatedDocumentDraft(raw, 'TASK-001', defaultConfiguration);
  assert.equal(inspectFrontmatter(next).body, body);
  assert.ok(next.includes('x-preserve: "unknown YAML" # keep comment'));
  assert.deepEqual(parseMarkdown(next).related_to, ['TASK-001']);
  assert.equal(relatedDocumentDraft(next, 'TASK-001', defaultConfiguration), next);
  assert.throws(() => relatedDocumentDraft(raw, 'DOC-001', defaultConfiguration), /itself/);
});

test('task references retain unchecked and checked source state rather than completing a task', () => {
  assert.equal(documentTaskTitle(text), '原始😀选区');
  assert.equal(documentTaskReference(text, 'TASK-001'), `${text} [[TASK-001]]`);
  assert.equal(documentTaskReference('- [x] already checked', 'TASK-001'), '- [x] already checked [[TASK-001]]');
  assert.equal(documentTaskReference('one\ntwo', 'TASK-001'), 'one\ntwo\n\n[[TASK-001]]');
  assert.throws(() => documentTaskTitle(' \n '), /Select text/);
});

test('interrupted stage and registration retain the original command and become unknown on remount', () => {
  const action = stagedAction();
  for (const phase of ['staging', 'registering'] as const) {
    const restored = decodeDocumentObjectJournal(JSON.stringify({ [action.id]: { ...action, phase } }))[action.id];
    assert.equal(restored?.kind, 'upload');
    if (restored?.kind !== 'upload') throw new Error('Expected upload');
    assert.equal(restored.phase, 'unknown');
    assert.equal(restored.commandId, 'stage-command');
    assert.deepEqual(restored.source, source);
  }
  assert.throws(() => decodeDocumentObjectJournal('{corrupt'), SyntaxError);
  assert.throws(() => decodeDocumentObjectJournal(JSON.stringify({ other: action })), /identity mismatch/);
});

test('only matching real receipts progress staging and immutable version registration', () => {
  const action = stagedAction();
  assert.throws(() => applyDocumentUploadReceipt(action, { commandId: 'different', status: 'committed', httpStatus: 200, result: {} }), /another upload/);
  const staged = applyDocumentUploadReceipt(action, { commandId: 'stage-command', status: 'committed', httpStatus: 200, result: { upload: { id: 'REAL-UPLOAD', version: 3 } } });
  assert.equal(staged.phase, 'staged');
  assert.equal(staged.uploadId, 'REAL-UPLOAD');
  assert.equal(staged.uploadVersion, 3);
  const registration = { ...staged, step: 'register' as const, commandId: 'register-command', phase: 'registering' as const };
  const done = applyDocumentUploadReceipt(registration, { commandId: 'register-command', status: 'committed', httpStatus: 200, result: { artifactVersion: { id: 'IMMUTABLE-VERSION' } } });
  assert.equal(done.phase, 'done');
  assert.equal(done.versionId, 'IMMUTABLE-VERSION');
  const rejected = applyDocumentUploadReceipt(registration, { commandId: 'register-command', status: 'rejected', httpStatus: 409, error: { code: 'version_conflict', message: 'Real rejection' } });
  assert.equal(rejected.phase, 'rejected');
  assert.equal(rejected.uploadId, 'REAL-UPLOAD');
  assert.throws(() => applyDocumentUploadReceipt(action, { commandId: 'stage-command', status: 'committed', httpStatus: 200, result: { upload: { id: 'fake-without-version' } } }));
});

test('durable checkpoints cannot authorize dispatch on quota failure and preserve inserted references across remount', () => {
  const storage = new BrowserStorage();
  const store = createDocumentObjectStore('journal', storage);
  const action = stagedAction();
  storage.blocked = true;
  assert.equal(store.commit(current => ({ ...current, [action.id]: action })), false);
  assert.equal(store.persistenceError(), true);
  assert.equal(store.getSnapshot()[action.id], undefined);
  storage.blocked = false;
  assert.equal(store.commit(current => ({ ...current, [action.id]: action })), true);
  assert.equal(store.commit(current => ({ ...current, [action.id]: { ...action, phase: 'done', versionId: 'REAL-VERSION', inserted: true } })), true);
  const restored = createDocumentObjectStore('journal', storage).getSnapshot()[action.id];
  assert.equal(restored?.inserted, true);
  assert.equal(restored?.kind === 'upload' && restored.versionId, 'REAL-VERSION');
  assert.equal(store.commit(current => ({ ...current, [action.id]: { ...action, phase: 'done', versionId: 'REAL-VERSION', inserted: true, insertion: 'reserved' } })), true);
  storage.blocked = true;
  assert.equal(store.commit(current => ({ ...current, [action.id]: { ...action, phase: 'done', versionId: 'REAL-VERSION', inserted: true, insertion: 'inserted' } })), false);
  storage.blocked = false;
  const uncertainInsertion = createDocumentObjectStore('journal', storage).getSnapshot()[action.id];
  assert.equal(uncertainInsertion?.inserted, true, 'lost insertion acknowledgement must not authorize another insertion after remount');
  assert.equal(uncertainInsertion?.insertion, 'reserved');
  storage.values.corrupt = '{broken';
  const corrupt = createDocumentObjectStore('corrupt', storage);
  assert.equal(corrupt.commit(() => ({})), false);
  assert.equal(storage.values.corrupt, '{broken');
});

test('a lost completion callback recovers only one real source-linked task and never treats absence as failure', () => {
  const action: DocumentTaskAction = { kind: 'task', id: 'document-task:digest', source, draftId: 'document-conversion:digest', inserted: false };
  const taskRaw = raw.replace('id: DOC-001', 'id: TASK-002').replace('entity: document', `entity: work_item\nstatus: ${workflowFor('work_item', defaultConfiguration)!.initial}`).replace('related_to: []', 'related_to: [DOC-001]') + '\n<!-- pm-document-conversion:digest -->\n';
  const file = { id: 'TASK-002', path: 'work-items/TASK-002.md', revision: 'real-returned-revision', raw: taskRaw, entity: parseMarkdown(taskRaw) };
  assert.equal(recoverDocumentTaskReference(action, [file]), file);
  assert.throws(() => recoverDocumentTaskReference(action, []), /does not prove failure/);
  assert.throws(() => recoverDocumentTaskReference(action, [{ ...file, entity: { ...file.entity, related_to: [] } }]), /does not prove failure/);
  assert.throws(() => recoverDocumentTaskReference(action, [file, { ...file, id: 'TASK-003' }]), /More than one/);
});

test('attachments contain immutable IDs only; unsafe image formats remain authenticated downloads', () => {
  assert.equal(documentAttachmentMarkdown('version/1', 'real [image].png', 'image/png'), '![real \\[image\\].png](pm-attachment:version%2F1)');
  for (const mediaType of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
    const markdown = documentAttachmentMarkdown('real-version', 'file', mediaType);
    assert.equal(markdown, '[file](pm-attachment:real-version)');
    assert.equal(markdown.includes('data:'), false);
    assert.equal(markdown.includes('token'), false);
  }
  for (const mediaType of ['application/pdf', 'audio/mpeg', 'video/mp4']) assert.equal(documentAttachmentMarkdown('real-version', 'file', mediaType), '![file](pm-attachment:real-version)');
});
