import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { emptyRoadmap, roadmapActionSchema, roadmapPlanSchema, roadmapProblems, type RoadmapStore } from '../packages/contracts/src/product-roadmap.ts';
import { assertRoadmapMetadata, publishRoadmap, taskInput } from '../packages/application/src/product-roadmap.ts';
import { feedbackScenario, layoutRoadmap, suggestRoadmap } from '../apps/web/src/features/pm/product-roadmap/model.ts';
import type { Entity } from '../packages/pm-schema/index.ts';

test('guided roadmap keeps assumptions explicit, creates outcome candidates and a dependency DAG', () => {
  const plan = feedbackScenario(randomUUID);
  assert.equal(plan.nodes.length, 5); assert.deepEqual(roadmapProblems(plan), []);
  assert.ok(plan.brief.assumptions.includes('待验证'));
  assert.equal(plan.nodes[1]!.dependsOn[0], plan.nodes[0]!.id);
  assert.equal(new Set(plan.nodes.map(n => n.id)).size, 5);
  assert.deepEqual(roadmapProblems(layoutRoadmap(plan)), []);
  assert.equal(suggestRoadmap(emptyRoadmap().brief, randomUUID).nodes.length, 0);
});
test('graph validation rejects cycles, self edges, duplicates and missing prerequisites', () => {
  for (const mode of ['cycle', 'self', 'missing', 'duplicate']) {
    const plan = feedbackScenario(randomUUID), first = plan.nodes[0]!, last = plan.nodes.at(-1)!;
    first.dependsOn = mode === 'cycle' ? [last.id] : mode === 'self' ? [first.id] : mode === 'missing' ? [randomUUID()] : [];
    if (mode === 'duplicate') plan.nodes.push({ ...first });
    assert.ok(roadmapProblems(plan).length, mode);
  }
  assert.ok(roadmapProblems(emptyRoadmap()).length);
});
test('published requirements remain immutable and task inputs include shared PRD and real dependency IDs', () => {
  const draft = feedbackScenario(randomUUID), store: RoadmapStore = { schema: 'pm/product-roadmap/v1', draft, releases: [] };
  const saved = publishRoadmap(store, randomUUID(), 'reviewer', new Date().toISOString()), release = saved.releases[0]!;
  draft.brief.idea = 'local edit'; assert.notEqual(release.plan.brief.idea, draft.brief.idea);
  const before: Entity = { schema: 'pm/v1', entity: 'project', id: 'PRJ-001', title: 'Product', body: '', blocked_by: [], related_to: [], labels: [], links: [], checklist: [], views: [], 'x-pm-product-roadmap': saved };
  const changed = structuredClone(before); (changed['x-pm-product-roadmap'] as RoadmapStore).releases[0]!.plan.brief.idea = 'overwrite history';
  assert.throws(() => assertRoadmapMetadata(changed, before));
  const first = taskInput('PRJ-001', release, release.plan.nodes[0]!.id, []);
  assert.ok(String(first.body).includes('共享实现约定')); assert.deepEqual(first.blocked_by, []);
  assert.throws(() => taskInput('PRJ-001', release, release.plan.nodes[1]!.id, []));
  const rows = [{ nodeId: release.plan.nodes[0]!.id, taskId: 'TASK-007', title: 'first', status: 'todo', revision: 'rev', archived: false, drifted: false }];
  assert.deepEqual(taskInput('PRJ-001', release, release.plan.nodes[1]!.id, rows).blocked_by, ['TASK-007']);
  assert.throws(() => taskInput('PRJ-001', release, release.plan.nodes[1]!.id, rows.map(t => ({ ...t, drifted: true }))));
});
test('strict requests never accept actor, cwd, execution, merge or completion fields', () => {
  const valid = { action: 'publish', commandId: randomUUID(), revision: 'a', releaseId: randomUUID(), confirm: true };
  assert.ok(roadmapActionSchema.safeParse(valid).success);
  for (const extra of [{ actor: 'admin' }, { cwd: '/root' }, { execute: true }, { merge: true }, { status: 'done' }]) assert.equal(roadmapActionSchema.safeParse({ ...valid, ...extra }).success, false);
  assert.equal(roadmapActionSchema.safeParse({ ...valid, confirm: false }).success, false);
});
test('large guided inputs and 24-node layouts stay persistable without overlapping cards', () => {
  const brief = { ...emptyRoadmap().brief, audience: 'A'.repeat(6000), journey: 'B'.repeat(6000) };
  assert.ok(roadmapPlanSchema.safeParse(suggestRoadmap(brief, randomUUID)).success);
  assert.equal(brief.journey.length, 6000, 'original PRD remains intact');
  const seed = feedbackScenario(randomUUID).nodes[0]!, ids = Array.from({ length: 24 }, () => randomUUID());
  for (const linear of [true, false]) {
    const plan = layoutRoadmap({ brief, nodes: ids.map((id, i) => ({ ...seed, id, dependsOn: linear && i ? [ids[i - 1]!] : [] })) });
    assert.ok(roadmapPlanSchema.safeParse(plan).success);
    assert.equal(new Set(plan.nodes.map(n => `${n.x}:${n.y}`)).size, 24);
  }
});
