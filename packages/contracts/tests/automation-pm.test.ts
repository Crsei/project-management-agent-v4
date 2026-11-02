import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { automationCatalog, automationTemplateMaturity, automationTemplateSource, automationTemplateTriggers } from '../src/automation-catalog.ts';
import { pmAutomationCatalog, pmAutomationDefaultArguments, pmAutomationRecommendedIds } from '../src/automation-pm-catalog.ts';
import { validateNativeTemplateArguments } from '../src/automation-native-template-arguments.ts';
import {
  pmAutomationArgumentsSchema, pmAutomationCandidateSchema, pmAutomationCoverageKindSchema, pmAutomationCoverageSchema,
  pmAutomationExecutionSchema, pmAutomationPlanSchema, pmAutomationResultSchema, pmAutomationReviewReceiptSchema, pmAutomationSnapshotSchema,
  pmAutomationTemplateIds, pmAutomationTemplateVersion, validatePmAutomationResult,
  type PmAutomationCandidate, type PmAutomationResult, type PmAutomationSnapshot, type PmAutomationSourceRef,
} from '../src/automation-pm.ts';
import { studioConfigSchema, studioNativeTemplateRequiresProvider, studioNativeTemplateRequiresWorkspace, studioRequiredProviderToolFeature, type StudioConfig } from '../src/automation-studio.ts';

const actorId = '00000000-0000-4000-a000-000000000001';
const workspaceId = '00000000-0000-4000-a000-000000000002';
const executionId = '00000000-0000-4000-a000-000000000003';
const at = '2026-10-31T12:00:00Z';
const source = (kind: PmAutomationSourceRef['kind'], id: string): PmAutomationSourceRef => ({ refId: `${kind}:${id}:r1`, kind, id, revision: 'r1', actorId, workspaceId, projectId: 'PRJ-001', label: id, url: null, updatedAt: at });
function snapshot(): PmAutomationSnapshot {
  const project = source('project', 'PRJ-001'), workflow = source('workflow', 'configured-workflow'), task = source('task', 'TASK-001');
  return pmAutomationSnapshotSchema.parse({
    templateId: 'pm-stalled-tasks', executionId, actorId, workspaceId, projectId: 'PRJ-001', observedAt: at, args: {}, sources: [project, workflow, task],
    project: { id: 'PRJ-001', sourceRefId: project.refId, revision: 'r1', title: 'Real test project', description: '', goals: [], createdAt: at, updatedAt: at, archived: false },
    workflow: { sourceRefId: workflow.refId, statuses: [{ id: 'waiting', name: 'Waiting', category: 'backlog', nextStatusIds: ['ready', 'finished'] }, { id: 'ready', name: 'Scheduled', category: 'unstarted', nextStatusIds: [] }, { id: 'finished', name: 'Finished', category: 'completed', nextStatusIds: [] }], readyStatusId: 'ready', reviewStatusId: null },
    tasks: [{ id: 'TASK-001', sourceRefId: task.refId, revision: 'r1', projectId: 'PRJ-001', title: 'Preserve source evidence', description: 'Actual task body', status: 'waiting', statusCategory: 'backlog', archived: false, acceptanceCriteria: ['Observed evidence is retained'], labels: [], assigneeIds: [], dependsOn: [], relatedTaskIds: [], goalIds: [], allowedPaths: [], milestoneId: null, createdAt: at, updatedAt: at, lastActivityAt: at, progressNote: '' }],
    documents: [], relationships: [], comments: [], activities: [], sessions: [], executions: [], pullRequests: [], milestones: [],
    coverage: pmAutomationCoverageKindSchema.options.map(kind => ({ source: kind, status: 'complete', observedRecords: ['project', 'workflow', 'tasks'].includes(kind) ? 1 : 0, totalRecords: ['project', 'workflow', 'tasks'].includes(kind) ? 1 : 0, reason: null })),
    timeWindow: null, lastVisitAt: null, before: null, after: null, event: null,
  });
}
function result(input: PmAutomationSnapshot): PmAutomationResult {
  return { templateId: input.templateId, executionId: input.executionId, observedAt: input.observedAt, summary: 'Source-based analysis', findings: [], coverage: input.coverage, gaps: [], candidates: [] };
}
function candidate(input: PmAutomationSnapshot): PmAutomationCandidate {
  return { id: 'follow-up', kind: 'task-comment', title: 'Review actual evidence', rationale: 'Explicit follow-up only', sourceRefs: [input.sources[2]!], evidence: [{ sourceRefId: input.sources[2]!.refId, quote: 'Actual task body' }], status: 'pending', revision: 1, taskId: 'TASK-001', expectedRevision: 'r1', body: 'Please review this evidence.' };
}

describe('all PM-native catalogue and configuration contracts', () => {
  it('preserves all 23 pinned source entries and adds every stable PM ID as an actual native manifest', () => {
    assert.equal(automationCatalog.filter(template => automationTemplateSource(template) === 'openhands').length, 23);
    assert.equal(pmAutomationCatalog.length, pmAutomationTemplateIds.length);
    assert.equal(new Set(automationCatalog.map(template => template.id)).size, automationCatalog.length);
    assert.deepEqual(pmAutomationRecommendedIds, ['pm-requirement-review', 'pm-stalled-tasks', 'pm-project-digest']);
    assert.deepEqual(new Set(pmAutomationCatalog.map(template => template.category)), new Set(['tasks/dependencies', 'execution/collaboration', 'knowledge/changes', 'project/planning']));
    for (const template of pmAutomationCatalog) {
      assert.ok(pmAutomationTemplateIds.includes(template.id as typeof pmAutomationTemplateIds[number]));
      assert.equal(template.setup?.native?.templateId, template.id);
      assert.equal(template.version, pmAutomationTemplateVersion);
      assert.equal(Object.hasOwn(template.setup!, 'prompt'), false);
      assert.equal(Object.hasOwn(template.setup!, 'bundle'), false);
      assert.equal(automationTemplateMaturity(template), 'stable');
      assert.ok(automationTemplateTriggers(template).includes('manual'));
      assert.deepEqual(template.requires.integrations, {});
    }
  });
  it('defaults project digest to the current UTC day without erasing explicit custom windows', () => {
    const defaults = pmAutomationDefaultArguments('pm-project-digest');
    assert.equal(Object.hasOwn(defaults, 'lookbackDays'), false);
    const field = pmAutomationCatalog.find(template => template.id === 'pm-project-digest')!.setup!.form.args.lookbackDays!;
    assert.equal(Object.hasOwn(field, 'default'), false);
    assert.match(field.help, /current UTC day/);
    assert.equal(pmAutomationArgumentsSchema.parse({ ...defaults, lookbackDays: 7 }).lookbackDays, 7);
  });
  it('classifies all 24 Provider and workspace capabilities explicitly and validates native arguments at config boundaries', () => {
    const semantic: Record<string, true> = { 'pm-duplicate-tasks': true, 'pm-requirement-review': true, 'pm-session-followups': true, 'pm-decision-record': true, 'pm-session-knowledge': true, 'pm-next-phase-plan': true, 'pm-goal-drift': true, 'pm-next-actions': true };
    for (const templateId of pmAutomationTemplateIds) {
      const needsProvider = semantic[templateId] === true, args = pmAutomationDefaultArguments(templateId);
      const config: StudioConfig = { name: templateId, description: '', projectId: 'PRJ-001', tags: [], templateId, templateVersion: pmAutomationTemplateVersion, templateInputs: args, trigger: { kind: 'manual' }, dailyLimit: 10, cooldownMinutes: 0, action: { kind: 'template', templateId, arguments: args, repositories: [], plugins: [], timeoutSeconds: 60, providerInstanceId: needsProvider ? 'selected-provider' : null, model: needsProvider ? 'selected-model' : null, options: {} } };
      assert.deepEqual(studioConfigSchema.parse(config), config);
      assert.equal(studioNativeTemplateRequiresProvider(templateId), needsProvider);
      assert.equal(studioNativeTemplateRequiresWorkspace(templateId), false);
      assert.equal(studioRequiredProviderToolFeature(config), needsProvider ? 'provider:selected-provider:pmAnalysis' : null);
      assert.deepEqual(validateNativeTemplateArguments(templateId, args), []);
      assert.equal(studioConfigSchema.safeParse({ ...config, action: { ...config.action, arguments: { ...args, command: 'forbidden escape' } } }).success, false);
      assert.equal(studioConfigSchema.safeParse({ ...config, templateInputs: { ...args, taskIds: [] } }).success, false);
      assert.equal(studioConfigSchema.safeParse({ ...config, templateVersion: null }).success, false);
      assert.equal(studioConfigSchema.safeParse({ ...config, action: { ...config.action, repositories: [{ id: 'workspace-root', ref: null }] } }).success, false);
      if (needsProvider) assert.equal(studioConfigSchema.safeParse({ ...config, action: { ...config.action, providerInstanceId: null, model: null } }).success, false);
      const connection = { id: 'integration:chosen-connection', version: '4' };
      assert.equal(studioConfigSchema.safeParse({ ...config, action: { ...config.action, plugins: [connection] } }).success, templateId === 'pm-pr-acceptance-coverage');
      if (templateId === 'pm-pr-acceptance-coverage') {
        assert.equal(studioConfigSchema.safeParse({ ...config, action: { ...config.action, plugins: [{ ...connection, version: null }] } }).success, false);
        assert.equal(studioConfigSchema.safeParse({ ...config, action: { ...config.action, plugins: [connection, { ...connection, id: 'integration:second' }] } }).success, false);
      }
    }
  });
  it('rejects prompt disguises, unknown selectors, empty explicit scope and unsafe numeric windows', () => {
    for (const args of [{ taskIds: [] }, { statusIds: [] }, { taskIds: ['TASK-001', 'TASK-001'] }, { projectId: 'PRJ-002' }, { lookbackDays: 0 }, { staleDays: 366 }, { repository: { provider: 'github', repository: 'org/repo', ref: null, pullRequestNumber: -1 } }]) assert.equal(pmAutomationArgumentsSchema.safeParse(args).success, false);
    assert.equal(studioConfigSchema.safeParse({ name: 'Disguised', description: '', projectId: 'PRJ-001', tags: [], templateId: 'pm-next-actions', action: { kind: 'prompt', prompt: 'Pretend to implement native analysis', providerInstanceId: 'selected', model: 'selected', options: {}, repositories: [], plugins: [], timeoutSeconds: 60 }, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }).success, false);
  });
});

describe('frozen PM evidence and typed review boundaries', () => {
  it('requires explicit complete/partial/unavailable source coverage and actor/project-bound source identity', () => {
    const input = snapshot();
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, coverage: input.coverage.slice(1) }).success, false);
    assert.equal(pmAutomationCoverageSchema.safeParse({ source: 'sessions', status: 'unavailable', observedRecords: 0, totalRecords: null, reason: null }).success, false);
    assert.equal(pmAutomationCoverageSchema.safeParse({ source: 'sessions', status: 'complete', observedRecords: 0, totalRecords: null, reason: null }).success, false);
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, sources: input.sources.map((ref, index) => index === 2 ? { ...ref, actorId: workspaceId } : ref) }).success, false);
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, tasks: [{ ...input.tasks[0], sourceRefId: 'fabricated-source' }] }).success, false);
  });
  it('binds standalone goals to their own revisions and embedded project goals only to the project source', () => {
    const input = snapshot(), goalSource = source('goal', 'GOAL-001');
    const goal = { id: goalSource.id, sourceRefId: goalSource.refId, revision: goalSource.revision, title: 'Explicit delivery goal', description: 'Real goal entity', taskIds: ['TASK-001'], allowedPaths: [] };
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, sources: [...input.sources, goalSource], project: { ...input.project, goals: [goal] } }).success, true);
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, sources: [...input.sources, goalSource], project: { ...input.project, goals: [{ ...goal, revision: 'forged' }] } }).success, false);
    const embedded = { ...goal, id: `${input.project.id}:goal`, sourceRefId: input.project.sourceRefId, revision: input.project.revision };
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, project: { ...input.project, goals: [embedded] } }).success, true);
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, project: { ...input.project, goals: [{ ...embedded, id: 'invented-goal' }] } }).success, false);
  });
  it('never upgrades absent or incomplete native test snapshots to complete evidence', () => {
    const execution = { id: 'actual-generation', sourceRefId: 'execution:actual-generation', sessionId: 'actual-thread', taskId: 'TASK-001', taskRevision: 'r1', status: 'succeeded', startedAt: at, finishedAt: at, summary: 'Runner finished', reviewed: null, tests: [{ name: 'observed-test', status: 'passed', detail: 'Actual runner row', sourceRefId: 'test:observed-test' }], diffPaths: [], logs: [], tools: [] };
    assert.equal(pmAutomationExecutionSchema.parse(execution).testsComplete, undefined);
    assert.equal(pmAutomationExecutionSchema.parse({ ...execution, testsComplete: false }).testsComplete, false);
    assert.equal(pmAutomationExecutionSchema.parse({ ...execution, testsComplete: true }).testsComplete, true);
    assert.equal(pmAutomationExecutionSchema.safeParse({ ...execution, testsComplete: 'true' }).success, false);
  });
  it('rejects oversized frozen snapshots instead of silently truncating complete claims', () => {
    const input = snapshot(), body = 'x'.repeat(100000);
    const refs = Array.from({ length: 50 }, (_, index) => source('document', `DOC-${index + 1}`));
    const documents = refs.map(ref => ({ id: ref.id, sourceRefId: ref.refId, revision: ref.revision, title: 'Actual large source', body, taskIds: [], createdAt: at, updatedAt: at, automationOrigin: false }));
    assert.equal(pmAutomationSnapshotSchema.safeParse({ ...input, sources: [...input.sources, ...refs], documents }).success, false);
  });
  it('grounds direct/serialized evidence and rejects forged refs, quotes, revisions, state and execution identity', () => {
    const input = snapshot(), proposal = candidate(input), output = { ...result(input), candidates: [proposal] };
    assert.deepEqual(validatePmAutomationResult(input, output), output);
    assert.doesNotThrow(() => validatePmAutomationResult(input, { ...output, candidates: [{ ...proposal, evidence: [{ sourceRefId: proposal.sourceRefs[0]!.refId, quote: JSON.stringify(input.tasks[0], null, 2) }] }] }));
    for (const change of [
      { ...output, executionId: actorId },
      { ...output, candidates: [{ ...proposal, expectedRevision: 'r2' }] },
      { ...output, candidates: [{ ...proposal, status: 'applied' }] },
      { ...output, candidates: [{ ...proposal, application: { requestId: actorId, idMap: {} } }] },
      { ...output, candidates: [{ ...proposal, reviewSources: proposal.sourceRefs }] },
      { ...output, candidates: [{ ...proposal, sourceRefs: [{ ...proposal.sourceRefs[0], revision: 'forged' }] }] },
      { ...output, candidates: [{ ...proposal, evidence: [{ sourceRefId: proposal.sourceRefs[0]!.refId, quote: 'All tests passed without observing any test' }] }] },
    ]) assert.throws(() => validatePmAutomationResult(input, change));
    assert.equal(pmAutomationResultSchema.safeParse({ ...output, rawCommand: { kind: 'execute' } }).success, false);
    assert.equal(pmAutomationCandidateSchema.safeParse({ ...proposal, kind: 'execute-script', script: 'arbitrary' }).success, false);
  });
  it('uses configured workflow categories and never turns successful analysis into terminal task status', () => {
    const input = snapshot(), common = candidate(input);
    const proposal = { id: common.id, title: common.title, rationale: common.rationale, sourceRefs: common.sourceRefs, evidence: common.evidence, status: common.status, revision: common.revision, kind: 'task-status', taskId: 'TASK-001', expectedRevision: 'r1', before: 'waiting', after: 'ready' };
    assert.doesNotThrow(() => validatePmAutomationResult(input, { ...result(input), candidates: [proposal] }));
    assert.throws(() => validatePmAutomationResult(input, { ...result(input), candidates: [{ ...proposal, after: 'finished' }] }));
    assert.throws(() => validatePmAutomationResult(input, { ...result(input), candidates: [{ ...proposal, after: 'Todo' }] }));
  });
  it('retains local plan identity, distinguishes existing tasks, and rejects invalid local dependency graphs', () => {
    const draft = { title: 'Next step', description: 'Human-reviewed plan', acceptanceCriteria: [], labels: [], dependsOn: ['TASK-001'], relatedTaskIds: [], milestoneId: null };
    const plan = { title: 'Next phase', description: '', tasks: [{ ...draft, localId: 'existing', existingTaskId: 'TASK-001', dependsOnLocalIds: [] }, { ...draft, localId: 'new', dependsOnLocalIds: ['existing'] }] };
    assert.deepEqual(pmAutomationPlanSchema.parse(plan), plan);
    assert.equal(pmAutomationPlanSchema.safeParse({ ...plan, tasks: [plan.tasks[0], { ...plan.tasks[1], localId: 'existing' }] }).success, false);
    assert.equal(pmAutomationPlanSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], dependsOnLocalIds: ['new'] }, plan.tasks[1]] }).success, false);
    assert.equal(pmAutomationPlanSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], dependsOnLocalIds: ['not-declared'] }] }).success, false);
  });
  it('recovers original preview tokens in typed receipts and refuses arbitrary result escapes', () => {
    const proposal = candidate(snapshot());
    const preview = { candidate: proposal, currentSources: proposal.sourceRefs, currentTask: null, canApply: true, conflicts: [], previewToken: 'original-token', selectedItemIds: [] };
    assert.deepEqual(pmAutomationReviewReceiptSchema.parse({ requestId: actorId, httpStatus: 200, result: preview }).result, preview);
    assert.equal(pmAutomationReviewReceiptSchema.safeParse({ requestId: actorId, httpStatus: 200, result: { succeeded: true, unvalidated: { command: 'run' } } }).success, false);
  });
});
