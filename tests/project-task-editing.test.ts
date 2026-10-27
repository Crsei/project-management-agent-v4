import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, ProtocolError, type FileRecord, type WorkspaceSnapshot } from '../packages/pm-schema/index.ts';
import { Workspace, WorkspaceError } from '../packages/pm-core/index.ts';
import { adoptProjectTaskDraft, hasUncertainProjectTaskDraft, observeProjectTaskDraft, prepareProjectTaskPatch, preserveUncertainProjectTaskDrafts, projectTaskChangesSchema, projectTaskDraftValue, projectTaskWriteProblem, readProjectTaskDraft, type ProjectTaskChanges, type ProjectTaskDraft, type ProjectTaskWriteContext } from '../apps/web/src/features/pm/service/project-task-editing-model.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'project-task-editing-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  return workspace;
}
function attempt(file: FileRecord, changes: ProjectTaskChanges): ProjectTaskDraft {
  return { projectId: file.entity.project!, baseRaw: file.raw, revision: file.revision, changes, phase: 'editing', message: '' };
}
function source(id: string, fields = ''): FileRecord {
  const raw = `---\nschema: pm/v1\nid: ${id}\nentity: ${id.startsWith('PRJ') ? 'project' : 'work_item'}\n${fields}---\n# ${id}\n\nPreserve this body.\n`;
  return { id, path: `${id}.md`, raw, revision: `${id}:revision`, entity: parseMarkdown(raw) };
}
function snapshot(files: FileRecord[]): WorkspaceSnapshot {
  return { files, errors: [], views: [], unsupportedFiles: [], configuration: defaultConfiguration, configurationRevision: 'configuration', configurationErrors: [] };
}
function writeContext(files: FileRecord[]): ProjectTaskWriteContext {
  return { projectId: 'PRJ-1', snapshot: snapshot(files), canWrite: true, locked: false, readError: false, sourceDrafts: {} };
}
function backup(draft: ProjectTaskDraft) {
  return { raw: draft.baseRaw, revision: draft.revision, projectTaskEditing: draft };
}

test('project task fields and custom board workflow write the same native file with its real revision', async t => {
  const workspace = await fixture(t);
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'queued', states: [{ id: 'queued', label: 'Queue', category: 'unstarted' }, { id: 'building', label: 'Building', category: 'started' }, { id: 'shipped', label: 'Shipped', category: 'completed' }],
    transitions: [{ from: 'queued', to: 'building' }, { from: 'building', to: 'shipped' }],
  } }, custom_fields: [] });
  await workspace.saveConfiguration(configuration, workspace.configuration().revision);
  const project = await workspace.createEntity({ entity: 'project', title: 'Native project' });
  const file = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Native task', body: 'Keep this acceptance text.' });
  const draft = attempt(file, { title: 'Inline title', status: 'building', assignee: 'actual-member-id', priority: 'high', 'x-pm-start': '2026-10-20', due: '2026-10-22' });
  const prepared = prepareProjectTaskPatch(file, draft, configuration, workspace.snapshot().files);
  const updated = await workspace.patch(file.id, prepared.changes, draft.revision);
  assert.equal(updated.entity.status, 'building');
  assert.equal(updated.entity.title, 'Inline title');
  assert.equal(updated.entity.assignee, 'actual-member-id');
  assert.equal(updated.entity['x-pm-start'], '2026-10-20');
  assert.equal(updated.entity.due, '2026-10-22');
  assert.ok(updated.raw.includes('Keep this acceptance text.'));
  assert.notEqual(updated.revision, file.revision);
  assert.equal(workspace.get(file.id).raw, updated.raw);
  assert.equal(workspace.get(project.id).entity.status, project.entity.status, 'task completion does not close its project');
  const next = prepareProjectTaskPatch(updated, attempt(updated, { status: 'shipped' }), configuration, workspace.snapshot().files);
  assert.equal((await workspace.patch(file.id, next.changes, updated.revision)).entity.status, 'shipped', 'native completion does not require the old SQL review workflow');
});

test('illegal workflow transitions and invalid date pairs preserve the attempted fields without mutating source', async t => {
  const workspace = await fixture(t);
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'queued', states: [{ id: 'queued', label: 'Queue', category: 'unstarted' }, { id: 'building', label: 'Build', category: 'started' }, { id: 'shipped', label: 'Ship', category: 'completed' }],
    transitions: [{ from: 'queued', to: 'building' }],
  } }, custom_fields: [] });
  await workspace.saveConfiguration(configuration, workspace.configuration().revision);
  const project = await workspace.createEntity({ entity: 'project', title: 'Project' });
  const file = await workspace.createEntity({ entity: 'work_item', title: 'Task', project: project.id });
  const rejected = attempt(file, { status: 'shipped' });
  assert.throws(() => prepareProjectTaskPatch(file, rejected, configuration, workspace.snapshot().files), error => error instanceof ProtocolError && error.diagnostics.some(issue => issue.code === 'TRANSITION_NOT_ALLOWED'));
  assert.equal(rejected.changes.status, 'shipped');
  assert.equal(projectTaskDraftValue(file, rejected, 'status'), 'shipped');
  assert.throws(() => prepareProjectTaskPatch(file, attempt(file, { 'x-pm-start': '2026-10-22', due: '2026-10-20' }), configuration, workspace.snapshot().files), /due date/);
  assert.equal(workspace.get(file.id).raw, file.raw);
});

test('native revision conflicts keep the draft baseline until explicit adoption and preserve unrelated remote fields', async t => {
  const workspace = await fixture(t);
  const project = await workspace.createEntity({ entity: 'project', title: 'Project' });
  const original = await workspace.createEntity({ entity: 'work_item', title: 'Task', project: project.id });
  const retained = attempt(original, { title: 'My rejected title', due: '2026-11-01' });
  const remote = await workspace.patch(original.id, { assignee: 'remote-assignee' }, original.revision);
  assert.throws(() => prepareProjectTaskPatch(remote, retained, workspace.configuration().config, workspace.snapshot().files), /revision changed/);
  await assert.rejects(workspace.patch(original.id, retained.changes, retained.revision), error => error instanceof WorkspaceError && error.diagnostics.some(issue => issue.code === 'REVISION_CONFLICT'));
  assert.equal(retained.revision, original.revision);
  assert.equal(projectTaskDraftValue(remote, retained, 'title'), 'My rejected title');
  const adopted = adoptProjectTaskDraft(remote, { ...retained, phase: 'conflict' });
  assert.equal(adopted.revision, remote.revision);
  const prepared = prepareProjectTaskPatch(remote, adopted, workspace.configuration().config, workspace.snapshot().files);
  const saved = await workspace.patch(remote.id, prepared.changes, adopted.revision);
  assert.equal(saved.entity.title, 'My rejected title');
  assert.equal(saved.entity.assignee, 'remote-assignee');
});

test('planning permission, project scope, archive, stale diagnostics, config errors and external drafts block inline writes', () => {
  const project = source('PRJ-1');
  const file = source('TASK-1', 'project: PRJ-1\n');
  const context = writeContext([project, file]);
  assert.equal(projectTaskWriteProblem(context, file.id), null);
  for (const denied of [
    { ...context, canWrite: false }, { ...context, locked: true }, { ...context, readError: true },
    writeContext([{ ...project, entity: { ...project.entity, archived: true } }, file]),
    writeContext([project, { ...file, entity: { ...file.entity, archived: true } }]),
    writeContext([project, { ...file, stale: true }]),
    writeContext([project, { ...file, diagnostics: [{ code: 'INVALID', severity: 'error', path: file.path, message: 'Invalid source' }] }]),
    writeContext([project, { ...file, entity: { ...file.entity, project: 'PRJ-2' } }]),
    { ...context, sourceDrafts: { [file.id]: { raw: file.raw, revision: file.revision } } },
    { ...context, sourceDrafts: { [project.id]: { raw: project.raw, revision: project.revision } } },
  ]) assert.notEqual(projectTaskWriteProblem(denied, file.id), null);
  const invalidConfiguration = writeContext([project, file]);
  invalidConfiguration.snapshot!.configurationErrors = [{ code: 'CONFIGURATION_INVALID', severity: 'error', path: '.pm/config.yaml', message: 'Fix configuration' }];
  assert.match(projectTaskWriteProblem(invalidConfiguration, file.id)!, /configuration/);
  const own = { ...context, sourceDrafts: { [file.id]: backup(attempt(file, { title: 'Retained' })) } };
  assert.equal(projectTaskWriteProblem(own, file.id), null);
  assert.notEqual(projectTaskWriteProblem(own, file.id, false), null, 'immediate board/date writes cannot overwrite an existing draft');
});

test('unknown native attempts survive backup/navigation and observation is not confirmation or an automatic retry', () => {
  const file = source('TASK-1', 'project: PRJ-1\n');
  const unknown: ProjectTaskDraft = { ...attempt(file, { title: 'Requested title' }), phase: 'unknown' };
  const recovered = readProjectTaskDraft(JSON.parse(JSON.stringify(backup(unknown))));
  assert.deepEqual(recovered, unknown);
  assert.equal(hasUncertainProjectTaskDraft({ [file.id]: backup(unknown) }), true);
  assert.throws(() => adoptProjectTaskDraft(file, unknown), /Read the authoritative source/);
  const matching = { ...file, revision: 'new-source', entity: { ...file.entity, title: 'Requested title' } };
  const observed = observeProjectTaskDraft(matching, unknown);
  assert.equal(observed.phase, 'observed');
  assert.equal(observed.revision, file.revision, 'a matching read does not adopt a revision or forge a successful receipt');
  assert.match(observed.message, /not a write receipt/);
  assert.equal(hasUncertainProjectTaskDraft({ [file.id]: backup(observed) }), true);
  const editedOtherSource = { raw: 'unrelated local source edit', revision: 'other-revision' };
  const next = preserveUncertainProjectTaskDrafts<{ raw: string; revision: string }>({ [file.id]: backup(observed) }, { 'TASK-2': editedOtherSource });
  assert.deepEqual(next[file.id], backup(observed), 'source discard/rebase cannot erase uncertain metadata');
  assert.equal(next['TASK-2'], editedOtherSource, 'unrelated local editing remains available');
  const adopted = adoptProjectTaskDraft(matching, observed);
  assert.equal(adopted.phase, 'editing');
  assert.equal(adopted.revision, matching.revision);
  assert.equal(hasUncertainProjectTaskDraft({ [file.id]: backup(adopted) }), false);
  assert.deepEqual(adopted.changes, unknown.changes);
});

test('task edit input is strict and rejects unsupported fields or impossible all-day dates', () => {
  for (const input of [{ body: 'replace source' }, { assigneeIds: ['a', 'b'] }, { due: '2026-02-30' }, { 'x-pm-start': '2026-01-01T00:00:00Z' }, { priority: 'normal' }]) {
    assert.equal(projectTaskChangesSchema.safeParse(input).success, false);
  }
  assert.deepEqual(projectTaskChangesSchema.parse({ assignee: null, due: null, 'x-pm-start': null }), { assignee: null, due: null, 'x-pm-start': null });
});

test('estimate editing patches bounded numeric points in the same revision without changing status or source body', async t => {
  const workspace = await fixture(t);
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
    initial: 'queued', states: [{ id: 'queued', label: 'Queue', category: 'unstarted' }, { id: 'delivered', label: 'Delivered', category: 'completed' }], transitions: [],
  } }, custom_fields: [] });
  await workspace.saveConfiguration(configuration, workspace.configuration().revision);
  const project = await workspace.createEntity({ entity: 'project', title: 'Estimate project' });
  const original = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Estimate task', body: 'Preserve the task scope.\n\n- [ ] Human acceptance remains unchanged.', assignee: 'actual-member', 'x-pm-external': 'keep' });
  let file = original;
  for (const points of [2.5, 0, null]) {
    const draft = attempt(file, { 'x-pm-estimate': points });
    const prepared = prepareProjectTaskPatch(file, draft, configuration, workspace.snapshot().files);
    assert.deepEqual(prepared.changes, { 'x-pm-estimate': points });
    const previousRevision = file.revision;
    file = await workspace.patch(file.id, prepared.changes, draft.revision);
    assert.notEqual(file.revision, previousRevision);
    assert.equal(file.entity['x-pm-estimate'], points ?? undefined);
    assert.equal(file.entity.status, 'queued');
    assert.equal(file.entity.assignee, 'actual-member');
    assert.equal(file.entity['x-pm-external'], 'keep');
    assert.equal(file.entity.body, original.entity.body);
    assert.deepEqual(file.entity.checklist.map(({ text, checked }) => ({ text, checked })), original.entity.checklist.map(({ text, checked }) => ({ text, checked })));
  }
  for (const points of [-1, Infinity, NaN, 1_000_001, '3']) assert.equal(projectTaskChangesSchema.safeParse({ 'x-pm-estimate': points }).success, false);
});

test('unknown estimate attempts retain exact zero/null and participate in the existing all-session uncertainty guard', () => {
  const file = source('TASK-1', 'project: PRJ-1\n');
  for (const points of [0, null]) {
    const unknown: ProjectTaskDraft = { ...attempt(file, { 'x-pm-estimate': points }), phase: 'unknown' };
    const restored = readProjectTaskDraft(JSON.parse(JSON.stringify(backup(unknown))));
    assert.deepEqual(restored, unknown);
    assert.equal(hasUncertainProjectTaskDraft({ 'TASK-1': backup(unknown), 'TASK-2': { raw: 'other draft', revision: 'other revision' } }), true);
    assert.throws(() => adoptProjectTaskDraft(file, unknown), /authoritative source/);
    const observed = observeProjectTaskDraft(file, unknown);
    assert.match(observed.message, points === null ? /contains the requested field values/ : /differs from the requested fields/);
    assert.equal(hasUncertainProjectTaskDraft({ 'TASK-1': backup(observed) }), true);
    const adopted = adoptProjectTaskDraft(file, observed);
    assert.deepEqual(adopted.changes, { 'x-pm-estimate': points });
    assert.equal(hasUncertainProjectTaskDraft({ 'TASK-1': backup(adopted) }), false);
  }
});
