import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, parseConfiguration, type FileRecord, type WorkspaceSnapshot } from '../packages/pm-schema/index.ts';
import { parseTeamPointsInput, teamCapacityExpected, teamTaskCreateProjectProblem } from '../apps/web/src/features/pm/service/team-task-actions-model.ts';

function snapshot(): WorkspaceSnapshot {
  const raw = '---\nschema: pm/v1\nid: PRJ-1\nentity: project\n---\n# Real project\n';
  const project: FileRecord = { id: 'PRJ-1', path: 'projects/PRJ-1.md', raw, revision: 'authoritative-revision', entity: parseMarkdown(raw) };
  return { files: [project], errors: [], unsupportedFiles: [], views: [], configuration: defaultConfiguration, configurationRevision: 'configuration', configurationErrors: [] };
}

test('point input keeps unknown distinct from explicit zero and accepts only bounded finite numbers', () => {
  for (const text of ['', ' ', '\t']) assert.equal(parseTeamPointsInput(text), null);
  for (const text of ['0', '0.0', '-0']) assert.equal(Object.is(parseTeamPointsInput(text), 0), true);
  assert.equal(parseTeamPointsInput(' 2.5 '), 2.5);
  assert.equal(parseTeamPointsInput('.25'), 0.25);
  assert.equal(parseTeamPointsInput('1e3'), 1000);
  assert.equal(parseTeamPointsInput('1000000'), 1_000_000);
  for (const text of ['-1', '1000000.1', 'Infinity', 'NaN', '1e309', '0x10', '1,000', '1 0', 'one']) assert.throws(() => parseTeamPointsInput(text));
});

test('capacity CAS distinguishes no record from an existing cleared record and targets record identity', () => {
  assert.deepEqual(teamCapacityExpected(null), {});
  assert.deepEqual(teamCapacityExpected({ id: 'capacity-record', version: 7, capacityPoints: null }), { targetId: 'capacity-record', expectedVersions: { 'capacity-record': 7 } });
  assert.deepEqual(teamCapacityExpected({ id: 'capacity-record', version: 8, capacityPoints: 0 }), { targetId: 'capacity-record', expectedVersions: { 'capacity-record': 8 } });
});

test('task creation availability rejects missing, archived, terminal, stale, invalid and drafted project sources', () => {
  const valid = snapshot();
  assert.equal(teamTaskCreateProjectProblem(valid, 'PRJ-1', {}), null);
  assert.match(teamTaskCreateProjectProblem(undefined, 'PRJ-1', {})!, /authoritative workspace/);
  assert.notEqual(teamTaskCreateProjectProblem(valid, 'PRJ-2', {}), null);
  assert.match(teamTaskCreateProjectProblem(valid, 'PRJ-1', { 'PRJ-1': { raw: 'my draft', revision: 'old' } })!, /source draft/);
  for (const changed of [
    { ...valid.files[0]!, entity: { ...valid.files[0]!.entity, archived: true } },
    { ...valid.files[0]!, entity: { ...valid.files[0]!.entity, status: 'completed' } },
    { ...valid.files[0]!, entity: { ...valid.files[0]!.entity, status: 'canceled' } },
    { ...valid.files[0]!, stale: true },
    { ...valid.files[0]!, diagnostics: [{ code: 'INVALID', severity: 'error' as const, message: 'Invalid source', path: valid.files[0]!.path }] },
  ]) assert.notEqual(teamTaskCreateProjectProblem({ ...valid, files: [changed] }, 'PRJ-1', {}), null);
  assert.match(teamTaskCreateProjectProblem({ ...valid, unsupportedFiles: [{ id: 'PRJ-1', path: 'projects/future.md', raw: 'future', revision: 'future', readOnly: true, diagnostics: [] }] }, 'PRJ-1', {})!, /Unsupported/);
  assert.match(teamTaskCreateProjectProblem({ ...valid, configurationErrors: [{ code: 'INVALID_CONFIG', severity: 'error', message: 'Repair config', path: '.pm/config.yaml' }] }, 'PRJ-1', {})!, /configuration/);
});

test('creation honors configured status categories and never selects a terminal task initial state', () => {
  const current = snapshot();
  const configuration = parseConfiguration({ schema: 'pm/config/v1', workflows: {
    project: { initial: 'open', states: [{ id: 'open', label: 'Open', category: 'started' }, { id: 'shipped', label: 'Shipped', category: 'completed' }], transitions: [] },
    work_item: { initial: 'delivered', states: [{ id: 'delivered', label: 'Delivered', category: 'completed' }], transitions: [] },
  }, custom_fields: [] });
  const configured = { ...current, configuration, files: current.files.map(file => ({ ...file, entity: { ...file.entity, status: 'open' } })) };
  assert.match(teamTaskCreateProjectProblem(configured, 'PRJ-1', {})!, /nonterminal initial state/);
  const nonterminal = parseConfiguration({ schema: 'pm/config/v1', workflows: { project: configuration.workflows.project }, custom_fields: [] });
  const terminalProject = { ...configured, configuration: nonterminal, files: configured.files.map(file => ({ ...file, entity: { ...file.entity, status: 'shipped' } })) };
  assert.match(teamTaskCreateProjectProblem(terminalProject, 'PRJ-1', {})!, /terminal project/);
});
