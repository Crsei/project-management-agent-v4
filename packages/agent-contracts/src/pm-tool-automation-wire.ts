import { z } from 'zod';
import { executionSelectionSchema } from './execution.ts';

/** Transport DTOs only. Native PM schemas/services remain the sole execution, source and review authority. */
const uuid = z.uuid(), at = z.iso.datetime(), id = z.string().min(1).max(300), revision = z.string().min(1).max(300);
const projectId = z.string().regex(/^PRJ-\d+$/), taskId = z.string().regex(/^TASK-\d+$/), body = z.string().max(100000);
const transportText = z.string().max(12 * 1024 * 1024);
type AutomationWireJson = string | number | boolean | null | AutomationWireJson[] | { [key: string]: AutomationWireJson };
const jsonValue: z.ZodType<AutomationWireJson> = z.lazy(() => z.union([
  transportText, z.number().finite(), z.boolean(), z.null(), z.array(jsonValue).max(100000),
  z.record(transportText, jsonValue).refine(value => Object.keys(value).length <= 100000, 'JSON object exceeds the wire entry bound'),
]));
/** Preserve native extensible JSON values and legacy forensic selections without untyped result payloads. */
export const automationWireJsonSchema = jsonValue.superRefine((value, context) => {
  const pending: { value: AutomationWireJson; depth: number }[] = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 100000 || entry.depth > 64) { context.addIssue({ code: 'custom', message: 'JSON exceeds the wire structural bound' }); return; }
    if (entry.value && typeof entry.value === 'object') for (const child of Object.values(entry.value)) pending.push({ value: child, depth: entry.depth + 1 });
  }
});
const jsonRecord = z.record(transportText, automationWireJsonSchema).refine(value => Object.keys(value).length <= 100000, 'JSON object exceeds the wire entry bound');
const pmTemplate = z.enum([
  'pm-duplicate-tasks', 'pm-requirement-review', 'pm-stalled-tasks', 'pm-ready-dependencies',
  'pm-execution-status-review', 'pm-task-overlap', 'pm-run-summary', 'pm-run-failure-investigation',
  'pm-session-followups', 'pm-pr-acceptance-coverage', 'pm-parallel-run-overlap', 'pm-repeated-failure-hypothesis',
  'pm-decision-record', 'pm-scope-drift', 'pm-requirement-change-impact', 'pm-session-knowledge',
  'pm-cross-task-failures', 'pm-next-phase-plan', 'pm-project-digest', 'pm-project-stagnation',
  'pm-milestone-readiness', 'pm-since-last-visit', 'pm-goal-drift', 'pm-next-actions',
]);
const nativeTemplate = pmTemplate;
const actionKind = z.enum(['prompt', 'script', 'template']);
const actionCommon = {
  repositories: z.array(z.strictObject({ id: z.string().min(1).max(300), ref: z.string().max(300).nullable() })).max(20),
  plugins: z.array(z.strictObject({ id: z.string().min(1).max(300), version: z.string().max(100).nullable() })).max(30),
  timeoutSeconds: z.number().int().min(1).max(86400), executionSelection: executionSelectionSchema.optional(),
};
const providerOptions = z.record(z.string().min(1).max(200), z.union([z.string().max(4000), z.boolean()])).refine(value => Object.keys(value).length <= 100000, 'Model options exceed the wire entry bound');
const model = { providerInstanceId: z.string().min(1).max(200), model: z.string().min(1).max(200), options: providerOptions };
const trigger = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('once'), at, timezone: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('cron'), expression: z.string().min(1).max(200), timezone: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('event'), source: z.string().min(1).max(100), key: z.string().min(1).max(200), filter: jsonRecord }),
]);
export const automationWireConfigSchema = z.strictObject({
  name: z.string().min(1).max(160), description: z.string().max(4000), projectId,
  tags: z.array(z.string().min(1).max(100)).max(30), templateId: z.string().max(300).nullable(),
  templateInputs: jsonRecord.optional(), templateVersion: z.string().max(200).nullable().optional(), quickAccess: z.boolean().optional(),
  executionAgent: z.strictObject({ id: z.string().min(1).max(128), version: z.number().int().positive() }).optional(),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('prompt'), ...actionCommon, ...model, prompt: z.string().min(1).max(200000) }),
    z.strictObject({ kind: z.literal('script'), ...actionCommon, entrypoint: z.string().min(1).max(500), setup: z.string().max(50000), content: z.string().max(1000000), bundleRef: z.string().max(500).nullable(), files: z.array(z.strictObject({ path: z.string().min(1).max(500), content: z.string().max(1000000) })).max(200) }),
    z.strictObject({ kind: z.literal('template'), ...actionCommon, ...model, providerInstanceId: model.providerInstanceId.nullable(), model: model.model.nullable(), templateId: nativeTemplate, arguments: jsonRecord }),
  ]),
  trigger, dailyLimit: z.number().int().min(1).max(100), cooldownMinutes: z.number().int().nonnegative().max(10080),
});
const historical = { historicalExecutionSelection: automationWireJsonSchema.optional(), executionUnavailableReason: z.literal('agent_workspace_selection_required').optional() };
export const automationWireDefinitionSchema = z.strictObject({ id: uuid, revision: z.number().int().positive(), config: automationWireConfigSchema, status: z.enum(['draft', 'enabled', 'paused']), ...historical, createdAt: at, updatedAt: at, lastRunAt: at.nullable(), nextDueAt: at.nullable() });
export const automationWireExecutionSchema = z.strictObject({
  id: uuid, definitionId: uuid, definitionRevision: z.number().int().positive(), configSnapshot: automationWireConfigSchema, ...historical,
  trigger: z.enum(['manual', 'scheduled', 'event', 'test']), requestId: uuid,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'skipped', 'cancel_requested', 'cancelled', 'outcome_unknown']),
  createdAt: at, startedAt: at.nullable(), finishedAt: at.nullable(), threadId: transportText.nullable(), externalExecutionId: transportText.nullable(), error: transportText.nullable(), summary: transportText,
});
export const automationWireExecutionEventSchema = z.strictObject({ sequence: z.number().int().positive(), at, kind: z.enum(['queued', 'dispatch', 'status', 'log', 'cancel', 'error']), message: transportText, stream: z.enum(['stdout', 'stderr', 'system']).nullable() });
export const automationWireCapabilitiesSchema = z.strictObject({
  actions: z.array(z.strictObject({ id: actionKind, available: z.boolean(), reason: transportText.nullable() })).max(100000),
  providers: z.array(z.strictObject({ id: transportText, name: transportText, models: z.array(transportText).max(100000) })).max(100000),
  repositories: z.array(z.strictObject({ id: transportText, name: transportText })).max(100000),
  plugins: z.array(z.strictObject({ id: transportText, name: transportText, version: transportText.nullable() })).max(100000),
  features: z.array(z.strictObject({ id: transportText, available: z.boolean(), reason: transportText.nullable() })).max(100000).optional(),
  canWrite: z.boolean(), scheduler: z.strictObject({ authority: z.literal('worker'), ready: z.boolean(), reason: transportText.nullable() }),
});
export const automationWireValidationSchema = z.strictObject({ valid: z.boolean(), issues: z.array(z.strictObject({ path: transportText, code: transportText, message: transportText })).max(100000), nextDueAt: at.nullable() });

const repositoryScope = z.strictObject({ provider: z.enum(['github', 'gitlab']), repository: id, ref: id.nullable(), pullRequestNumber: z.number().int().positive().nullable() });
const argumentsDto = z.strictObject({ taskIds: z.array(taskId).min(1).max(200).optional(), statusIds: z.array(id).min(1).max(100).optional(), assigneeIds: z.array(id).min(1).max(100).optional(), labels: z.array(id).min(1).max(100).optional(), lookbackDays: z.number().int().min(1).max(365).optional(), staleDays: z.number().int().min(1).max(365).optional(), milestoneId: id.optional(), repository: repositoryScope.optional(), instructions: z.string().max(12000).optional() });
export const automationWireSourceRefSchema = z.strictObject({
  refId: id, kind: z.enum(['project', 'goal', 'task', 'document', 'relationship', 'comment', 'activity', 'session', 'message', 'execution', 'test', 'tool', 'diff', 'pull-request', 'milestone', 'visit', 'workflow']), id, revision,
  actorId: uuid, workspaceId: uuid, projectId, label: z.string().max(1000), url: z.string().max(2000).nullable(), updatedAt: at.nullable(),
});
const evidence = z.strictObject({ sourceRefId: id, quote: z.string().min(1).max(12000) });
const coverageKind = z.enum(['project', 'workflow', 'tasks', 'relationships', 'documents', 'comments', 'activities', 'sessions', 'executions', 'pull-requests', 'milestones', 'versions', 'visits']);
const coverage = z.strictObject({ source: coverageKind, status: z.enum(['complete', 'partial', 'unavailable']), observedRecords: z.number().int().nonnegative(), totalRecords: z.number().int().nonnegative().nullable(), reason: z.string().max(4000).nullable() });
const category = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
const relativePath = z.string().min(1).max(1000);
const task = z.strictObject({
  id: taskId, sourceRefId: id, revision, projectId, title: z.string().max(2000), description: body,
  status: id, statusCategory: category.nullable(), archived: z.boolean(), acceptanceCriteria: z.array(z.string().max(10000)).max(200), labels: z.array(id).max(100), assigneeIds: z.array(id).max(100),
  dependsOn: z.array(taskId).max(500), relatedTaskIds: z.array(taskId).max(500), goalIds: z.array(id).max(100), allowedPaths: z.array(relativePath).max(500), milestoneId: id.nullable(),
  createdAt: at.nullable(), updatedAt: at.nullable(), lastActivityAt: at.nullable(), progressNote: z.string().max(12000),
});
const project = z.strictObject({ id: projectId, sourceRefId: id, revision, title: z.string().max(2000), description: body, goals: z.array(z.strictObject({ id, sourceRefId: id.optional(), revision: revision.optional(), title: z.string().max(2000), description: body, taskIds: z.array(taskId).max(500), allowedPaths: z.array(relativePath).max(500) })).max(100), createdAt: at.nullable(), updatedAt: at.nullable(), archived: z.boolean() });
const document = z.strictObject({ id, sourceRefId: id, revision, title: z.string().max(2000), body, taskIds: z.array(taskId).max(500), createdAt: at.nullable(), updatedAt: at.nullable(), automationOrigin: z.boolean() });
const relationship = z.strictObject({ id, sourceRefId: id, fromTaskId: taskId, toTaskId: taskId, kind: z.enum(['depends-on', 'related', 'parent']) });
const comment = z.strictObject({ id, sourceRefId: id, taskId: taskId.nullable(), text: body, at, actorId: uuid.nullable() });
const activity = z.strictObject({ id, sourceRefId: id, taskId: taskId.nullable(), title: z.string().max(2000), detail: body, at, automationOrigin: z.boolean() });
const session = z.strictObject({ id, sourceRefId: id, taskIds: z.array(taskId).max(500), status: z.enum(['active', 'idle', 'completed', 'archived']), title: z.string().max(2000), topics: z.array(id).max(100), createdAt: at, updatedAt: at, messages: z.array(z.strictObject({ id, sourceRefId: id, role: z.enum(['user', 'assistant', 'system', 'tool']), text: body, at })).max(1000) });
const execution = z.strictObject({
  id, sourceRefId: id, sessionId: id, taskId: taskId.nullable(), taskRevision: revision.nullable(), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']),
  startedAt: at, finishedAt: at.nullable(), summary: body, reviewed: z.boolean().nullable(),
  tests: z.array(z.strictObject({ name: z.string().min(1).max(2000), status: z.enum(['passed', 'failed', 'skipped', 'unknown']), detail: z.string().max(12000), sourceRefId: id })).max(1000), testsComplete: z.boolean().optional(),
  diffPaths: z.array(relativePath).max(1000), logs: z.array(z.strictObject({ sourceRefId: id, text: z.string().max(12000), at: at.nullable() })).max(300), tools: z.array(z.strictObject({ sourceRefId: id, name: id, status: z.enum(['succeeded', 'failed', 'unknown']), summary: z.string().max(12000) })).max(500),
});
const pullRequest = z.strictObject({ id, sourceRefId: id, taskId, taskRevision: revision, headSha: z.string().min(7).max(100), url: z.string().max(2000), diffPaths: z.array(relativePath).max(1000), coverage: z.array(z.strictObject({ criterion: z.string().max(10000), covered: z.boolean().nullable(), evidence: z.string().max(12000), sourceRefId: id })).max(200), observedAt: at });
const milestone = z.strictObject({ id, sourceRefId: id, title: z.string().max(2000), taskIds: z.array(taskId).max(1000), dueAt: at.nullable(), completed: z.boolean() });
const boundary = z.strictObject({ sourceRefId: id, capturedAt: at, provenance: z.enum(['durable-event', 'persisted-snapshot']), task });
const event = z.strictObject({ eventId: id, source: z.literal('pm'), key: z.enum(['task.created', 'task.updated', 'task.state_changed', 'task.dependencies_changed', 'milestone.changed', 'agent.run.terminal', 'agent.session.idle', 'project.visited']), actorId: uuid, workspaceId: uuid, projectId, at, sourceRef: automationWireSourceRefSchema, originExecutionId: uuid.nullable(), before: boundary.nullable(), after: boundary.nullable(), lastVisitAt: at.nullable(), visitedAt: at.nullable() });
export const automationWireSnapshotSchema = z.strictObject({
  templateId: pmTemplate, executionId: uuid, actorId: uuid, workspaceId: uuid, projectId, observedAt: at, args: argumentsDto, sources: z.array(automationWireSourceRefSchema).max(20000), project,
  workflow: z.strictObject({ sourceRefId: id, statuses: z.array(z.strictObject({ id, name: z.string().max(300), category, nextStatusIds: z.array(id).max(100) })).max(100), readyStatusId: id.nullable(), reviewStatusId: id.nullable() }),
  tasks: z.array(task).max(2000), documents: z.array(document).max(500), relationships: z.array(relationship).max(5000), comments: z.array(comment).max(2000), activities: z.array(activity).max(2000), sessions: z.array(session).max(200), executions: z.array(execution).max(500), pullRequests: z.array(pullRequest).max(100), milestones: z.array(milestone).max(200),
  coverage: z.array(coverage).max(30), timeWindow: z.strictObject({ from: at, to: at, basis: z.enum(['lookback', 'last-visit', 'event', 'explicit']) }).nullable(), lastVisitAt: at.nullable(), before: boundary.nullable(), after: boundary.nullable(), event: event.nullable(),
});
const taskPatch = z.strictObject({ title: z.string().min(1).max(300).optional(), description: z.string().max(24000).optional(), acceptanceCriteria: z.array(z.string().max(4000)).max(100).optional(), progressNote: z.string().max(8000).optional(), labels: z.array(z.string().min(1).max(80)).max(30).optional(), assigneeIds: z.array(id).max(1).optional() });
const taskDraft = z.strictObject({ title: z.string().min(1).max(300), description: z.string().max(24000), acceptanceCriteria: z.array(z.string().max(4000)).max(100), labels: z.array(z.string().min(1).max(80)).max(30), dependsOn: z.array(taskId).max(100), relatedTaskIds: z.array(taskId).max(100), milestoneId: id.nullable() });
const candidateCommon = {
  id, title: z.string().min(1).max(2000), rationale: z.string().max(12000), sourceRefs: z.array(automationWireSourceRefSchema).min(1).max(100), evidence: z.array(evidence).max(100),
  status: z.enum(['pending', 'applied', 'ignored', 'conflict', 'outcome_unknown']), revision: z.number().int().positive(),
  application: z.strictObject({ requestId: uuid, idMap: z.record(id, id).refine(value => Object.keys(value).length <= 100000, 'ID map exceeds the wire entry bound') }).optional(),
  reviewSources: z.array(automationWireSourceRefSchema).min(1).max(100).optional(),
};
export const automationWireCandidateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...candidateCommon, kind: z.literal('task-update'), taskId, expectedRevision: revision, before: taskPatch, after: taskPatch }),
  z.strictObject({ ...candidateCommon, kind: z.literal('task-relation'), taskId, expectedRevision: revision, relation: z.enum(['related', 'depends-on']), before: z.array(taskId).max(500), after: z.array(taskId).min(1).max(500) }),
  z.strictObject({ ...candidateCommon, kind: z.literal('task-comment'), taskId, expectedRevision: revision, body: z.string().min(1).max(8000) }),
  z.strictObject({ ...candidateCommon, kind: z.literal('create-task'), task: taskDraft }),
  z.strictObject({ ...candidateCommon, kind: z.literal('create-document'), document: z.strictObject({ title: z.string().min(1).max(300), body: z.string().max(24000), taskIds: z.array(taskId).max(100) }) }),
  z.strictObject({ ...candidateCommon, kind: z.literal('plan'), plan: z.strictObject({ title: z.string().min(1).max(300), description: z.string().max(24000), tasks: z.array(taskDraft.extend({ localId: id, dependsOnLocalIds: z.array(id).max(50), existingTaskId: taskId.optional() })).min(1).max(50) }) }),
  z.strictObject({ ...candidateCommon, kind: z.literal('task-status'), taskId, expectedRevision: revision, before: id, after: id }),
]);
export const automationWireAnalysisResultSchema = z.strictObject({
  templateId: pmTemplate, executionId: uuid, observedAt: at, summary: z.string().max(20000),
  findings: z.array(z.strictObject({ id, title: z.string().max(2000), detail: z.string().max(20000), severity: z.enum(['info', 'opportunity', 'risk']), confidence: z.enum(['low', 'medium', 'high']), evidence: z.array(evidence).min(1).max(100), candidateIds: z.array(id).max(100) })).max(200),
  coverage: z.array(coverage).max(30), gaps: z.array(z.strictObject({ source: coverageKind, reason: z.string().min(1).max(4000) })).max(100), candidates: z.array(automationWireCandidateSchema).max(200),
});
export const automationWireCandidatePreviewSchema = z.strictObject({ candidate: automationWireCandidateSchema, currentSources: z.array(automationWireSourceRefSchema).max(100), currentTask: task.nullable(), canApply: z.boolean(), conflicts: z.array(z.string().max(4000)).max(100), previewToken: z.string().max(300).nullable(), selectedItemIds: z.array(id).max(50) });
export const automationWireReviewReceiptSchema = z.strictObject({ requestId: uuid, httpStatus: z.number().int().min(100).max(599), result: z.union([z.strictObject({ candidate: automationWireCandidateSchema, idMap: z.record(id, id).refine(value => Object.keys(value).length <= 100000, 'ID map exceeds the wire entry bound'), status: z.enum(['applied', 'ignored', 'edited', 'conflict', 'outcome_unknown']) }), automationWireCandidatePreviewSchema]) });

export const automationWireTransferLimits = { jsonBytes: 3 * 1024 * 1024, archiveBytes: 2 * 1024 * 1024, expandedBytes: 2 * 1024 * 1024, files: 200 } as const;
export const automationWireBundleSchema = z.strictObject({ version: z.literal(1), kind: z.literal('pm-automation-bundle'), spec: automationWireConfigSchema });
export const automationWireSourceDocumentSchema = z.strictObject({ version: z.literal(1), kind: z.literal('automation'), spec: z.strictObject({
  name: z.string().min(1).max(160), prompt: z.string().min(1).max(200000),
  trigger: z.strictObject({ type: z.enum(['cron', 'schedule', 'event']), schedule: z.string().max(200).optional(), schedule_human: z.string().max(500).optional(), timezone: z.string().max(100).optional(), source: z.string().max(100).optional(), on: z.union([z.string().max(200), z.array(z.string().max(200)).min(1).max(30)]).optional(), filter: z.string().max(4000).optional() }),
  enabled: z.boolean(), repository: z.string().max(300).optional(), branch: z.string().max(300).optional(), plugins: z.array(z.string().max(300)).max(30).optional(), model: z.string().min(1).max(200).nullable().optional(), timeout: z.number().int().min(1).max(86400).nullable().optional(), notification: z.string().max(500).optional(), timezone: z.string().max(100).optional(),
}) });
export const automationWireGitConfigSchema = z.strictObject({ projectId, enabled: z.boolean(), repository: z.string().min(1).max(1000), branch: z.string().min(1).max(200), path: z.string().min(1).max(240), authorName: z.string().min(1).max(100), authorEmail: z.string().max(200), intervalSeconds: z.union([z.literal(0), z.number().int().min(60).max(86400)]), encryptionEnabled: z.boolean() });
