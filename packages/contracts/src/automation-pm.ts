import { z } from 'zod';

/** Stable PM-native handlers. This list is independent of the read-only OpenHands catalogue. */
export const pmAutomationTemplateIds = [
  'pm-duplicate-tasks', 'pm-requirement-review', 'pm-stalled-tasks', 'pm-ready-dependencies',
  'pm-execution-status-review', 'pm-task-overlap', 'pm-run-summary', 'pm-run-failure-investigation',
  'pm-session-followups', 'pm-pr-acceptance-coverage', 'pm-parallel-run-overlap', 'pm-repeated-failure-hypothesis',
  'pm-decision-record', 'pm-scope-drift', 'pm-requirement-change-impact', 'pm-session-knowledge',
  'pm-cross-task-failures', 'pm-next-phase-plan', 'pm-project-digest', 'pm-project-stagnation',
  'pm-milestone-readiness', 'pm-since-last-visit', 'pm-goal-drift', 'pm-next-actions',
] as const;
export const pmAutomationTemplateIdSchema = z.enum(pmAutomationTemplateIds);
export type PmAutomationTemplateId = z.infer<typeof pmAutomationTemplateIdSchema>;
export function isPmAutomationTemplateId(id: string): id is PmAutomationTemplateId { return (pmAutomationTemplateIds as readonly string[]).includes(id); }
export const pmAutomationTemplateVersion = '1.0.0';
const id = z.string().trim().min(1).max(300);
const uuid = z.uuid().toLowerCase();
const projectId = z.string().regex(/^PRJ-\d+$/);
const taskId = z.string().regex(/^TASK-\d+$/);
const timestamp = z.iso.datetime();
const revision = z.string().min(1).max(300);
const text = z.string().max(100000);
const relativePath = z.string().min(1).max(1000).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => part === '..') && !value.includes('\0'), 'Expected a project-relative path');
const uniqueIds = (schema: z.ZodString, max: number) => z.array(schema).min(1).max(max).refine(values => new Set(values).size === values.length, 'Identifiers must be unique');
export const pmAutomationRepositoryScopeSchema = z.strictObject({
  provider: z.enum(['github', 'gitlab']), repository: id, ref: id.nullable(), pullRequestNumber: z.number().int().positive().nullable(),
}).superRefine((scope, context) => {
  const parts = scope.repository.split('/');
  if (parts.length < 2 || scope.provider === 'github' && parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) context.addIssue({ code: 'custom', path: ['repository'], message: 'Expected an explicit owner/repository or GitLab group/project identifier, not a URL or path' });
});
/** An omitted selector is project scope; an explicitly empty selector never widens to project scope. */
export const pmAutomationArgumentsSchema = z.strictObject({
  taskIds: uniqueIds(taskId, 200).optional(), statusIds: uniqueIds(id, 100).optional(),
  assigneeIds: uniqueIds(id, 100).optional(), labels: uniqueIds(id, 100).optional(),
  lookbackDays: z.number().int().min(1).max(365).optional(), staleDays: z.number().int().min(1).max(365).optional(),
  milestoneId: id.optional(), repository: pmAutomationRepositoryScopeSchema.optional(), instructions: z.string().max(12000).optional(),
});
export type PmAutomationArguments = z.infer<typeof pmAutomationArgumentsSchema>;

export const pmAutomationSourceKindSchema = z.enum(['project', 'goal', 'task', 'document', 'relationship', 'comment', 'activity', 'session', 'message', 'execution', 'test', 'tool', 'diff', 'pull-request', 'milestone', 'visit', 'workflow']);
export const pmAutomationSourceRefSchema = z.strictObject({
  refId: id, kind: pmAutomationSourceKindSchema, id, revision,
  actorId: uuid, workspaceId: uuid, projectId,
  label: z.string().max(1000), url: z.string().max(2000).nullable(), updatedAt: timestamp.nullable(),
});
export type PmAutomationSourceRef = z.infer<typeof pmAutomationSourceRefSchema>;
export const pmAutomationEvidenceSchema = z.strictObject({ sourceRefId: id, quote: z.string().min(1).max(12000) });
export type PmAutomationEvidence = z.infer<typeof pmAutomationEvidenceSchema>;
export const pmAutomationCoverageKindSchema = z.enum(['project', 'workflow', 'tasks', 'relationships', 'documents', 'comments', 'activities', 'sessions', 'executions', 'pull-requests', 'milestones', 'versions', 'visits']);
export const pmAutomationCoverageSchema = z.strictObject({
  source: pmAutomationCoverageKindSchema, status: z.enum(['complete', 'partial', 'unavailable']),
  observedRecords: z.number().int().nonnegative(), totalRecords: z.number().int().nonnegative().nullable(),
  reason: z.string().max(4000).nullable(),
}).superRefine((coverage, context) => {
  if (coverage.totalRecords !== null && coverage.totalRecords < coverage.observedRecords) context.addIssue({ code: 'custom', path: ['totalRecords'], message: 'Total records cannot be less than observed records' });
  if (coverage.status !== 'complete' && !coverage.reason?.trim()) context.addIssue({ code: 'custom', path: ['reason'], message: 'Partial or unavailable sources require an explicit limitation' });
  if (coverage.status === 'complete' && coverage.totalRecords !== coverage.observedRecords) context.addIssue({ code: 'custom', path: ['totalRecords'], message: 'Complete coverage requires an observed total, including zero' });
  if (coverage.status === 'unavailable' && coverage.observedRecords !== 0) context.addIssue({ code: 'custom', path: ['observedRecords'], message: 'Unavailable sources cannot claim observed records' });
});
export type PmAutomationCoverage = z.infer<typeof pmAutomationCoverageSchema>;
export const pmAutomationStatusCategorySchema = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
export const pmAutomationWorkflowSchema = z.strictObject({
  sourceRefId: id,
  statuses: z.array(z.strictObject({ id, name: z.string().max(300), category: pmAutomationStatusCategorySchema, nextStatusIds: z.array(id).max(100) })).max(100),
  readyStatusId: id.nullable(), reviewStatusId: id.nullable(),
});
export const pmAutomationTaskSchema = z.strictObject({
  id: taskId, sourceRefId: id, revision, projectId, title: z.string().max(2000), description: text,
  status: id, statusCategory: pmAutomationStatusCategorySchema.nullable(), archived: z.boolean(),
  acceptanceCriteria: z.array(z.string().max(10000)).max(200), labels: z.array(id).max(100), assigneeIds: z.array(id).max(100),
  dependsOn: z.array(taskId).max(500), relatedTaskIds: z.array(taskId).max(500), goalIds: z.array(id).max(100),
  allowedPaths: z.array(relativePath).max(500), milestoneId: id.nullable(),
  createdAt: timestamp.nullable(), updatedAt: timestamp.nullable(), lastActivityAt: timestamp.nullable(),
  progressNote: z.string().max(12000),
});
export type PmAutomationTask = z.infer<typeof pmAutomationTaskSchema>;
export const pmAutomationProjectSchema = z.strictObject({
  id: projectId, sourceRefId: id, revision, title: z.string().max(2000), description: text,
  goals: z.array(z.strictObject({ id, sourceRefId: id.optional(), revision: revision.optional(), title: z.string().max(2000), description: text, taskIds: z.array(taskId).max(500), allowedPaths: z.array(relativePath).max(500) })).max(100),
  createdAt: timestamp.nullable(), updatedAt: timestamp.nullable(), archived: z.boolean(),
});
export const pmAutomationDocumentSchema = z.strictObject({ id, sourceRefId: id, revision, title: z.string().max(2000), body: text, taskIds: z.array(taskId).max(500), createdAt: timestamp.nullable(), updatedAt: timestamp.nullable(), automationOrigin: z.boolean() });
export const pmAutomationRelationshipSchema = z.strictObject({ id, sourceRefId: id, fromTaskId: taskId, toTaskId: taskId, kind: z.enum(['depends-on', 'related', 'parent']) });
export const pmAutomationCommentSchema = z.strictObject({ id, sourceRefId: id, taskId: taskId.nullable(), text, at: timestamp, actorId: uuid.nullable() });
export const pmAutomationActivitySchema = z.strictObject({ id, sourceRefId: id, taskId: taskId.nullable(), title: z.string().max(2000), detail: text, at: timestamp, automationOrigin: z.boolean() });
export const pmAutomationSessionSchema = z.strictObject({
  id, sourceRefId: id, taskIds: z.array(taskId).max(500), status: z.enum(['active', 'idle', 'completed', 'archived']),
  title: z.string().max(2000), topics: z.array(id).max(100), createdAt: timestamp, updatedAt: timestamp,
  messages: z.array(z.strictObject({ id, sourceRefId: id, role: z.enum(['user', 'assistant', 'system', 'tool']), text, at: timestamp })).max(1000),
});
export type PmAutomationSession = z.infer<typeof pmAutomationSessionSchema>;
export const pmAutomationExecutionSchema = z.strictObject({
  id, sourceRefId: id, sessionId: id, taskId: taskId.nullable(), taskRevision: revision.nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']),
  startedAt: timestamp, finishedAt: timestamp.nullable(), summary: text, reviewed: z.boolean().nullable(),
  tests: z.array(z.strictObject({ name: z.string().min(1).max(2000), status: z.enum(['passed', 'failed', 'skipped', 'unknown']), detail: z.string().max(12000), sourceRefId: id })).max(1000),
  /** Only true for a fully parsed native test snapshot; missing/false never proves all tests passed. */
  testsComplete: z.boolean().optional(),
  diffPaths: z.array(relativePath).max(1000), logs: z.array(z.strictObject({ sourceRefId: id, text: z.string().max(12000), at: timestamp.nullable() })).max(300),
  tools: z.array(z.strictObject({ sourceRefId: id, name: id, status: z.enum(['succeeded', 'failed', 'unknown']), summary: z.string().max(12000) })).max(500),
});
export type PmAutomationExecution = z.infer<typeof pmAutomationExecutionSchema>;
export const pmAutomationPullRequestSchema = z.strictObject({
  id, sourceRefId: id, taskId, taskRevision: revision, headSha: z.string().min(7).max(100), url: z.url().max(2000),
  diffPaths: z.array(relativePath).max(1000),
  coverage: z.array(z.strictObject({ criterion: z.string().max(10000), covered: z.boolean().nullable(), evidence: z.string().max(12000), sourceRefId: id })).max(200),
  observedAt: timestamp,
});
export const pmAutomationMilestoneSchema = z.strictObject({ id, sourceRefId: id, title: z.string().max(2000), taskIds: z.array(taskId).max(1000), dueAt: timestamp.nullable(), completed: z.boolean() });
export const pmAutomationTimeWindowSchema = z.strictObject({ from: timestamp, to: timestamp, basis: z.enum(['lookback', 'last-visit', 'event', 'explicit']) });
export const pmAutomationVersionBoundarySchema = z.strictObject({
  sourceRefId: id, capturedAt: timestamp, provenance: z.enum(['durable-event', 'persisted-snapshot']), task: pmAutomationTaskSchema,
});
export const pmAutomationEventKeySchema = z.enum(['task.created', 'task.updated', 'task.state_changed', 'task.dependencies_changed', 'milestone.changed', 'agent.run.terminal', 'agent.session.idle', 'project.visited']);
export const pmAutomationEventSchema = z.strictObject({
  eventId: id, source: z.literal('pm'), key: pmAutomationEventKeySchema, actorId: uuid, workspaceId: uuid, projectId,
  at: timestamp, sourceRef: pmAutomationSourceRefSchema, originExecutionId: uuid.nullable(),
  before: pmAutomationVersionBoundarySchema.nullable(), after: pmAutomationVersionBoundarySchema.nullable(),
  lastVisitAt: timestamp.nullable(), visitedAt: timestamp.nullable(),
});
export type PmAutomationEvent = z.infer<typeof pmAutomationEventSchema>;
export const pmAutomationSnapshotMaxBytes = 4 * 1024 * 1024;
export const pmAutomationSnapshotSchema = z.strictObject({
  templateId: pmAutomationTemplateIdSchema, executionId: uuid, actorId: uuid, workspaceId: uuid, projectId, observedAt: timestamp,
  args: pmAutomationArgumentsSchema, sources: z.array(pmAutomationSourceRefSchema).max(20000),
  project: pmAutomationProjectSchema, workflow: pmAutomationWorkflowSchema,
  tasks: z.array(pmAutomationTaskSchema).max(2000), documents: z.array(pmAutomationDocumentSchema).max(500),
  relationships: z.array(pmAutomationRelationshipSchema).max(5000), comments: z.array(pmAutomationCommentSchema).max(2000), activities: z.array(pmAutomationActivitySchema).max(2000),
  sessions: z.array(pmAutomationSessionSchema).max(200), executions: z.array(pmAutomationExecutionSchema).max(500),
  pullRequests: z.array(pmAutomationPullRequestSchema).max(100), milestones: z.array(pmAutomationMilestoneSchema).max(200),
  coverage: z.array(pmAutomationCoverageSchema).max(30), timeWindow: pmAutomationTimeWindowSchema.nullable(),
  lastVisitAt: timestamp.nullable(), before: pmAutomationVersionBoundarySchema.nullable(), after: pmAutomationVersionBoundarySchema.nullable(),
  event: pmAutomationEventSchema.nullable(),
}).superRefine((snapshot, context) => {
  const refs = new Map<string, PmAutomationSourceRef>();
  for (const [index, source] of snapshot.sources.entries()) {
    if (refs.has(source.refId)) context.addIssue({ code: 'custom', path: ['sources', index, 'refId'], message: 'Source reference IDs must be unique' });
    refs.set(source.refId, source);
    if (source.actorId !== snapshot.actorId || source.workspaceId !== snapshot.workspaceId || source.projectId !== snapshot.projectId) context.addIssue({ code: 'custom', path: ['sources', index], message: 'Source identity must match the authorized snapshot scope' });
  }
  if (snapshot.project.id !== snapshot.projectId) context.addIssue({ code: 'custom', path: ['project', 'id'], message: 'Project facts must match snapshot scope' });
  for (const [index, task] of snapshot.tasks.entries()) if (task.projectId !== snapshot.projectId) context.addIssue({ code: 'custom', path: ['tasks', index, 'projectId'], message: 'Task facts must match snapshot scope' });
  const seenCoverage = new Set<string>();
  for (const [index, coverage] of snapshot.coverage.entries()) {
    if (seenCoverage.has(coverage.source)) context.addIssue({ code: 'custom', path: ['coverage', index, 'source'], message: 'Coverage sources must be unique' });
    seenCoverage.add(coverage.source);
  }
  for (const source of pmAutomationCoverageKindSchema.options) if (!seenCoverage.has(source)) context.addIssue({ code: 'custom', path: ['coverage'], message: `Missing explicit coverage for ${source}` });
  const visit = (node: unknown, path: (string | number)[]): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const [index, value] of node.entries()) visit(value, [...path, index]); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.sourceRefId === 'string') {
      const source = refs.get(record.sourceRefId);
      const embeddedProjectGoal = source?.kind === 'project' && record.id === `${source.id}:goal` && path[0] === 'project' && path[1] === 'goals';
      if (source && (typeof record.id === 'string' && record.id !== source.id && !embeddedProjectGoal || typeof record.revision === 'string' && record.revision !== source.revision)) context.addIssue({ code: 'custom', path, message: 'Fact identity/revision must match its frozen source reference' });
    }
    for (const key in node) {
      const value = (node as Record<string, unknown>)[key];
      if (key === 'sourceRefId' && typeof value === 'string' && !refs.has(value)) context.addIssue({ code: 'custom', path: [...path, key], message: 'Fact references a source absent from this authorized snapshot' });
      else if (key !== 'sources') visit(value, [...path, key]);
    }
  };
  visit(snapshot, []);
  if (snapshot.timeWindow && Date.parse(snapshot.timeWindow.from) >= Date.parse(snapshot.timeWindow.to)) context.addIssue({ code: 'custom', path: ['timeWindow'], message: 'Observation window must have an increasing boundary' });
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > pmAutomationSnapshotMaxBytes) context.addIssue({ code: 'custom', message: 'Snapshot exceeds 4 MiB; reduce records and explicitly mark partial coverage before freezing' });
});
export type PmAutomationSnapshot = z.infer<typeof pmAutomationSnapshotSchema>;

export const pmAutomationTaskPatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(), description: z.string().max(24000).optional(), acceptanceCriteria: z.array(z.string().max(4000)).max(100).optional(),
  progressNote: z.string().max(8000).optional(), labels: z.array(z.string().min(1).max(80)).max(30).optional(), assigneeIds: z.array(id).max(1).optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one supported task field is required');
export const pmAutomationTaskDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(300), description: z.string().max(24000), acceptanceCriteria: z.array(z.string().max(4000)).max(100),
  labels: z.array(z.string().min(1).max(80)).max(30), dependsOn: z.array(taskId).max(100), relatedTaskIds: z.array(taskId).max(100), milestoneId: id.nullable(),
});
export const pmAutomationDocumentDraftSchema = z.strictObject({ title: z.string().trim().min(1).max(300), body: z.string().max(24000), taskIds: z.array(taskId).max(100) });
export const pmAutomationPlanSchema = z.strictObject({
  title: z.string().trim().min(1).max(300), description: z.string().max(24000),
  tasks: z.array(pmAutomationTaskDraftSchema.extend({ localId: id, dependsOnLocalIds: z.array(id).max(50), existingTaskId: taskId.optional() })).min(1).max(50),
}).superRefine((plan, context) => {
  const items = new Map<string, typeof plan.tasks[number]>();
  const existing = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (items.has(task.localId)) context.addIssue({ code: 'custom', path: ['tasks', index, 'localId'], message: 'Plan item identities must be unique' });
    items.set(task.localId, task);
    if (task.existingTaskId && existing.has(task.existingTaskId)) context.addIssue({ code: 'custom', path: ['tasks', index, 'existingTaskId'], message: 'An existing task cannot appear twice in one plan' });
    if (task.existingTaskId) existing.add(task.existingTaskId);
  }
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (localId: string): void => {
    if (state.get(localId) === 'visiting') { context.addIssue({ code: 'custom', path: ['tasks'], message: 'Plan local dependencies cannot form a cycle' }); return; }
    if (state.get(localId) === 'visited') return;
    state.set(localId, 'visiting');
    for (const dependency of items.get(localId)?.dependsOnLocalIds ?? []) {
      if (!items.has(dependency)) context.addIssue({ code: 'custom', path: ['tasks'], message: 'Plan local dependencies must reference a declared item' });
      else visit(dependency);
    }
    state.set(localId, 'visited');
  };
  for (const localId of items.keys()) visit(localId);
});
const candidateCommon = {
  id, title: z.string().trim().min(1).max(2000), rationale: z.string().max(12000),
  sourceRefs: z.array(pmAutomationSourceRefSchema).min(1).max(100), evidence: z.array(pmAutomationEvidenceSchema).max(100),
  status: z.enum(['pending', 'applied', 'ignored', 'conflict', 'outcome_unknown']), revision: z.number().int().positive(),
  application: z.strictObject({ requestId: uuid, idMap: z.record(id, id) }).optional(),
  reviewSources: z.array(pmAutomationSourceRefSchema).min(1).max(100).optional(),
};
export const pmAutomationCandidateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...candidateCommon, kind: z.literal('task-update'), taskId, expectedRevision: revision, before: pmAutomationTaskPatchSchema, after: pmAutomationTaskPatchSchema }),
  z.strictObject({ ...candidateCommon, kind: z.literal('task-relation'), taskId, expectedRevision: revision, relation: z.enum(['related', 'depends-on']), before: z.array(taskId).max(500), after: z.array(taskId).min(1).max(500) }),
  z.strictObject({ ...candidateCommon, kind: z.literal('task-comment'), taskId, expectedRevision: revision, body: z.string().trim().min(1).max(8000) }),
  z.strictObject({ ...candidateCommon, kind: z.literal('create-task'), task: pmAutomationTaskDraftSchema }),
  z.strictObject({ ...candidateCommon, kind: z.literal('create-document'), document: pmAutomationDocumentDraftSchema }),
  z.strictObject({ ...candidateCommon, kind: z.literal('plan'), plan: pmAutomationPlanSchema }),
  z.strictObject({ ...candidateCommon, kind: z.literal('task-status'), taskId, expectedRevision: revision, before: id, after: id }),
]);
export type PmAutomationCandidate = z.infer<typeof pmAutomationCandidateSchema>;
export const pmAutomationFindingSchema = z.strictObject({
  id, title: z.string().max(2000), detail: z.string().max(20000), severity: z.enum(['info', 'opportunity', 'risk']),
  confidence: z.enum(['low', 'medium', 'high']), evidence: z.array(pmAutomationEvidenceSchema).min(1).max(100), candidateIds: z.array(id).max(100),
});
export type PmAutomationFinding = z.infer<typeof pmAutomationFindingSchema>;
export const pmAutomationGapSchema = z.strictObject({ source: pmAutomationCoverageKindSchema, reason: z.string().min(1).max(4000) });
export const pmAutomationResultSchema = z.strictObject({
  templateId: pmAutomationTemplateIdSchema, executionId: uuid, observedAt: timestamp,
  summary: z.string().max(20000), findings: z.array(pmAutomationFindingSchema).max(200),
  coverage: z.array(pmAutomationCoverageSchema).max(30), gaps: z.array(pmAutomationGapSchema).max(100),
  candidates: z.array(pmAutomationCandidateSchema).max(200),
}).superRefine((result, context) => {
  const candidateIds = new Set<string>();
  for (const [index, candidate] of result.candidates.entries()) {
    if (candidateIds.has(candidate.id)) context.addIssue({ code: 'custom', path: ['candidates', index, 'id'], message: 'Candidate IDs must be unique' });
    candidateIds.add(candidate.id);
    const refs = new Set(candidate.sourceRefs.map(source => source.refId));
    for (const evidence of candidate.evidence) if (!refs.has(evidence.sourceRefId)) context.addIssue({ code: 'custom', path: ['candidates', index, 'evidence'], message: 'Candidate evidence requires its frozen source reference' });
  }
  const findingIds = new Set<string>();
  for (const [index, finding] of result.findings.entries()) {
    if (findingIds.has(finding.id)) context.addIssue({ code: 'custom', path: ['findings', index, 'id'], message: 'Finding IDs must be unique' });
    findingIds.add(finding.id);
    for (const candidateId of finding.candidateIds) if (!candidateIds.has(candidateId)) context.addIssue({ code: 'custom', path: ['findings', index, 'candidateIds'], message: 'Finding references an absent candidate' });
  }
});
export type PmAutomationResult = z.infer<typeof pmAutomationResultSchema>;

/** Bind untrusted analysis to a frozen authorized run. Model output cannot mint sources, revisions or review state. */
export function validatePmAutomationResult(snapshot: PmAutomationSnapshot, value: unknown): PmAutomationResult {
  const result = pmAutomationResultSchema.parse(value);
  if (result.templateId !== snapshot.templateId || result.executionId !== snapshot.executionId || result.observedAt !== snapshot.observedAt) throw new Error('PM analysis result does not match the original frozen execution');
  const sources = new Map(snapshot.sources.map(source => [source.refId, source]));
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
  const sourceText = new Map<string, string[]>();
  for (const source of sources.values()) sourceText.set(source.refId, [source.label, source.id, source.revision, JSON.stringify(source, null, 2)]);
  const indexText = (node: unknown, inheritedRef: string | null): void => {
    if (node === null) return;
    if (typeof node === 'string') { if (inheritedRef) sourceText.get(inheritedRef)?.push(node); return; }
    if (Array.isArray(node)) { for (const value of node) indexText(value, inheritedRef); return; }
    if (typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const ownRef = typeof record.sourceRefId === 'string' ? record.sourceRefId : inheritedRef;
    if (typeof record.sourceRefId === 'string') sourceText.get(record.sourceRefId)?.push(JSON.stringify(record, null, 2), JSON.stringify(record));
    for (const key in record) if (key !== 'sources') indexText(record[key], ownRef);
  };
  indexText(snapshot, null);
  const checkEvidence = (evidence: PmAutomationEvidence): void => {
    if (!sources.has(evidence.sourceRefId) || !sourceText.get(evidence.sourceRefId)?.some(value => value.includes(evidence.quote))) throw new Error('PM evidence quote is not a direct excerpt of its frozen trusted source');
  };
  for (const finding of result.findings) for (const evidence of finding.evidence) checkEvidence(evidence);
  for (const candidate of result.candidates) {
    if (candidate.status !== 'pending' || candidate.revision !== 1 || candidate.application !== undefined || candidate.reviewSources !== undefined) throw new Error('PM analysis cannot assign review state, revisions, rebase sources or application receipts');
    for (const source of candidate.sourceRefs) {
      const trusted = sources.get(source.refId);
      if (!trusted || (Object.keys(source) as (keyof PmAutomationSourceRef)[]).some(key => source[key] !== trusted[key])) throw new Error('PM candidate changed a trusted source identity or revision');
    }
    for (const evidence of candidate.evidence) checkEvidence(evidence);
    if ('taskId' in candidate) {
      const task = tasks.get(candidate.taskId);
      if (!task || candidate.expectedRevision !== task.revision || !candidate.sourceRefs.some(source => source.refId === task.sourceRefId)) throw new Error('PM candidate task/revision is not bound to its frozen source');
      if (candidate.kind === 'task-status') {
        const status = snapshot.workflow.statuses.find(item => item.id === candidate.after);
        const current = snapshot.workflow.statuses.find(item => item.id === task.status);
        if (candidate.before !== task.status || !status || status.category === 'completed' || status.category === 'canceled' || !current?.nextStatusIds.includes(status.id)) throw new Error('PM analysis cannot propose an unavailable or terminal workflow transition');
      } else if (candidate.kind === 'task-relation') {
        const before = candidate.relation === 'related' ? task.relatedTaskIds : task.dependsOn;
        if (before.length !== candidate.before.length || before.some(value => !candidate.before.includes(value))) throw new Error('PM relation preview does not match the frozen current relation');
        for (const related of candidate.after) if (!tasks.has(related) || related === task.id) throw new Error('PM candidate relation requires an explicitly observed different task');
      } else if (candidate.kind === 'task-update') {
        for (const key of Object.keys(candidate.before) as (keyof typeof candidate.before)[]) if (JSON.stringify(candidate.before[key]) !== JSON.stringify(task[key])) throw new Error('PM task preview does not match its frozen current value');
        for (const key of Object.keys(candidate.after)) if (!Object.hasOwn(candidate.before, key)) throw new Error('PM task update requires a before preview for every changed field');
      }
    }
    const drafts = candidate.kind === 'create-task' ? [candidate.task] : candidate.kind === 'plan' ? candidate.plan.tasks : [];
    for (const task of drafts) {
      for (const dependency of [...task.dependsOn, ...task.relatedTaskIds]) if (!tasks.has(dependency)) throw new Error('PM draft contains a task reference absent from its authorized snapshot');
      if (task.milestoneId && !snapshot.milestones.some(milestone => milestone.id === task.milestoneId)) throw new Error('PM draft contains a milestone absent from its authorized snapshot');
      if ('existingTaskId' in task && task.existingTaskId && !tasks.has(task.existingTaskId as string)) throw new Error('PM plan refers to an unobserved existing task');
    }
    if (candidate.kind === 'create-document') for (const taskId of candidate.document.taskIds) if (!tasks.has(taskId)) throw new Error('PM document refers to an unobserved task');
  }
  const observedCoverage = new Map(snapshot.coverage.map(coverage => [coverage.source, coverage]));
  const outputCoverage = new Map(result.coverage.map(coverage => [coverage.source, coverage]));
  for (const source of pmAutomationCoverageKindSchema.options) {
    const original = observedCoverage.get(source);
    const output = outputCoverage.get(source);
    if (!original || !output || output.observedRecords > original.observedRecords || output.status === 'complete' && (original.status !== 'complete' || output.observedRecords !== original.observedRecords)) throw new Error('PM analysis cannot upgrade or omit frozen source coverage');
    if (output.status !== 'complete' && !result.gaps.some(gap => gap.source === source)) throw new Error('PM analysis must retain explicit incomplete-source gaps');
  }
  return result;
}
/** Agent evidence is accepted only by the run-bound service endpoint and authorized again by PM. */
export const pmAutomationAgentEvidenceSchema = z.strictObject({
  sources: z.array(pmAutomationSourceRefSchema).max(10000), sessions: z.array(pmAutomationSessionSchema).max(200),
  executions: z.array(pmAutomationExecutionSchema).max(500), coverage: z.array(pmAutomationCoverageSchema).max(30),
  pullRequests: z.array(pmAutomationPullRequestSchema).max(100),
});
export const pmAutomationVisitRequestSchema = z.strictObject({ requestId: uuid, projectId });
export type PmAutomationAgentEvidence = z.infer<typeof pmAutomationAgentEvidenceSchema>;
export const pmAutomationSnapshotInputSchema = z.strictObject({ agentEvidence: pmAutomationAgentEvidenceSchema });
export const pmAutomationPublishSchema = z.strictObject({ result: pmAutomationResultSchema });
export const pmAutomationReviewRequestSchema = z.strictObject({ requestId: uuid, expectedRevision: z.number().int().positive() });
export const pmAutomationCandidateEditSchema = pmAutomationReviewRequestSchema.extend({ candidate: pmAutomationCandidateSchema });
export const pmAutomationPreviewRequestSchema = pmAutomationReviewRequestSchema.extend({ selectedItemIds: uniqueIds(id, 50).optional() });
export const pmAutomationApplyRequestSchema = pmAutomationPreviewRequestSchema.extend({ previewToken: z.string().min(1).max(300) });
export const pmAutomationCandidatePreviewSchema = z.strictObject({
  candidate: pmAutomationCandidateSchema, currentSources: z.array(pmAutomationSourceRefSchema).max(100),
  currentTask: pmAutomationTaskSchema.nullable(),
  canApply: z.boolean(), conflicts: z.array(z.string().max(4000)).max(100), previewToken: z.string().max(300).nullable(), selectedItemIds: z.array(id).max(50),
});
export type PmAutomationCandidatePreview = z.infer<typeof pmAutomationCandidatePreviewSchema>;
export const pmAutomationReviewResultSchema = z.strictObject({
  candidate: pmAutomationCandidateSchema, idMap: z.record(id, id),
  status: z.enum(['applied', 'ignored', 'edited', 'conflict', 'outcome_unknown']),
});
export const pmAutomationReviewReceiptSchema = z.strictObject({
  requestId: uuid, httpStatus: z.number().int().min(100).max(599), result: z.union([pmAutomationReviewResultSchema, pmAutomationCandidatePreviewSchema]),
});
export type PmAutomationReviewReceipt = z.infer<typeof pmAutomationReviewReceiptSchema>;

export type PmAutomationSourceKind = z.infer<typeof pmAutomationSourceKindSchema>;
export type PmAutomationCoverageKind = z.infer<typeof pmAutomationCoverageKindSchema>;
export type PmAutomationStatusCategory = z.infer<typeof pmAutomationStatusCategorySchema>;
export type PmAutomationWorkflow = z.infer<typeof pmAutomationWorkflowSchema>;
export type PmAutomationProject = z.infer<typeof pmAutomationProjectSchema>;
export type PmAutomationDocument = z.infer<typeof pmAutomationDocumentSchema>;
export type PmAutomationRelationship = z.infer<typeof pmAutomationRelationshipSchema>;
export type PmAutomationComment = z.infer<typeof pmAutomationCommentSchema>;
export type PmAutomationActivity = z.infer<typeof pmAutomationActivitySchema>;
export type PmAutomationPullRequest = z.infer<typeof pmAutomationPullRequestSchema>;
export type PmAutomationMilestone = z.infer<typeof pmAutomationMilestoneSchema>;
export type PmAutomationTimeWindow = z.infer<typeof pmAutomationTimeWindowSchema>;
export type PmAutomationVersionBoundary = z.infer<typeof pmAutomationVersionBoundarySchema>;
export type PmAutomationEventKey = z.infer<typeof pmAutomationEventKeySchema>;
export type PmAutomationTaskPatch = z.infer<typeof pmAutomationTaskPatchSchema>;
export type PmAutomationTaskDraft = z.infer<typeof pmAutomationTaskDraftSchema>;
export type PmAutomationDocumentDraft = z.infer<typeof pmAutomationDocumentDraftSchema>;
export type PmAutomationPlan = z.infer<typeof pmAutomationPlanSchema>;
export type PmAutomationSnapshotInput = z.infer<typeof pmAutomationSnapshotInputSchema>;
export type PmAutomationPublish = z.infer<typeof pmAutomationPublishSchema>;
export type PmAutomationVisitRequest = z.infer<typeof pmAutomationVisitRequestSchema>;
export type PmAutomationReviewRequest = z.infer<typeof pmAutomationReviewRequestSchema>;
export type PmAutomationCandidateEdit = z.infer<typeof pmAutomationCandidateEditSchema>;
export type PmAutomationPreviewRequest = z.infer<typeof pmAutomationPreviewRequestSchema>;
export type PmAutomationApplyRequest = z.infer<typeof pmAutomationApplyRequestSchema>;
export type PmAutomationReviewResult = z.infer<typeof pmAutomationReviewResultSchema>;
