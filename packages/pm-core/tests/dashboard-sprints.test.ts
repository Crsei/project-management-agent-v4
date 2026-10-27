import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, WorkspaceError } from '../index.ts';
import { patchMarkdown } from '../../pm-markdown/index.ts';
import type { SprintHistoryCycle } from '../sprint-history.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-dashboard-sprints-'));
  const current = { root, workspace: new Workspace(root) };
  t.after(async () => { await current.workspace.close(); await rm(root, { recursive: true, force: true }); });
  await current.workspace.init();
  const project = await current.workspace.createEntity({ entity: 'project', title: 'Sprint project' });
  const sprint = await current.workspace.createEntity({ entity: 'cycle', title: 'Real cycle', project: project.id, start: '2026-10-01', due: '2026-10-14' }, 'sprint-create-once');
  const task = await current.workspace.create({ title: 'Native member', project: project.id, cycle: sprint.id });
  return { current, project, sprint, task };
}

function lastCycle(workspace: Workspace, id: string): SprintHistoryCycle {
  const cycle = workspace.sprintHistory().observations.at(-1)?.cycles.find(row => row.id === id);
  assert.ok(cycle);
  return cycle;
}

function externalObservation(workspace: Workspace, predicate: () => boolean): Promise<void> {
  const pending = Promise.withResolvers<void>();
  const unsubscribe = workspace.onChange(event => {
    if (event.reason === 'external' && predicate()) { unsubscribe(); pending.resolve(); }
  });
  return pending.promise;
}

test('sprint history records API/core-command and external raw observations without replay duplicates', { timeout: 30_000 }, async t => {
  const { current, sprint, task } = await fixture(t);
  assert.equal(lastCycle(current.workspace, sprint.id).tasks[0]?.id, task.id);
  assert.equal(current.workspace.sprintHistory().observations.at(-1)?.source, 'core_command');
  const beforeReplay = current.workspace.sprintHistory().observations.length;
  await current.workspace.createEntity({ entity: 'cycle', title: 'Real cycle', project: sprint.entity.project, start: '2026-10-01', due: '2026-10-14' }, 'sprint-create-once');
  await current.workspace.rescan('external');
  assert.equal(current.workspace.sprintHistory().observations.length, beforeReplay);
  const observed = externalObservation(current.workspace, () => lastCycle(current.workspace, sprint.id).tasks[0]?.category === 'completed');
  await writeFile(path.join(current.root, task.path), patchMarkdown(task.raw, { status: 'done' }));
  await observed;
  const history = current.workspace.sprintHistory();
  assert.equal(history.status, 'ok');
  assert.equal(history.observations.at(-1)?.source, 'external');
  assert.equal(history.observations.at(-1)?.complete, true);
  assert.equal(lastCycle(current.workspace, sprint.id).tasks[0]?.category, 'completed');
});

test('restart and SQLite cache deletion retain history; offline intermediate states and daily points are not fabricated', async t => {
  const { current, sprint, task } = await fixture(t);
  const previous = current.workspace.sprintHistory().observations;
  await current.workspace.close();
  await rm(path.join(current.root, '.pm/cache'), { recursive: true });
  await writeFile(path.join(current.root, task.path), patchMarkdown(task.raw, { status: 'in_progress' }));
  await writeFile(path.join(current.root, task.path), patchMarkdown(task.raw, { status: 'done' }));
  const restartingAt = Date.now();
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  const history = current.workspace.sprintHistory();
  assert.equal(history.status, 'ok');
  assert.deepEqual(history.observations.slice(0, previous.length), previous);
  assert.equal(history.observations.length, previous.length + 1);
  const observation = history.observations.at(-1)!;
  assert.equal(observation.source, 'startup');
  assert.equal(observation.gap, 'restart');
  assert.equal(observation.previousObservedAt, previous.at(-1)?.observedAt);
  assert.ok(Date.parse(observation.observedAt) >= restartingAt);
  assert.equal(observation.cycles.find(cycle => cycle.id === sprint.id)?.tasks[0]?.status, 'done');
  assert.equal(history.observations.some(row => row.cycles.some(cycle => cycle.tasks.some(member => member.status === 'in_progress'))), false);
});

test('invalid native scans remain explicit gaps and never become a false valid zero-task observation', async t => {
  const { current, sprint, task } = await fixture(t);
  await writeFile(path.join(current.root, task.path), '---\nschema: pm/v1\nid: TASK-001\nstatus: [\n---\n# Broken\n');
  await current.workspace.rescan('external');
  const invalid = current.workspace.sprintHistory().observations.at(-1)!;
  assert.equal(invalid.complete, false);
  assert.deepEqual(invalid.cycles, []);
  const beforeReplay = current.workspace.sprintHistory().observations.length;
  await current.workspace.rescan('external');
  assert.equal(current.workspace.sprintHistory().observations.length, beforeReplay);
  await writeFile(path.join(current.root, task.path), task.raw);
  await current.workspace.rescan('external');
  assert.equal(current.workspace.sprintHistory().observations.at(-1)?.gap, 'invalid_scan');
  assert.equal(lastCycle(current.workspace, sprint.id).tasks.length, 1);
});

test('corrupt durable history is visible after restart and is not silently reset or appended over', async t => {
  const { current, task } = await fixture(t);
  await current.workspace.close();
  const directory = path.join(current.root, '.pm/state/sprint-history');
  const names = (await readdir(directory)).sort();
  const damagedPath = path.join(directory, names[1]!);
  await writeFile(damagedPath, '{"torn":');
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.sprintHistory().status, 'error');
  assert.ok(current.workspace.snapshot().errors.some(issue => issue.code === 'SPRINT_HISTORY_UNAVAILABLE'));
  await current.workspace.patch(task.id, { title: 'Core is still usable, history remains unavailable' }, current.workspace.get(task.id).revision);
  assert.equal(current.workspace.sprintHistory().status, 'error');
  assert.equal(await readFile(damagedPath, 'utf8'), '{"torn":');
  assert.deepEqual((await readdir(directory)).sort(), names);
});

test('a removed committed history tail is corruption rather than a new empty history', async t => {
  const { current } = await fixture(t);
  await current.workspace.close();
  const directory = path.join(current.root, '.pm/state/sprint-history');
  const names = (await readdir(directory)).sort();
  await rm(path.join(directory, names.at(-1)!));
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  assert.equal(current.workspace.sprintHistory().status, 'error');
  assert.ok(current.workspace.snapshot().errors.some(issue => issue.code === 'SPRINT_HISTORY_UNAVAILABLE'));
  assert.equal((await readdir(directory)).length, names.length - 1);
});

test('restart completes one durable observation whose CAS checkpoint was interrupted', async t => {
  const { current, task } = await fixture(t);
  const checkpointPath = path.join(current.root, '.pm/state/sprint-history.json');
  const previousCheckpoint = await readFile(checkpointPath, 'utf8');
  await current.workspace.patch(task.id, { status: 'done' }, task.revision);
  const observations = current.workspace.sprintHistory().observations;
  await current.workspace.close();
  // Reproduce the real publication ordering: observation fsynced, checkpoint not yet replaced.
  await writeFile(checkpointPath, previousCheckpoint);
  current.workspace = new Workspace(current.root);
  await current.workspace.init();
  const recovered = current.workspace.sprintHistory();
  assert.equal(recovered.status, 'ok');
  assert.deepEqual(recovered.observations.slice(0, observations.length), observations);
  assert.equal(recovered.observations.length, observations.length + 1);
  assert.equal(recovered.observations.at(-1)?.gap, 'restart');
});

test('history write failure is visible while successful native writes retain their real result', async t => {
  const { current, task } = await fixture(t);
  const directory = path.join(current.root, '.pm/state/sprint-history');
  await rename(directory, `${directory}-saved`);
  await writeFile(directory, 'A real filesystem obstruction, not a simulated persistence success');
  const saved = await current.workspace.patch(task.id, { title: 'Native source was saved' }, task.revision);
  assert.equal(saved.entity.title, 'Native source was saved');
  assert.equal(current.workspace.sprintHistory().status, 'error');
  assert.ok(current.workspace.snapshot().errors.some(issue => issue.code === 'SPRINT_HISTORY_UNAVAILABLE'));
});

test('single-task assignment honors native SHA revision CAS and same-project cycle relations', async t => {
  const { current, sprint, task } = await fixture(t);
  const otherProject = await current.workspace.createEntity({ entity: 'project', title: 'Other project' });
  const otherSprint = await current.workspace.createEntity({ entity: 'cycle', title: 'Other sprint', project: otherProject.id });
  await assert.rejects(current.workspace.patch(task.id, { cycle: otherSprint.id }, task.revision), error => error instanceof WorkspaceError && error.diagnostics.some(issue => issue.code === 'REFERENCE_PROJECT_MISMATCH'));
  const assigned = await current.workspace.patch(task.id, { cycle: null }, task.revision);
  await assert.rejects(current.workspace.patch(task.id, { cycle: sprint.id }, task.revision), error => error instanceof WorkspaceError && error.status === 409);
  assert.equal(current.workspace.get(task.id).entity.cycle, undefined);
  const restored = await current.workspace.patch(task.id, { cycle: sprint.id }, assigned.revision);
  assert.equal(restored.entity.cycle, sprint.id);
  assert.equal(lastCycle(current.workspace, sprint.id).tasks[0]?.id, task.id);
});
