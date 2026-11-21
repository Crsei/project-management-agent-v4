import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkConfig } from '../benchmark.config.ts';
import { referenceCase } from '../calibration/reference.ts';
import { getTaskDefinition, type TaskId } from '../tasks/index.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { runTask } from '../runners/index.ts';
import { enrollCanonicalDatasetVersion } from './dataset.ts';
import { withdrawFeedbackSource } from './feedback.ts';
import { assertRegisteredDatasetFixture, resolveRegisteredDatasetAdmission } from './dataset-admission.ts';
import { RunExperimentSelectionSchema, RunSuiteAdmissionPlanSchema, validateRunSuiteAdmissionCoverage } from './run-admission.ts';
import { createMarkdown, parseMarkdown } from '../../../packages/pm-markdown/index.ts';
import type { FixtureSnapshot } from '../schemas/types.ts';

async function fixture(t: TestContext) {
  const root = path.join(benchmarkConfig.outputsRoot, `registered-admission-test-${randomUUID()}`);
  await prepareReportDirectory(root, true);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const registryRoot = path.join(root, 'registry');
  const tasks = ['K02', 'K03', 'D01', 'D02', 'L02', 'L04'] as const;
  const dataset = await enrollCanonicalDatasetVersion(registryRoot, { datasetId: 'native-six-canonical', version: 'v1', splitPolicyVersion: 'exposed-regression-v1', enrollmentId: 'canonical-enrollment', source: { sourceId: 'canonical-source', sourceVersion: 'task-registry-v1', provenanceId: 'own-synthetic-fixtures', retentionUntil: new Date(Date.now() + 86_400_000).toISOString() }, maintainerId: 'fixture-maintainer', labelerId: 'acceptance-labeler', reviewerId: 'independent-reviewer', licenseId: 'AGPL-3.0-only', licenseAuthorized: true, sanitized: true, independentExpectedCriterion: true, members: tasks.map(taskId => ({ memberId: `member-${taskId}`, memberVersion: 1, taskId })) });
  return { root, registryRoot, tasks, dataset };
}

function nativeSeedSnapshot(taskId: TaskId): FixtureSnapshot {
  const actual = referenceCase(taskId, '/unmaterialized-canonical-input').before;
  actual.entities.find(entity => entity.key === 'beacon-dependency')!.entity.blocked_by = [actual.entities.find(entity => entity.key === 'atlas-plan')!.id];
  const nativeIds = new Map(actual.entities.map((entity, index) => [entity.id, `${entity.kind === 'project' ? 'PRJ' : 'TASK'}-${String(index + 1).padStart(3, '0')}`]));
  for (const entity of actual.entities) {
    entity.id = nativeIds.get(entity.id)!;
    if (entity.projectId) entity.projectId = nativeIds.get(entity.projectId)!;
    if (Array.isArray(entity.entity.blocked_by)) entity.entity.blocked_by = entity.entity.blocked_by.map(id => nativeIds.get(String(id)) ?? id);
    const raw = createMarkdown({
      id: entity.id, entity: entity.kind, title: String(entity.entity.title), body: String(entity.entity.body),
      ...(entity.kind === 'work_item' ? { project: entity.projectId, status: entity.entity.status, priority: entity.entity.priority, due: entity.entity.due, blocked_by: entity.entity.blocked_by ?? [] } : {}),
    });
    entity.raw = raw;
    entity.entity = parseMarkdown(raw) as unknown as Record<string, unknown>;
  }
  return actual;
}

test('six canonical tasks enroll executable contracts without fabricated failed reproductions', async t => {
  const value = await fixture(t);
  assert.equal(value.dataset.schemaVersion, 2);
  for (const taskId of value.tasks) {
    const definition = getTaskDefinition(taskId);
    const resolved = await resolveRegisteredDatasetAdmission({ registryRoot: value.registryRoot, datasetId: value.dataset.datasetId, version: value.dataset.version, memberId: `member-${taskId}`, memberVersion: 1 }, definition);
    assert.equal(resolved.dataset.sha256, value.dataset.digest);
    assert.equal(resolved.member.evaluationMode, 'canonical-task');
    const member = value.dataset.members.find(item => item.taskId === taskId)!;
    assert.ok(member.expectedCriteria.every(item => item.expected === 'pass'));
    assert.equal('archiveRoot' in member, false); assert.equal('reproductionId' in member, false);
    // f0a9-K02-dovspace's archived before snapshot contains native PM Markdown
    // bodies (including their H1), not the body-only calibration representation.
    const actual = nativeSeedSnapshot(taskId);
    assert.doesNotThrow(() => assertRegisteredDatasetFixture(resolved, actual));
    actual.publicFiles['repo/src/retry.ts'] = Buffer.from('different registered task input').toString('base64');
    assert.throws(() => assertRegisteredDatasetFixture(resolved, actual), /no model dispatch/);
  }
});

test('canonical fresh admission preserves native body content, state, relations and exact public inputs', async t => {
  const value = await fixture(t);
  const resolved = await resolveRegisteredDatasetAdmission({ registryRoot: value.registryRoot, datasetId: value.dataset.datasetId, version: value.dataset.version, memberId: 'member-K02', memberVersion: 1 }, getTaskDefinition('K02'));
  const original = nativeSeedSnapshot('K02');
  assert.doesNotThrow(() => assertRegisteredDatasetFixture(resolved, original));
  const entity = (snapshot: FixtureSnapshot, key = 'atlas-plan') => snapshot.entities.find(item => item.key === key)!;
  const changes: [string, (snapshot: FixtureSnapshot) => void][] = [
    ['fixture version', snapshot => { snapshot.fixtureVersion = 'foreign-fixture-version'; }],
    ['title', snapshot => { entity(snapshot).entity.title = 'Changed release plan'; }],
    ['body', snapshot => { entity(snapshot).entity.body = `${String(entity(snapshot).entity.body)}\nChanged acceptance requirements.`; }],
    ['authoritative H1', snapshot => { entity(snapshot).entity.body = String(entity(snapshot).entity.body).replace('# Reconcile Atlas release plan', '# Changed release plan'); }],
    ['checklist content', snapshot => { entity(snapshot).entity.body = `${String(entity(snapshot).entity.body)}\n- [ ] Additional acceptance requirement`; }],
    ['project body', snapshot => { entity(snapshot, 'atlas').entity.body = `${String(entity(snapshot, 'atlas').entity.body)}\nChanged project requirements.`; }],
    ['status', snapshot => { entity(snapshot).entity.status = 'in_progress'; }],
    ['priority', snapshot => { entity(snapshot).entity.priority = 'high'; }],
    ['due date', snapshot => { entity(snapshot).entity.due = '2026-12-02'; }],
    ['project relation', snapshot => { entity(snapshot).projectId = entity(snapshot, 'beacon').id; entity(snapshot).entity.project = entity(snapshot, 'beacon').id; }],
    ['removed dependency', snapshot => { entity(snapshot, 'beacon-dependency').entity.blocked_by = []; }],
    ['foreign dependency', snapshot => { entity(snapshot, 'beacon-dependency').entity.blocked_by = ['foreign-task']; }],
    ['missing authority', snapshot => { snapshot.entities.pop(); }],
    ['foreign authority', snapshot => { snapshot.entities.push({ ...structuredClone(entity(snapshot)), key: 'foreign', id: 'foreign-task' }); }],
    ['changed public content', snapshot => { snapshot.publicFiles['repo/src/retry.ts'] = Buffer.from('changed code').toString('base64'); }],
    ['missing public file', snapshot => { delete snapshot.publicFiles['docs/atlas/overview.md']; }],
    ['foreign public file', snapshot => { snapshot.publicFiles['docs/foreign.md'] = Buffer.from('foreign requirements').toString('base64'); }],
  ];
  for (const [label, change] of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.throws(() => assertRegisteredDatasetFixture(resolved, changed), /no model dispatch/, label);
  }
  const bodyOnlyCalibration = referenceCase('K02', '/unmaterialized-canonical-input').before;
  entity(bodyOnlyCalibration, 'beacon-dependency').entity.blocked_by = [entity(bodyOnlyCalibration).id];
  assert.throws(() => assertRegisteredDatasetFixture(resolved, bodyOnlyCalibration), /no model dispatch/);
});

test('task/member identity changes and source withdrawal deny fresh admission', async t => {
  const value = await fixture(t), selection = { registryRoot: value.registryRoot, datasetId: value.dataset.datasetId, version: value.dataset.version, memberId: 'member-K02', memberVersion: 1 };
  await assert.rejects(() => resolveRegisteredDatasetAdmission({ ...selection, memberVersion: 2 }, getTaskDefinition('K02')), /canonical task enrollment/);
  await assert.rejects(() => resolveRegisteredDatasetAdmission(selection, getTaskDefinition('D02')), /execution contract/);
  await assert.rejects(() => resolveRegisteredDatasetAdmission(selection, { ...getTaskDefinition('K02'), taskVersion: 'changed-task-version' }), /execution contract/);
  await withdrawFeedbackSource(value.registryRoot, { sourceId: 'canonical-source', reason: 'withdrawn', actorId: 'source-owner' });
  await assert.rejects(() => resolveRegisteredDatasetAdmission(selection, getTaskDefinition('K02')), /withdrawn|revoked|inactive|invalid|fenced/i);
});

test('suite plans reject aliases, reused cells and incomplete mapping before dispatch', () => {
  const common = { datasetSelection: { registryRoot: '/tmp/registered-registry', datasetId: 'dataset', version: 'v1', memberId: 'member-K02', memberVersion: 1 }, captureKey: { keyId: 'host', privateKeyPath: '/tmp/private-key/capture-private-key.pem' } };
  const plan = RunSuiteAdmissionPlanSchema.parse([{ ...common, taskId: 'K02', arm: 'raw', repetition: 1, experiment: { ledgerRoot: '/tmp/registered-ledger', cellId: 'baseline' } }, { ...common, taskId: 'K02', arm: 'dovspace', repetition: 1, experiment: { ledgerRoot: '/tmp/registered-ledger', cellId: 'candidate' } }]);
  assert.doesNotThrow(() => validateRunSuiteAdmissionCoverage(plan, ['K02'], ['raw', 'dovspace'], 1));
  assert.throws(() => validateRunSuiteAdmissionCoverage(plan.slice(0, 1), ['K02'], ['raw', 'dovspace'], 1), /exactly cover/);
  assert.throws(() => validateRunSuiteAdmissionCoverage([{ ...plan[0]! }, { ...plan[1]!, experiment: plan[0]!.experiment }], ['K02'], ['raw', 'dovspace'], 1), /unique registered ledger cell/);
  assert.equal(RunExperimentSelectionSchema.safeParse({ ledgerRoot: '/tmp/registered-ledger/./alias/..', cellId: 'candidate' }).success, false);
  assert.equal(RunSuiteAdmissionPlanSchema.safeParse([{ ...plan[0]!, repetition: 0 }]).success, false);
});

test('invalid calibration is rejected before an ordinary run creates admission or provider artifacts', async t => {
  const root = path.join(benchmarkConfig.outputsRoot, `bad-calibration-test-${randomUUID()}`); await prepareReportDirectory(root, true);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const calibrationPath = path.join(root, 'invalid-calibration.json');
  await writeFile(calibrationPath, JSON.stringify({ kind: 'grader-calibration', success: true, evaluatorSha256: '0'.repeat(64), calibrationDefinitionSha256: '0'.repeat(64), infrastructureErrors: [], codeExecution: { realSandboxCalls: 1 }, cases: [] }), { mode: 0o600 });
  const original = await readFile(calibrationPath);
  await assert.rejects(() => runTask({ taskId: 'K02', arm: 'raw', outputRoot: root, calibrationPath, config: { codeImage: `sha256:${'a'.repeat(64)}`, model: 'must-not-dispatch' } }), /Calibration/);
  assert.deepEqual(await readdir(root), ['invalid-calibration.json']);
  assert.deepEqual(await readFile(calibrationPath), original);
});
