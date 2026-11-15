import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { planningRecordsFamily } from '../planning-records.ts';
import type { CliRuntime, PmRequestOptions, PmScope } from '../runtime.ts';
import { emptyRoadmap, roadmapStoreSchema, type RoadmapRelease } from '../../contracts/src/product-roadmap.ts';
import { roadmapDependencyClosure, publishRoadmap, saveRoadmapDraft } from '../../application/src/product-roadmap.ts';
import { PlanningRecordsToolInputSchemas } from '../../application/src/agent-tool-planning-records.ts';
import { planningRecordsRoadmapSchema } from '../../agent-contracts/src/pm-tool-planning-records.ts';

function runtime(request: (scope: PmScope, endpoint: string, options?: PmRequestOptions) => Promise<unknown>): CliRuntime {
  return {
    authentication: async () => { throw new Error('This family must authenticate only through the scoped request'); },
    connection: async () => { throw new Error('Unexpected workspace selection'); },
    json: async <T>(scope: PmScope, endpoint: string, options?: PmRequestOptions) => await request(scope, endpoint, options) as T,
    response: async () => { throw new Error('No byte/proxy interface belongs to planning records'); }, print: () => {},
  };
}
test('planning resources claim only explicit prefixes and reject unknown actions before authentication', async () => {
  let requests = 0;
  const client = runtime(async () => { requests++; throw new Error('Unexpected transport'); });
  assert.equal(await planningRecordsFamily.dispatch(['agent', 'status'], client), false);
  await assert.rejects(planningRecordsFamily.dispatch(['evidence', 'execute-arbitrary-command'], client), /finite evidence operations/);
  await assert.rejects(planningRecordsFamily.dispatch(['roadmap', 'read', '--project', 'PRJ-001', '--path', '/commands'], client), /unsupported option/);
  await assert.rejects(planningRecordsFamily.dispatch(['review', 'record', '--file', 'not-read', '--request-id', randomUUID()], client), /human-operator/);
  assert.equal(requests, 0);
  assert.equal(Object.hasOwn(PlanningRecordsToolInputSchemas, 'pm_record_review'), false);
});

test('native intent conversion uses only the original finite command and never automatically retries a lost response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planning-cli-'));
  try {
    const filename = join(root, 'conversion.json'), requestId = randomUUID(), intentId = randomUUID(), decisionId = randomUUID();
    const payload = { title: 'Accepted task', description: 'Preserve intent identity', acceptanceCriteria: [], intentId, acceptedRevision: 3, decisionId };
    await writeFile(filename, JSON.stringify({ projectId: 'PRJ-001', targetId: null, expectedVersions: [], payload }));
    let requests = 0;
    const client = runtime(async (scope, endpoint, options) => {
      requests++; assert.equal(scope, 'workspace'); assert.equal(endpoint, '/commands'); assert.equal(options?.method, 'POST');
      const body = options?.body as { commandId: string; commandType: string; payload: typeof payload };
      assert.equal(body.commandId, requestId); assert.equal(body.commandType, 'CreateWorkItemFromIntent');
      assert.equal(body.payload.intentId, intentId); assert.equal(body.payload.decisionId, decisionId); assert.equal(body.payload.acceptedRevision, 3);
      throw new Error('Original response lost');
    });
    await assert.rejects(planningRecordsFamily.dispatch(['intent', 'task', '--file', filename, '--request-id', requestId], client), /Original response lost/);
    assert.equal(requests, 1);
    await writeFile(filename, JSON.stringify({ projectId: 'PRJ-001', targetId: null, expectedVersions: [], commandType: 'CompleteWorkItem', payload }));
    await assert.rejects(planningRecordsFamily.dispatch(['intent', 'task', '--file', filename, '--request-id', requestId], client));
    assert.equal(requests, 1, 'file cannot smuggle another command or dispatch before strict parsing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('published node keys remain immutable and selected roadmap nodes include exact dependency closure', () => {
  const plan = emptyRoadmap(), first = randomUUID(), second = randomUUID(), third = randomUUID();
  for (const key of Object.keys(plan.brief) as (keyof typeof plan.brief)[]) plan.brief[key] = `Explicit ${key}`;
  plan.nodes = [first, second, third].map((id, index) => ({ id, title: `Node ${index}`, outcome: 'Deliverable', acceptance: 'Verified', nonGoals: '', stage: 'Build', dependsOn: index ? [index === 1 ? first : second] : [], x: 0, y: 0 }));
  const releaseId = randomUUID();
  const store = publishRoadmap({ schema: 'pm/product-roadmap/v1', draft: plan, releases: [] }, releaseId, randomUUID(), new Date().toISOString());
  const release = store.releases[0]!;
  assert.deepEqual(roadmapDependencyClosure(release, [third]), [first, second, third]);
  assert.deepEqual(roadmapDependencyClosure(release, [third, first]), [first, second, third]);
  const draft = saveRoadmapDraft(store, { ...plan, brief: { ...plan.brief, idea: 'A later draft' } });
  assert.equal(draft.releases[0]!.plan.brief.idea, 'Explicit idea');
  assert.equal(draft.releases[0]!.id, releaseId);
  assert.throws(() => roadmapDependencyClosure(release, [third, third]));
  assert.throws(() => roadmapDependencyClosure(release, [randomUUID()]));
  const cyclic: RoadmapRelease = { ...release, plan: { ...release.plan, nodes: release.plan.nodes.map(node => node.id === first ? { ...node, dependsOn: [third] } : node) } };
  assert.throws(() => roadmapDependencyClosure(cyclic, [third]));
});

test('roadmap wire results allow unfinished drafts but reject unknown and unbounded payloads', () => {
  const plan = emptyRoadmap(), nodeIds = [randomUUID(), randomUUID()], releaseId = randomUUID();
  for (const key of Object.keys(plan.brief) as (keyof typeof plan.brief)[]) plan.brief[key] = `Native ${key}`;
  plan.nodes = nodeIds.map((id, index) => ({
    id, title: `Native published node ${index}`, outcome: 'Actual deliverable', acceptance: 'Actual acceptance',
    nonGoals: '', stage: 'Implementation', dependsOn: index ? [nodeIds[0]!] : [], x: index ? 6000 : 0, y: index ? 6000 : 0,
  }));
  const published = publishRoadmap({ schema: 'pm/product-roadmap/v1', draft: plan, releases: [] }, releaseId, randomUUID(), new Date().toISOString());
  const store = roadmapStoreSchema.parse(saveRoadmapDraft(published, emptyRoadmap()));
  const nativeRead = {
    projectId: 'PRJ-001', title: 'Native project', revision: 'native-project-revision', archived: true, store,
    tasks: { [releaseId]: [{ nodeId: nodeIds[1]!, taskId: 'TASK-002', title: 'Actual mapped task', status: 'custom-review-state', revision: 'native-task-revision', archived: true, drifted: true }] },
  };
  assert.equal(planningRecordsRoadmapSchema.parse(nativeRead).store.draft.brief.idea, '', 'unfinished native draft remains readable');
  assert.throws(() => planningRecordsRoadmapSchema.parse({ ...nativeRead, store: { ...store, ignoredBusinessPayload: true } }));
  assert.throws(() => planningRecordsRoadmapSchema.parse({ ...nativeRead, store: { ...store, draft: { ...store.draft, brief: { ...store.draft.brief, idea: 'x'.repeat(6001) } } } }));
  assert.throws(() => planningRecordsRoadmapSchema.parse({ ...nativeRead, store: { ...store, draft: { ...plan, nodes: Array.from({ length: 25 }, () => plan.nodes[0]!) } } }));
  assert.throws(() => planningRecordsRoadmapSchema.parse({ ...nativeRead, store: { ...store, releases: Array.from({ length: 21 }, () => store.releases[0]!) } }));
  assert.throws(() => planningRecordsRoadmapSchema.parse({ ...nativeRead, store: { ...store, draft: { ...plan, nodes: [{ ...plan.nodes[0]!, dependsOn: Array.from({ length: 25 }, () => randomUUID()) }] } } }));
});
