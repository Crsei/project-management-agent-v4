import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfiguration, entityKinds, type FileRecord } from '../../../../../../packages/pm-schema/index.ts';
import { applyLocalProjectResult, creationComplete, creationFieldIssues, creationRequest, decodeCreationDrafts, editCreationDraft, newCreationDraft, prepareCreationAttempt } from './creation-model.ts';
import { createCreationStore } from './creation-store.ts';

const record: FileRecord = { id: 'PRJ-001', path: 'project-roots/PRJ-001/core/projects/PRJ-001.md', revision: 'revision-1', raw: '# Real project\n', entity: { schema: 'pm/v1', entity: 'project', id: 'PRJ-001', title: 'Real project', body: '', blocked_by: [], related_to: [], labels: [], links: [], checklist: [], views: [] } };

test('refresh preserves the exact project directory, input and key and never releases an unknown initialization', () => {
  let draft = newCreationDraft('draft-one', defaultConfiguration, { entity: 'project' });
  draft = editCreationDraft(draft, { values: { ...draft.values, title: 'Project', owner: 'owner', start: '2026-10-24', due: '2026-11-01', 'x-pm-icon': 'rocket', 'x-pm-color': '#23918A' }, body: 'Original description', localDirectory: { mode: 'new', parentPath: '/authorized/projects', folderName: 'one' } });
  const request = creationRequest('project', draft.values, draft.body, defaultConfiguration);
  draft.attempt = { ...prepareCreationAttempt(request, 'original-key'), phase: 'sending', localDirectory: draft.localDirectory };
  const restored = decodeCreationDrafts(JSON.stringify({ 'draft-one': draft }))['draft-one']!;
  assert.equal(restored.attempt!.phase, 'unknown');
  assert.deepEqual(restored.attempt!.request, request);
  assert.equal(restored.attempt!.request['x-pm-icon'], 'rocket');
  assert.equal(restored.attempt!.request['x-pm-color'], '#23918A');
  assert.equal(restored.attempt!.request.owner, 'owner');
  assert.equal(restored.attempt!.request.due, '2026-11-01');
  assert.equal(restored.attempt!.request.body, 'Original description');
  assert.deepEqual(restored.attempt!.localDirectory, draft.localDirectory);
  for (const result of [{ status: 'not_found' as const }, { status: 'pending' as const, key: 'original-key', operation: 'initialize' as const, reason: 'storage_pending' as const }]) {
    const reconciled = applyLocalProjectResult(restored.attempt!, result);
    assert.equal(reconciled.phase, 'unknown');
    assert.equal(reconciled.key, 'original-key');
    assert.deepEqual(reconciled.request, request);
    assert.deepEqual(reconciled.localDirectory, draft.localDirectory);
    assert.throws(() => editCreationDraft({ ...restored, attempt: reconciled }, { body: 'replacement' }), /frozen/);
    assert.throws(() => editCreationDraft({ ...restored, attempt: reconciled }, { localDirectory: { mode: 'existing', path: 'C:\\different-project' } }), /frozen/);
  }
});

test('only a matching ready initialization with available storage completes project creation', () => {
  const draft = newCreationDraft('project-draft', defaultConfiguration, { entity: 'project' });
  const attempt = { ...prepareCreationAttempt({ entity: 'project', title: 'Project' }, 'key-one'), phase: 'unknown' as const, localDirectory: { mode: 'existing' as const, path: '/authorized/existing' } };
  const ready = { status: 'ready' as const, operation: 'initialize' as const, key: 'key-one', record, location: { projectId: record.id, kind: 'local' as const, storageId: 'storage-one', path: '/authorized/existing', status: 'available' as const } };
  assert.equal(creationComplete({ ...draft, attempt: applyLocalProjectResult(attempt, { ...ready, location: { ...ready.location, status: 'unavailable' } }) }), false);
  assert.equal(creationComplete({ ...draft, attempt: applyLocalProjectResult(attempt, { ...ready, key: 'other-key' }) }), false);
  const completed = applyLocalProjectResult(attempt, ready);
  assert.equal(creationComplete({ ...draft, attempt: completed }), true);
  assert.equal(completed.entityId, record.id);
  assert.equal(completed.revision, record.revision);
});

test('unfinished path entry survives refresh without corrupting recovery storage; quota failure cannot authorize dispatch', () => {
  const draft = { ...newCreationDraft('draft-one', defaultConfiguration, { entity: 'project' }), localDirectory: { mode: 'new' as const, parentPath: '', folderName: '' } };
  assert.deepEqual(decodeCreationDrafts(JSON.stringify({ 'draft-one': draft }))['draft-one']!.localDirectory, draft.localDirectory);
  const values: Record<string, string> = {};
  let full = false;
  const store = createCreationStore('actor:workspace:host', { getItem: key => values[key] ?? null, setItem: (key, value) => { if (full) throw new Error('quota'); values[key] = value; } });
  assert.equal(store.commit(() => ({ 'draft-one': draft })), true);
  full = true;
  assert.equal(store.commit(current => ({ ...current, 'draft-one': { ...draft, attempt: prepareCreationAttempt({ entity: 'project', title: 'P' }, 'unsent-key') } })), false);
  assert.equal(store.getSnapshot()['draft-one']!.attempt, undefined);
  assert.equal(store.persistenceError(), true);
});

test('all nine entity kinds keep native field mapping and project folder inputs do not leak into task fields', () => {
  for (const kind of entityKinds) {
    const draft = newCreationDraft(`draft-${kind}`, defaultConfiguration, { entity: kind });
    const request = creationRequest(kind, { ...draft.values, title: kind, localDirectory: '/not-a-native-field' }, 'Markdown body', defaultConfiguration);
    assert.equal(request.entity, kind);
    assert.equal(request.body, 'Markdown body');
    assert.equal(request.localDirectory, undefined);
  }
});

test('project lead and target date remain in the native input for both supported Windows save modes', () => {
  const draft = newCreationDraft('windows-project', defaultConfiguration, { entity: 'project' });
  const values = { ...draft.values, title: 'Windows project', owner: 'authorized-lead', due: '2028-02-29', 'x-pm-icon': 'target', 'x-pm-color': '#3B82C4' };
  assert.deepEqual(creationFieldIssues('project', values, defaultConfiguration), []);
  for (const directory of [{ mode: 'new' as const, parentPath: 'C:\\Projects', folderName: '计划' }, { mode: 'existing' as const, path: 'D:\\Existing project' }]) {
    const request = creationRequest('project', values, 'Actual Markdown description', defaultConfiguration);
    const attempt = { ...prepareCreationAttempt(request, `windows-${directory.mode}`), phase: 'sending' as const, localDirectory: directory };
    const restored = decodeCreationDrafts(JSON.stringify({ [draft.draftId]: { ...draft, values, body: request.body, localDirectory: directory, attempt } }))[draft.draftId]!;
    assert.equal(restored.attempt!.request.owner, values.owner);
    assert.equal(restored.attempt!.request.due, values.due);
    assert.equal(restored.attempt!.request['x-pm-icon'], values['x-pm-icon']);
    assert.equal(restored.attempt!.request['x-pm-color'], values['x-pm-color']);
    assert.deepEqual(restored.attempt!.localDirectory, directory);
    assert.equal(restored.attempt!.request.localDirectory, undefined);
    assert.equal(restored.attempt!.phase, 'unknown');
  }
});

test('project optional fields may be cleared without invented lead, date, icon or color', () => {
  const draft = newCreationDraft('blank-project', defaultConfiguration, { entity: 'project' });
  const values = { ...draft.values, title: 'Only a name', owner: null, due: null, 'x-pm-icon': null, 'x-pm-color': null };
  assert.deepEqual(creationFieldIssues('project', values, defaultConfiguration), []);
  const request = creationRequest('project', values, '', defaultConfiguration);
  for (const field of ['owner', 'due', 'x-pm-icon', 'x-pm-color']) assert.equal(Object.hasOwn(request, field), false);
  assert.ok(creationFieldIssues('project', { ...values, due: '2027-02-29' }, defaultConfiguration).some(issue => issue.field === 'due'));
  assert.ok(creationFieldIssues('project', { ...values, title: '' }, defaultConfiguration).some(issue => issue.field === 'title'));
});
