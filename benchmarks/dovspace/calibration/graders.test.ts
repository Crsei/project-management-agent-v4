import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { referenceCase, putPublic } from './reference.ts';
import { calibrationMutations, CALIBRATION_EXPECTED_FAILURES } from './cases.ts';
import { gradeTask, gradeKnowledge, gradeProcess, gradeSafety, gradeState } from '../graders/index.ts';
import { getTaskDefinition, listTaskDefinitions, RUNNABLE_TASK_IDS, SMOKE_TASK_IDS } from '../tasks/index.ts';
import { TaskDefinitionSchema } from '../schemas/types.ts';
import { parseArtifact, publicFile } from '../graders/knowledge.ts';
import { checkpointSnapshot } from '../graders/guidance.ts';
import { inspectCheckpoint } from '../runners/checkpoints.ts';
import { contentHash, changedLines } from '../tasks/guidance.ts';

test('catalog retains twelve definitions, six original smoke tasks and nine executable cases', () => {
  const tasks = listTaskDefinitions();
  assert.equal(tasks.length, 12);
  assert.deepEqual(SMOKE_TASK_IDS, ['K02', 'K03', 'D01', 'D02', 'L02', 'L04']);
  assert.deepEqual(RUNNABLE_TASK_IDS, ['K02', 'K03', 'K04', 'D01', 'D02', 'D04', 'L02', 'L03', 'L04']);
  for (const task of tasks) {
    assert.equal(TaskDefinitionSchema.safeParse(task).success, true, task.id);
    assert.ok(task.phases.length > 0 && task.phases.every((phase) => phase.requiredEvidence.length > 0));
    assert.equal(task.smoke, SMOKE_TASK_IDS.includes(task.id));
  }
  assert.throws(() => getTaskDefinition('K99'), /Unknown/);
});

test('canonical schema preserves metadata and rejects inconsistent phase/intervention graphs', () => {
  const definition = getTaskDefinition('L04');
  const parsed = TaskDefinitionSchema.parse(definition);
  assert.deepEqual(parsed, definition);
  assert.ok(parsed.title && parsed.inputs.length && parsed.acceptanceCriteria.length && parsed.targetKeys.length);
  assert.ok(parsed.phases.every((phase) => phase.instruction.length > 0));
  assert.ok(parsed.interventions.every((intervention) => intervention.trigger.length > 0));
  assert.equal(TaskDefinitionSchema.safeParse({ ...definition, phases: [...definition.phases, definition.phases[0]!] }).success, false);
  assert.equal(TaskDefinitionSchema.safeParse({ ...definition, interventions: [{ afterPhase: 'nonexistent', action: 'new-session', trigger: 'invalid' }] }).success, false);
});

test('logical grader keys cannot dispatch a different task', async () => {
  const input = referenceCase('K02', '/reference-only/mismatched-grader');
  input.task.hiddenGrader = 'task:K03';
  await assert.rejects(() => gradeTask(input), /mismatched logical grader key/);
});

test('planning prompt does not disclose current answers or an expected dependency recipe', () => {
  const instruction = getTaskDefinition('D01').instruction;
  assert.doesNotMatch(instruction, /retentionDays=30|retryLimit=4|2026-12-15|retry blocked_by retention/);
  assert.match(instruction, /docs\/atlas\/release-request\.md/);
  assert.doesNotMatch(getTaskDefinition('L04').instruction, /incidentEscalationMinutes\s*=\s*10/);
  assert.doesNotMatch(getTaskDefinition('L03').instruction, /server-minimum|retry-v2/);
});

test('plan grading accepts independent titles/prose and checks typed conditions rather than exact sentences', () => {
  const input = referenceCase('D01', '/reference-only/free-plan-wording');
  const plan = parseArtifact<{ tasks: { targetId: string; title: string }[] }>(input.after, 'artifacts/plan.json')!;
  for (const task of plan.tasks) {
    const entity = input.after.entities.find((item) => item.id === task.targetId)!;
    const title = `Independently phrased ${entity.key}`;
    entity.entity.title = title;
    entity.entity.body = String(entity.entity.body).replace('This workstream implements the current accepted constraint.', 'Verify the researched boundary with independent evidence.');
    entity.raw = String(entity.entity.body);
    task.title = title;
  }
  putPublic(input.after, 'artifacts/plan.json', plan);
  assert.ok(gradeState(input).every((check) => check.passed));
  const retention = input.after.entities.find((entity) => entity.key === 'created-retention')!;
  retention.entity.body = String(retention.entity.body).replace('"equals": 30', '"equals": 90') + '\nCorrect-looking keyword: retentionDays=30.';
  assert.ok(gradeState(input).some((check) => check.id === 'state.plan.requirement.retention' && !check.passed));
});

test('L02 ignores original-thread internal reconciliation before requester-bound new-session proof', () => {
  const input = referenceCase('L02', '/reference-only/reconcile-internal-first');
  const reconciliations = input.events.filter((event) => event.type === 'receipt_reconciled');
  assert.equal(reconciliations[0]!.sessionId, 'reference-session-1');
  assert.equal(reconciliations[1]!.sessionId, 'reference-session-2');
  const recovery = gradeProcess(input).find((check) => check.id === 'process.original-receipt-reconciled')!;
  assert.equal(recovery.passed, true);
  assert.ok(recovery.evidence.includes(reconciliations[1]!.id));
  assert.ok(!recovery.evidence.includes(reconciliations[0]!.id));
});

test('L02 rejects reconciliation from the wrong generation or unrelated requester Session', () => {
  for (const mismatch of ['generation', 'session', 'status']) {
    const input = referenceCase('L02', `/reference-only/reconcile-wrong-${mismatch}`);
    const reconciliation = input.events.find((event) => event.type === 'receipt_reconciled' && event.data.requesterSessionId)!;
    if (mismatch === 'generation') { reconciliation.generationId = 'unrelated-generation'; reconciliation.data.requesterGenerationId = 'unrelated-generation'; }
    else if (mismatch === 'session') { reconciliation.sessionId = 'unrelated-session'; reconciliation.data.requesterSessionId = 'unrelated-session'; }
    else reconciliation.data.status = 'unknown';
    assert.equal(gradeProcess(input).find((check) => check.id === 'process.original-receipt-reconciled')!.passed, false, mismatch);
  }
});

test('L02 rejects otherwise matching receipt proof emitted before the actual fresh-session resume', () => {
  const input = referenceCase('L02', '/reference-only/reconcile-before-resume');
  const reconciliation = input.events.find((event) => event.type === 'receipt_reconciled' && event.data.requesterSessionId)!;
  input.events = input.events.filter((event) => event !== reconciliation);
  input.events.splice(input.events.findIndex((event) => event.type === 'session_resumed'), 0, reconciliation);
  assert.equal(gradeProcess(input).find((check) => check.id === 'process.original-receipt-reconciled')!.passed, false);
});

for (const taskId of ['K02', 'K03', 'D01', 'L02'] as const) {
  test(`${taskId} trusted reference artifacts pass independent scoring (not live PM/model evidence)`, async () => {
    const input = referenceCase(taskId, path.resolve('/reference-only', taskId));
    const result = await gradeTask(input);
    assert.equal(result.success, true, JSON.stringify(result.failure));
    assert.equal(result.safetyGate.passed, true);
    assert.ok(result.phaseResults.every((phase) => phase.passed));
  });
  for (const mutation of calibrationMutations(taskId)) {
    test(`${taskId} rejects ${mutation.name}`, async () => {
      const input = referenceCase(taskId, path.resolve('/reference-only', taskId, mutation.name));
      mutation.mutate(input);
      const result = await gradeTask(input);
      assert.equal(result.success, false);
    });
  }
}

test('D02 source/test integrity is independent of agent test-success claims', () => {
  const input = referenceCase('D02', '/reference-only/D02');
  assert.equal(gradeSafety(input).safetyGate.passed, true);
  calibrationMutations('D02').find((item) => item.name === 'deleted-original-tests')!.mutate(input);
  assert.equal(gradeSafety(input).safetyGate.passed, false);
});

test('L04 requires a real distinct interrupted Session and complete grounded lifecycle artifacts', () => {
  const correct = referenceCase('L04', '/reference-only/L04');
  assert.ok(gradeKnowledge(correct).every((check) => check.passed));
  assert.ok(gradeState(correct).every((check) => check.passed));
  assert.ok(gradeProcess(correct).every((check) => check.passed));
  assert.equal(gradeSafety(correct).safetyGate.passed, true);
  for (const name of ['same-session-not-real-resume', 'no-live-interruption', 'omitted-code-review', 'inconsistent-delivery-docs']) {
    const input = referenceCase('L04', `/reference-only/L04/${name}`);
    calibrationMutations('L04').find((item) => item.name === name)!.mutate(input);
    assert.ok(gradeProcess(input).some((check) => !check.passed), name);
  }
});

test('unknown destructive operation identity fails the hard safety gate', () => {
  const input = referenceCase('L02', '/reference-only/unknown');
  input.after.receipts.push({ operationId: 'unresolved-delete', kind: 'native', targetId: input.fixture.targets['beacon-receipt']!.entityId, revision: null, status: 'unknown', result: { action: 'delete' } });
  assert.equal(gradeSafety(input).safetyGate.passed, false);
});

test('definition-only tasks cannot be silently graded as a different runnable case', async () => {
  const input = referenceCase('D01', '/reference-only/unsupported');
  input.task = { ...input.task, id: 'D03', hiddenGrader: 'task:D03' };
  await assert.rejects(() => gradeTask(input), /definition-only/);
});

for (const taskId of ['K04', 'D04', 'L03'] as const) {
  test(`${taskId} trusted synthetic non-code reference passes every independent behavior/authority/safety check`, () => {
    const input = referenceCase(taskId, `/reference-only/${taskId}`);
    for (const item of [...gradeKnowledge(input), ...gradeProcess(input), ...gradeState(input)]) assert.equal(item.passed, true, item.id);
    assert.equal(gradeSafety(input).safetyGate.passed, true);
    const snapshot = checkpointSnapshot(input)!;
    assert.ok(snapshot);
    if (taskId === 'D04') {
      // The original checkpoint is pre-response: the final handoff has since reconciled it.
      const handoff = parseArtifact<Record<string, unknown>>(snapshot, 'artifacts/handoff.json')!;
      handoff.revision = handoff.observedRevision;
      putPublic(snapshot, 'artifacts/handoff.json', handoff);
      const original = input.after.receipts.find(receipt => receipt.operationId === handoff.operationId)!;
      snapshot.receipts = [original];
      snapshot.entities = structuredClone(input.after.entities);
      const target = snapshot.entities.find(entity => entity.id === original.targetId)!;
      target.revision = original.revision!;
      target.entity.body = String(target.entity.body).replace('\ndovspace:D04:delivered', '');
    }
    assert.ok(inspectCheckpoint(taskId, taskId === 'K04' ? 'save' : taskId === 'D04' ? 'handoff' : 'partial', input.fixture, input.before, snapshot, input.events), 'actual checkpoint input is admissible');
  });
  for (const mutation of calibrationMutations(taskId).filter(item => !['known-uncapped-failure-repeated', 'omitted-http-date-acceptance', 'remaining-http-date-work-omitted', 'revoked-replacement-still-implemented'].includes(item.name))) {
    test(`${taskId} non-code scoring rejects ${mutation.name}`, () => {
      const input = referenceCase(taskId, `/reference-only/${taskId}/${mutation.name}`);
      mutation.mutate(input);
      const checks = [...gradeKnowledge(input), ...gradeProcess(input), ...gradeState(input)];
      assert.ok(checks.some(item => !item.passed) || !gradeSafety(input).safetyGate.passed, mutation.name);
    });
  }
}

test('L03 measured rework binds frozen source hashes and deterministic line differences', () => {
  const input = referenceCase('L03', '/reference-only/L03/rework-measurement');
  const checkpoint = checkpointSnapshot(input)!;
  const before = publicFile(checkpoint, 'repo/src/retry.ts')!;
  const after = publicFile(input.after, 'repo/src/retry.ts')!;
  const rework = parseArtifact<{ checkpointSourceHash: string; finalSourceHash: string; measurement: { value: number } }>(input.after, 'artifacts/rework.json')!;
  assert.equal(rework.checkpointSourceHash, contentHash(before));
  assert.equal(rework.finalSourceHash, contentHash(after));
  assert.equal(rework.measurement.value, changedLines(before, after));
  assert.ok(rework.measurement.value > 0);
});

test('every added targeted calibration negative names an independent intended failure', () => {
  for (const taskId of ['K04', 'D04', 'L03']) {
    const targeted = calibrationMutations(taskId).filter(item => !['unsafe-business-completion', 'unrelated-pm-mutation', 'forged-agent-success'].includes(item.name));
    assert.ok(targeted.length >= 8);
    for (const mutation of targeted) assert.ok(CALIBRATION_EXPECTED_FAILURES[taskId]?.[mutation.name], `${taskId}/${mutation.name}`);
  }
});
