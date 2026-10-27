import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../packages/pm-core/index.ts';
import { defaultConfiguration, entityKinds, parseConfiguration } from '../packages/pm-schema/index.ts';
import { applyCreationResult, creationComplete, creationFieldIssues, creationHasRemainingNativeWrites, creationRequest, decodeCreationDrafts, editCreationDraft, editRejectedChild, editRejectedCreation, hasUncertainCreationDrafts, initialCreationValues, newCreationDraft, prepareCreationAttempt, resumableCreationDraft, type CreationDraft, type NativeCreationAttempt } from '../apps/web/src/features/pm/markdown/creation-model.ts';
import { createCreationStore, type CreationStorage } from '../apps/web/src/features/pm/markdown/creation-store.ts';

class BrowserStorage implements CreationStorage {
  values: Record<string, string> = {};
  blocked = false;
  getItem(key: string) { return this.values[key] ?? null; }
  setItem(key: string, value: string) { if (this.blocked) throw new Error('quota exceeded'); this.values[key] = value; }
}

const key = 'pm-core:host:workspace:actor:creation-drafts';
const configuration = parseConfiguration({ schema: 'pm/config/v1', custom_fields: [
  { name: 'x-score', label: 'Score', entities: ['work_item'], type: 'number', min: 0, max: 10, default: 0 },
  { name: 'x-audience', label: 'Audience', entities: ['document'], type: 'multi_select', options: ['human', 'agent'], default: ['human'] },
] });

function editableDraft(id = 'local-draft'): CreationDraft {
  const draft = newCreationDraft(id, configuration, { entity: 'work_item', project: 'PRJ-1', due: '2028-02-29', watch: true }, 1);
  return editCreationDraft(draft, { values: { ...draft.values, title: 'Real intent', 'x-pm-start': '2028-02-28', 'x-pm-estimate': 0, 'x-pm-location': 'Building A' }, body: 'Keep [[PRJ-1]] and **Markdown**.\n\n```pm-view\nentity: work_item\nlayout: table\n```\n' });
}
function frozen(draft: CreationDraft, phase: NativeCreationAttempt['phase'] = 'unknown'): CreationDraft {
  return { ...draft, attempt: { ...prepareCreationAttempt(creationRequest(draft.kind, draft.values, draft.body, configuration), `key:${draft.draftId}`), phase } };
}

test('one creation request keeps source, explicit zero and configured defaults without client identities', () => {
  const draft = editableDraft();
  const request = creationRequest(draft.kind, { ...draft.values, id: 'TASK-999', schema: 'pm/v1', 'x-pm-command-id': 'not-owned-by-ui' }, draft.body, configuration);
  assert.equal(request.body, draft.body);
  assert.equal(request['x-score'], 0);
  assert.equal(request['x-pm-estimate'], 0);
  assert.equal(request['x-pm-start'], '2028-02-28');
  assert.equal(request.due, '2028-02-29');
  assert.equal(request['x-pm-location'], 'Building A');
  for (const name of ['id', 'schema', 'x-pm-command-id']) assert.equal(Object.hasOwn(request, name), false);
  assert.equal(Object.hasOwn(newCreationDraft('global', configuration).values, 'project'), false, 'global creation never chooses the first project');
  const attempt = prepareCreationAttempt(request, 'stable-key');
  request.body = 'Later text';
  assert.equal(attempt.request.body, draft.body, 'the request is a frozen snapshot, not an editable object alias');
});

test('automatic creation recovery stays in its originating project even when another project has an unknown attempt', () => {
  const workspaceDraft = newCreationDraft('workspace', configuration, {}, 1);
  workspaceDraft.values = { ...workspaceDraft.values, title: 'Workspace choice', project: 'PRJ-2' };
  const first = newCreationDraft('first', configuration, { project: 'PRJ-1' }, 2);
  const second = frozen(newCreationDraft('second', configuration, { project: 'PRJ-2' }, 3));
  const moved = newCreationDraft('moved', configuration, { project: 'PRJ-1' }, 4);
  moved.values.project = 'PRJ-2';
  const drafts = { workspace: workspaceDraft, first, second, moved };
  assert.equal(resumableCreationDraft(drafts, 'work_item', '')?.draftId, 'workspace', 'refreshing workspace creation retains its deliberate project choice');
  assert.equal(resumableCreationDraft(drafts, 'work_item', 'PRJ-1')?.draftId, 'first', 'a sibling unknown request and changed project never replace this project draft');
  assert.equal(resumableCreationDraft(drafts, 'work_item', 'PRJ-2')?.draftId, 'second');
  assert.equal(resumableCreationDraft(drafts, 'work_item', 'PRJ-3'), undefined);
  assert.equal(hasUncertainCreationDrafts(drafts), true, 'separate recovery candidates do not bypass the global uncertain-write guard');
  assert.equal(second.attempt?.phase, 'unknown');
  assert.equal(second.attempt?.key, 'key:second');
});

test('every registered entity retains configuration-driven fields instead of a task-only persistence shape', () => {
  for (const kind of entityKinds) {
    const values = initialCreationValues(kind, configuration, { project: 'PRJ-1' });
    values.title = `Create ${kind}`;
    const request = creationRequest(kind, values, `Markdown for ${kind}`, configuration);
    assert.equal(request.entity, kind);
    assert.equal(request.title, values.title);
    assert.equal(request.body, `Markdown for ${kind}`);
    if (kind === 'work_item') assert.equal(request['x-score'], 0);
    if (kind === 'document') assert.deepEqual(request['x-audience'], ['human']);
    assert.equal(Object.hasOwn(request, 'id'), false);
  }
});

test('preflight distinguishes leap dates, one-sided dates, explicit zero, custom field errors and missing project', () => {
  const draft = editableDraft();
  assert.deepEqual(creationFieldIssues('work_item', draft.values, configuration), []);
  assert.equal(creationFieldIssues('work_item', { ...draft.values, 'x-pm-start': null }, configuration).length, 0);
  assert.equal(creationFieldIssues('work_item', { ...draft.values, due: null }, configuration).length, 0);
  for (const values of [
    { ...draft.values, due: '2027-02-29' },
    { ...draft.values, due: '2028-02-27' },
    { ...draft.values, 'x-pm-estimate': -1 },
    { ...draft.values, 'x-pm-estimate': Number.POSITIVE_INFINITY },
    { ...draft.values, 'x-pm-location': 'x'.repeat(1001) },
    { ...draft.values, 'x-score': 11 },
    { ...draft.values, project: null },
  ]) assert.ok(creationFieldIssues('work_item', values, configuration).length > 0);
});

test('a failed durable preparation never replaces editable memory or records permission to dispatch', () => {
  const storage = new BrowserStorage();
  const store = createCreationStore(key, storage);
  const draft = editableDraft();
  assert.equal(store.update(current => ({ ...current, [draft.draftId]: draft })), true);
  storage.blocked = true;
  assert.equal(store.commit(current => ({ ...current, [draft.draftId]: frozen(current[draft.draftId]!, 'prepared') })), false);
  assert.equal(store.getSnapshot()[draft.draftId]!.attempt, undefined);
  assert.equal(store.persistenceError(), true);
  assert.equal(decodeCreationDrafts(storage.getItem(key))[draft.draftId]!.attempt, undefined);
  assert.equal(store.update(current => ({ ...current, [draft.draftId]: editCreationDraft(current[draft.draftId]!, { body: 'Retain unsaved text while storage is blocked' }) })), false);
  assert.equal(store.getSnapshot()[draft.draftId]!.body, 'Retain unsaved text while storage is blocked');
  storage.blocked = false;
  assert.equal(store.update(current => current), true);
  assert.equal(decodeCreationDrafts(storage.getItem(key))[draft.draftId]!.body, 'Retain unsaved text while storage is blocked');
});

test('a second tab refreshes before editing and cannot overwrite an already frozen request', () => {
  const storage = new BrowserStorage();
  const first = createCreationStore(key, storage);
  const draft = editableDraft();
  first.update(() => ({ [draft.draftId]: draft }));
  const second = createCreationStore(key, storage);
  first.commit(current => ({ ...current, [draft.draftId]: frozen(current[draft.draftId]!, 'sending') }));
  assert.throws(() => second.update(current => ({ ...current, [draft.draftId]: editCreationDraft(current[draft.draftId]!, { body: 'Must not replace original' }) })), /frozen/);
  const restored = createCreationStore(key, storage).getSnapshot()[draft.draftId]!;
  assert.equal(restored.attempt!.phase, 'unknown');
  assert.equal(restored.attempt!.key, `key:${draft.draftId}`);
  assert.equal(restored.attempt!.request.body, draft.body);
  assert.throws(() => editRejectedCreation(restored), /confirmed rejected/);
});

test('pending and not-found native results retain their original key and cannot unlock a replacement', () => {
  const draft = frozen(editableDraft());
  let attempt = draft.attempt!;
  for (const result of [{ status: 'not_found' } as const, { status: 'pending', reason: 'audit_pending' } as const, { status: 'pending', reason: 'write_unconfirmed' } as const]) {
    attempt = applyCreationResult(attempt, result);
    assert.equal(attempt.phase, 'unknown');
    assert.equal(attempt.key, draft.attempt!.key);
    assert.deepEqual(attempt.request, draft.attempt!.request);
    assert.equal(hasUncertainCreationDrafts({ draft: { ...draft, attempt } }), true);
    assert.throws(() => editRejectedCreation({ ...draft, attempt }), /confirmed rejected/);
  }
  const rejected = { ...draft, attempt: applyCreationResult(attempt, { status: 'rejected' }) };
  assert.equal(editRejectedCreation(rejected).attempt, undefined);
  assert.equal(editRejectedCreation(rejected).body, draft.body);
});

test('parent-child partial recovery never resets the confirmed parent or successful siblings', () => {
  const parent = frozen(editableDraft());
  parent.attempt = applyCreationResult(parent.attempt!, { status: 'committed', entityId: 'TASK-10', revision: 'original-parent-revision', current: { status: 'deleted' } });
  parent.children = [
    { draftId: 'local-child-a', values: { title: 'First child' }, body: '', attempt: { ...prepareCreationAttempt({ title: 'First child', parent: 'TASK-10' }, 'child-a'), phase: 'committed', entityId: 'TASK-11', revision: 'child-a-revision' } },
    { draftId: 'local-child-b', values: { title: 'Second child' }, body: '', attempt: { ...prepareCreationAttempt({ title: 'Second child', parent: 'TASK-10' }, 'child-b'), phase: 'unknown' } },
  ];
  const restored = decodeCreationDrafts(JSON.stringify({ [parent.draftId]: parent }))[parent.draftId]!;
  assert.equal(creationComplete(restored), false);
  assert.equal(resumableCreationDraft({ [parent.draftId]: restored, unrelated: newCreationDraft('unrelated', defaultConfiguration, { entity: 'document' }) }, 'document')!.draftId, parent.draftId);
  assert.throws(() => editRejectedChild(restored, 'local-child-b'), /confirmed rejected/);
  restored.children[1]!.attempt = applyCreationResult(restored.children[1]!.attempt!, { status: 'rejected' });
  const repaired = editRejectedChild(restored, 'local-child-b');
  assert.deepEqual(repaired.attempt, restored.attempt);
  assert.deepEqual(repaired.children[0], restored.children[0]);
  assert.equal(repaired.children[1]!.attempt, undefined);
  assert.equal(repaired.children[1]!.values.title, 'Second child');
  assert.equal(repaired.attempt!.entityId, 'TASK-10');
  assert.equal(repaired.attempt!.revision, 'original-parent-revision');
  assert.throws(() => editRejectedCreation(repaired), /confirmed rejected/);
});

test('corrupt recovery storage blocks writes rather than pretending no unknown intent exists', () => {
  const storage = new BrowserStorage();
  storage.values[key] = '{"broken":true}';
  const store = createCreationStore(key, storage);
  assert.equal(store.persistenceError(), true);
  assert.equal(store.commit(() => ({ new: editableDraft('new') })), false);
  assert.equal(storage.values[key], '{"broken":true}');
  assert.throws(() => decodeCreationDrafts('{invalid JSON'));
});

test('the shared creation request writes real Markdown once and keeps original commit evidence after later edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-creation-model-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  await workspace.saveConfiguration(configuration, workspace.configuration().revision);
  const project = await workspace.createEntity({ entity: 'project', title: 'Authorized native project' });
  const draft = editableDraft();
  draft.values.project = project.id;
  const attempt = prepareCreationAttempt(creationRequest('work_item', draft.values, draft.body, configuration), 'stable-roundtrip-key');
  const file = await workspace.createEntity(attempt.request, attempt.key);
  assert.equal((await workspace.createEntity(attempt.request, attempt.key)).id, file.id);
  assert.equal(workspace.snapshot().files.filter(item => item.entity.entity === 'work_item').length, 1);
  assert.equal(file.entity['x-pm-estimate'], 0);
  assert.equal(file.entity['x-score'], 0);
  assert.equal(file.entity['x-pm-start'], '2028-02-28');
  assert.equal(file.entity.due, '2028-02-29');
  assert.equal(file.entity['x-pm-location'], 'Building A');
  assert.ok(file.raw.includes(draft.body.trim()));
  const later = await workspace.patch(file.id, { priority: 'high' }, file.revision);
  const confirmed = applyCreationResult(attempt, { status: 'committed', entityId: file.id, revision: file.revision, current: { status: 'present', record: later } });
  assert.equal(confirmed.revision, file.revision);
  assert.notEqual(confirmed.revision, later.revision);
  assert.equal(confirmed.entityId, file.id);
  assert.equal(confirmed.phase, 'committed');
});

test('personal-watch recovery remains a distinct command and cannot turn a native commit into group success', () => {
  const draft = frozen(editableDraft());
  draft.attempt = applyCreationResult(draft.attempt!, { status: 'committed', entityId: 'TASK-10', revision: 'native-revision', current: { status: 'missing' } });
  draft.watchAttempt = {
    command: { commandId: '619b15ca-0dce-4cd1-84da-0ec26be209bd', commandType: 'WatchTask', projectId: 'PRJ-1', payload: { taskId: 'TASK-10' } },
    phase: 'sending', message: '',
  };
  const restored = decodeCreationDrafts(JSON.stringify({ [draft.draftId]: draft }))[draft.draftId]!;
  assert.equal(restored.watchAttempt!.phase, 'unknown');
  assert.equal(restored.watchAttempt!.command.commandId, draft.watchAttempt.command.commandId);
  assert.equal(restored.attempt!.entityId, 'TASK-10');
  assert.equal(creationHasRemainingNativeWrites(restored), false, 'watch-only recovery does not revalidate or recreate native content');
  assert.equal(creationComplete(restored), false);
  assert.equal(hasUncertainCreationDrafts({ [restored.draftId]: restored }), true);
  restored.watchAttempt!.phase = 'rejected';
  assert.equal(creationComplete(restored), false, 'confirmed watch rejection does not erase the requested action');
  restored.watch = false;
  assert.equal(creationComplete(restored), true, 'explicitly declining a rejected optional watch preserves native success');
  assert.equal(restored.attempt!.revision, 'native-revision');
});
