import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfiguration, type FileRecord, type WorkspaceSnapshot } from '../packages/pm-schema/index.ts';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { projectArchived, projectDeletionBlockers, projectDescription, projectSettingsUpdate, projectSettingsValues, projectSourceVersion, stableProjectPath } from '../apps/web/src/features/pm/service/project-menu-model.ts';

function source(id: string, kind = 'project', extra = '', body = ''): FileRecord {
  const raw = `---\nschema: pm/v1\nid: ${id}\nentity: ${kind}\n${extra}---\n# ${id} title\n\n${body}\n`;
  return { id, path: `${id}.md`, raw, revision: '1234567890abcdef', entity: parseMarkdown(raw, defaultConfiguration) };
}
function workspace(files: FileRecord[]): WorkspaceSnapshot {
  return { files, configuration: defaultConfiguration, configurationRevision: 'config', configurationErrors: [], unsupportedFiles: [], views: [], errors: [] };
}

test('project links use stable workspace/project IDs and encode routing characters', () => {
  assert.equal(stableProjectPath('workspace one', 'PRJ-1/#'), '/pm/workspace%20one/projects/PRJ-1%2F%23');
  assert.equal(new URL(stableProjectPath('w', 'PRJ-001'), 'https://pm.example').href, 'https://pm.example/pm/w/projects/PRJ-001');
});

test('archived status honors both real native archive projections', () => {
  assert.equal(projectArchived({ data: { archived: true } }), true);
  assert.equal(projectArchived({ data: { archivedAt: '2026-10-27T00:00:00Z' } }), true);
  assert.equal(projectArchived({ data: { status: 'completed', archived: false } }), false);
});

test('settings body retains checklists, links and embedded source instead of reducing to a goal', () => {
  const file = source('PRJ-001', 'project', 'goal: Separate goal\nx-pm-icon: rocket\nx-pm-color: "#23918A"\n', 'Description\n\n- [ ] Real outcome\n\n[[DOC-001]]\n\n```pm-view\nlayout: table\n```');
  const body = projectDescription(file);
  assert.equal(body, 'Description\n\n- [ ] Real outcome\n\n[[DOC-001]]\n\n```pm-view\nlayout: table\n```');
  const values = projectSettingsValues(file);
  assert.equal(values.description, body);
  assert.equal(values.name, 'PRJ-001 title');
  assert.equal(values.icon, 'rocket');
  assert.equal(values.color, '#23918A');
  assert.equal(file.entity.goal, 'Separate goal');
  assert.ok(file.raw.includes('goal: Separate goal'));
});

test('settings updates preserve independent goals, completion criteria and unchanged body metadata', () => {
  const file = source('PRJ-001', 'project', 'goal: Keep the real goal\nx-pm-completion-criteria:\n  - Keep the criterion\nx-pm-icon: rocket\nx-pm-color: "#23918A"\ndue: 2026-11-30\n', '- [ ] Keep the outcome');
  const original = projectSettingsValues(file);
  const renamed = projectSettingsUpdate(file, { ...original, name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.goal, 'Keep the real goal');
  assert.deepEqual(renamed.completionCriteria, ['Keep the criterion']);
  assert.equal(Object.hasOwn(renamed, 'description'), false);
  assert.equal(Object.hasOwn(renamed, 'icon'), false);
  assert.equal(Object.hasOwn(renamed, 'color'), false);
  assert.equal(Object.hasOwn(renamed, 'dueDate'), false);
  const edited = projectSettingsUpdate(file, { ...original, description: 'New body', dueDate: '', icon: '', color: '' });
  assert.equal(edited.description, 'New body');
  assert.equal(edited.dueDate, null);
  assert.equal(edited.icon, null);
  assert.equal(edited.color, null);
  assert.equal(file.entity.body.includes('Keep the outcome'), true);
});

test('source PM version uses the existing authoritative revision projection', () => {
  assert.equal(projectSourceVersion('1234567890abcdef'), 0x12345678);
  assert.equal(projectSourceVersion('ffffffff0000'), 0x7fffffff);
  assert.equal(projectSourceVersion('000000000000'), 1);
});

test('permanent deletion requires archive and blocks real incoming tasks, links and custom references', () => {
  const project = source('PRJ-001');
  assert.match(projectDeletionBlockers(workspace([project]), project.id).join(' '), /Archive/);
  const archived = source('PRJ-001', 'project', 'archived: true\n');
  assert.deepEqual(projectDeletionBlockers(workspace([archived]), archived.id), []);
  const task = source('TASK-001', 'work_item', 'project: PRJ-001\n');
  assert.match(projectDeletionBlockers(workspace([archived, task]), archived.id).join(' '), /TASK-001/);
  const document = source('DOC-001', 'document', '', '[[PRJ-001 title]]');
  assert.match(projectDeletionBlockers(workspace([archived, document]), archived.id).join(' '), /DOC-001/);
  const custom = source('DOC-002', 'document', 'x-owner-project: PRJ-001\n');
  const customWorkspace = workspace([archived, custom]);
  customWorkspace.configuration = { ...defaultConfiguration, custom_fields: [{ name: 'x-owner-project', label: 'Owner project', type: 'reference', entities: ['document'], target: 'project' }] };
  assert.match(projectDeletionBlockers(customWorkspace, archived.id).join(' '), /DOC-002/);
});

test('deletion preflight refuses stale or unsupported sources and explicit saved-view ordering', () => {
  const project = source('PRJ-001', 'project', 'archived: true\n');
  const snapshot = workspace([project, { ...source('DOC-001', 'document'), stale: true }]);
  assert.match(projectDeletionBlockers(snapshot, project.id).join(' '), /stale/);
  snapshot.files = [project];
  snapshot.unsupportedFiles = [{ path: 'future.md', raw: 'future', revision: 'x', readOnly: true, diagnostics: [] }];
  assert.match(projectDeletionBlockers(snapshot, project.id).join(' '), /unreadable/);
  snapshot.unsupportedFiles = [];
  snapshot.views = [{ id: 'saved', name: 'Original order', layout: 'table', order: [project.id] }];
  assert.match(projectDeletionBlockers(snapshot, project.id).join(' '), /Original order/);
});
