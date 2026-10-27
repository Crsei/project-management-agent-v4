import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Capability, Entity } from '../../domain/src/core.ts';
import { assertCriteria, assertNoDependencyCycle, assertPassedReview, assertProjectWritable, assertReadyScope, assertRule, assertSameProject, assertSchedule, assertStatus, assertUnarchived } from '../../domain/src/planning.ts';
import { MAX_WORK_ITEM_ESTIMATE_POINTS, MAX_WORK_ITEM_LOCATION_LENGTH } from '../../pm-schema/index.ts';
import type { CommandContext, CommandDefinition, CommandRegistry } from './ports.ts';
import { localDirectorySchema } from '../../contracts/src/local-projects.ts';

const uuid = z.uuid().toLowerCase();
const text = z.string().trim().min(1).max(16000);
const title = z.string().trim().min(1).max(300);
const reasonPayload = z.strictObject({ reason: text });
const emptyPayload = z.strictObject({});
const criteria = z.array(z.strictObject({ id: z.union([uuid, z.string().regex(/^[A-Z][A-Z0-9]*-\d+-AC-[1-9]\d*$/)]), text })).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate criterion ID');
const scopeFields = { title, description: z.string().max(64000), acceptanceCriteria: criteria };
const workFields = {
  ...scopeFields,
  assigneeId: uuid.nullable().default(null),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable().default(null),
  startDate: z.iso.date().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  labels: z.array(z.string().min(1).refine(value => value.trim().length > 0, 'Expected nonempty label')).optional(),
  kind: z.enum(['epic', 'task', 'bug', 'subtask']).optional(),
  parentId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'Expected a stable task ID').nullable().optional(),
  estimatePoints: z.number().finite().nonnegative().max(MAX_WORK_ITEM_ESTIMATE_POINTS).nullable().optional(),
  location: z.string().trim().max(MAX_WORK_ITEM_LOCATION_LENGTH).nullable().optional(),
};
const criteriaChecks = z.array(z.strictObject({ criterionIndex: z.number().int().nonnegative(), explanation: text })).min(1).max(100);

function command(payload: CommandDefinition['payload'], handler: CommandDefinition['handler']): CommandDefinition {
  return { payload, handler };
}

function targetId(ctx: CommandContext): string {
  if (!ctx.command.targetId) throw new DomainError('target_required');
  return ctx.command.targetId;
}

async function requireMember(ctx: CommandContext, userId: string | null): Promise<void> {
  if (!userId) return;
  const membership = await ctx.sql.query('SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL', [ctx.workspaceId, userId]);
  assertRule(membership.rows.length === 1, 'workspace_member_required');
}

async function project(ctx: CommandContext, id: string, capability: Capability, active = false, writable = true): Promise<Entity> {
  await ctx.require(capability, id);
  const entity = await ctx.get(id, 'project');
  assertRule(!ctx.command.projectId || ctx.command.projectId === id, 'project_mismatch');
  if (writable) assertProjectWritable(entity, active);
  return entity;
}

async function createProjectScope(ctx: CommandContext): Promise<Entity> {
  if (!ctx.command.projectId) throw new DomainError('project_required');
  return project(ctx, ctx.command.projectId, 'planning.edit');
}

async function workItem(ctx: CommandContext, capability: Capability = 'planning.edit', active = false): Promise<Entity> {
  const item = await ctx.get(targetId(ctx), 'work_item');
  assertRule(item.projectId, 'project_required');
  await project(ctx, item.projectId, capability, active);
  assertUnarchived(item);
  ctx.checkVersion(item);
  return item;
}

async function milestone(ctx: CommandContext, active = false): Promise<Entity> {
  const item = await ctx.get(targetId(ctx), 'milestone');
  assertRule(item.projectId, 'project_required');
  await project(ctx, item.projectId, 'planning.lifecycle', active);
  ctx.checkVersion(item);
  return item;
}

async function changed(ctx: CommandContext, entity: Entity, patch: Record<string, unknown>, eventType: string, event: Record<string, unknown> = {}): Promise<Entity> {
  const result = await ctx.update(entity, { ...entity.data, ...patch });
  const state = entity.kind === 'work_item'
    ? { status: result.data.status, contentRevision: result.data.contentRevision, currentSubmissionId: result.data.currentSubmissionId, milestoneId: result.data.milestoneId }
    : { status: result.data.status };
  await ctx.emit(eventType, result, { ...state, ...event });
  return result;
}

async function prerequisitesDone(ctx: CommandContext, item: Entity): Promise<void> {
  assertRule(item.data.manualBlockReasons.length === 0, 'work_item_blocked');
  for (const id of item.data.prerequisiteIds as string[]) {
    const prerequisite = await ctx.get(id, 'work_item');
    assertSameProject(prerequisite, item.projectId!);
    assertRule(prerequisite.data.status === 'done', 'prerequisite_not_done');
  }
}

function confirmCriteria(entity: Entity, results: { criterionIndex: number; explanation: string }[], field: string): void {
  const list = entity.data[field] as string[];
  assertRule(list.length > 0 && results.length === list.length && new Set(results.map(item => item.criterionIndex)).size === list.length && results.every(item => item.criterionIndex < list.length), 'criteria_confirmation_required');
}

async function checkMilestoneAssignment(ctx: CommandContext, milestoneId: string, projectId: string): Promise<Entity> {
  const value = await ctx.get(milestoneId, 'milestone');
  assertSameProject(value, projectId);
  assertStatus(value, ['planned']);
  return value;
}

function initialWorkData(payload: Record<string, any>, originIntentRef: unknown = null): Record<string, any> {
  assertSchedule(payload.startDate ?? null, payload.dueDate ?? null);
  return { ...payload, startDate: payload.startDate ?? null, dueDate: payload.dueDate ?? null, contentRevision: 1, status: 'draft', milestoneId: null, manualBlockReasons: [], prerequisiteIds: [], currentSubmissionId: null, completionRecord: null, completionHistory: [], archivedAt: null, originIntentRef };
}

// This first-stage schema has no Session/Run kind and execution has never been
// initialized. No handler may create a Run. Adding execution requires a shared
// transaction occupancy guard here and in Delivery before enabling its commands;
// a disabled feature flag must never replace that future authoritative guard.
export const planningCommands: CommandRegistry = {
  CreateProject: command(z.strictObject({ name: title, goal: z.string().max(64000), ownerId: uuid.nullable(), completionCriteria: z.array(text).max(100), localDirectory: localDirectorySchema.optional(), startDate: z.iso.date().optional(), dueDate: z.iso.date().optional(), description: z.string().max(64000).optional() }), async ctx => {
    await ctx.require('planning.edit', null);
    assertRule(!ctx.command.projectId && !ctx.command.targetId, 'invalid_scope');
    await requireMember(ctx, ctx.command.payload.ownerId as string | null);
    const entity = await ctx.insert('project', { ...ctx.command.payload, status: 'planning', archivedAt: null, completionRecord: null, lifecycleHistory: [] }, null);
    await ctx.emit('ProjectCreated', entity);
    return entity;
  }),

  DuplicateProject: command(z.strictObject({ name: title, includeTasks: z.boolean(), localDirectory: localDirectorySchema.optional() }), async () => {
    throw new DomainError('core_command_required', 'Project duplication requires the authoritative Markdown core', 409);
  }),

  UpdateProject: command(z.strictObject({ name: title, goal: z.string().max(64000), ownerId: uuid.nullable(), completionCriteria: z.array(text).max(100),
    description: z.string().max(64000).optional(), dueDate: z.iso.date().nullable().optional(),
    icon: z.string().max(40).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).nullable().optional(), color: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable().optional() }), async ctx => {
    const entity = await project(ctx, targetId(ctx), 'planning.edit');
    ctx.checkVersion(entity);
    await requireMember(ctx, ctx.command.payload.ownerId as string | null);
    if (entity.data.status === 'active') assertRule((ctx.command.payload.goal as string).trim() && ctx.command.payload.ownerId && (ctx.command.payload.completionCriteria as string[]).length, 'project_definition_required');
    return changed(ctx, entity, ctx.command.payload, 'ProjectUpdated');
  }),

  ActivateProject: command(emptyPayload, async ctx => {
    const entity = await project(ctx, targetId(ctx), 'planning.lifecycle');
    ctx.checkVersion(entity);
    assertStatus(entity, ['planning']);
    assertRule(entity.data.goal.trim() && entity.data.ownerId && entity.data.completionCriteria.length, 'project_definition_required');
    await requireMember(ctx, entity.data.ownerId);
    return changed(ctx, entity, { status: 'active' }, 'ProjectActivated');
  }),

  CompleteProject: command(z.strictObject({ reason: text, criteriaChecks }), async ctx => {
    const entity = await project(ctx, targetId(ctx), 'planning.lifecycle', true);
    ctx.checkVersion(entity);
    confirmCriteria(entity, ctx.command.payload.criteriaChecks as any, 'completionCriteria');
    const items = await ctx.list('work_item', entity.id);
    const milestones = await ctx.list('milestone', entity.id);
    assertRule(items.every(item => ['done', 'cancelled'].includes(item.data.status)), 'unfinished_work_items');
    assertRule(milestones.every(item => ['achieved', 'cancelled'].includes(item.data.status)), 'unfinished_milestones');
    assertRule([...items, ...milestones].every(item => item.data.status !== 'cancelled' || item.data.cancellationRecord?.reason), 'cancellation_reason_required');
    const completionRecord = { ...ctx.command.payload, completedBy: ctx.actor.id, completedAt: new Date().toISOString() };
    return changed(ctx, entity, { status: 'completed', completionRecord }, 'ProjectCompleted');
  }),

  CancelProject: command(reasonPayload, async ctx => {
    const entity = await project(ctx, targetId(ctx), 'planning.lifecycle');
    ctx.checkVersion(entity);
    const items = await ctx.list('work_item', entity.id);
    const milestones = await ctx.list('milestone', entity.id);
    assertRule(items.every(item => ['done', 'cancelled'].includes(item.data.status)), 'unfinished_work_items');
    assertRule(milestones.every(item => ['achieved', 'cancelled'].includes(item.data.status)), 'unfinished_milestones');
    return changed(ctx, entity, { status: 'cancelled', cancellationRecord: { reason: ctx.command.payload.reason, cancelledBy: ctx.actor.id, cancelledAt: new Date().toISOString() } }, 'ProjectCancelled');
  }),

  ReopenProject: command(reasonPayload.extend({ definition: z.strictObject({ goal: text, ownerId: uuid, completionCriteria: z.array(text).min(1).max(100) }).optional() }), async ctx => {
    const entity = await project(ctx, targetId(ctx), 'planning.lifecycle', false, false);
    assertUnarchived(entity);
    ctx.checkVersion(entity);
    assertStatus(entity, ['completed', 'cancelled']);
    const definition = (ctx.command.payload.definition ?? { goal: entity.data.goal, ownerId: entity.data.ownerId, completionCriteria: entity.data.completionCriteria }) as { goal: string; ownerId: string | null; completionCriteria: string[] };
    assertRule(definition.goal.trim() && definition.ownerId && definition.completionCriteria.length, 'project_definition_required');
    await requireMember(ctx, definition.ownerId);
    const record = { previousStatus: entity.data.status, previousDefinition: { goal: entity.data.goal, ownerId: entity.data.ownerId, completionCriteria: entity.data.completionCriteria }, completionRecord: entity.data.completionRecord, cancellationRecord: entity.data.cancellationRecord ?? null, reason: ctx.command.payload.reason, reopenedBy: ctx.actor.id, reopenedAt: new Date().toISOString() };
    return changed(ctx, entity, { ...definition, status: 'active', completionRecord: null, cancellationRecord: null, lifecycleHistory: [...(entity.data.lifecycleHistory ?? []), record] }, 'ProjectReopened');
  }),

  CreateWorkItem: command(z.strictObject(workFields), async ctx => {
    const scope = await createProjectScope(ctx);
    assertRule(!ctx.command.targetId, 'invalid_scope');
    await requireMember(ctx, ctx.command.payload.assigneeId as string | null);
    const entity = await ctx.insert('work_item', initialWorkData(ctx.command.payload), scope.id);
    await ctx.emit('WorkItemCreated', entity);
    return entity;
  }),

  CreateWorkItemFromIntent: command(z.strictObject({ ...workFields, intentId: uuid, acceptedRevision: z.number().int().positive(), decisionId: uuid }), async ctx => {
    const scope = await createProjectScope(ctx);
    assertRule(!ctx.command.targetId, 'invalid_scope');
    const p = ctx.command.payload;
    const intent = await ctx.get(p.intentId as string, 'intent');
    assertRule(intent.projectId === null || intent.projectId === scope.id, 'project_mismatch');
    assertRule(intent.data.status === 'accepted' && intent.data.revision === p.acceptedRevision && intent.data.acceptedDecisionId === p.decisionId, 'accepted_intent_required');
    const decision = await ctx.get(p.decisionId as string, 'decision');
    assertRule(decision.data.subjectRef?.id === intent.id && decision.data.subjectRef?.kind === 'intent' && decision.data.decisionType === 'accept_intent' && decision.data.acceptedRevision === p.acceptedRevision, 'accepted_intent_required');
    // A project-scoped editor cannot list other projects. The workspace-wide
    // database unique constraint also prevents conversion into another project.
    const existing = (await ctx.list('work_item', scope.id)).find(item => item.data.originIntentRef?.intentId === intent.id && item.data.originIntentRef?.acceptedRevision === p.acceptedRevision);
    assertRule(!existing, 'intent_already_converted');
    await requireMember(ctx, p.assigneeId as string | null);
    const { intentId, acceptedRevision, decisionId, ...initial } = p;
    const originIntentRef = { intentId, acceptedRevision, decisionId };
    const entity = await ctx.insert('work_item', initialWorkData(initial, originIntentRef), scope.id);
    await ctx.emit('WorkItemCreated', entity, { originIntentRef });
    return entity;
  }),

  UpdateWorkItemContent: command(z.strictObject(scopeFields), async ctx => {
    const entity = await workItem(ctx);
    assertStatus(entity, ['draft', 'ready', 'in_progress', 'in_review']);
    const p = ctx.command.payload;
    if (['in_progress', 'in_review'].includes(entity.data.status)) {
      assertCriteria(p.acceptanceCriteria as any);
      assertRule((p.description as string).trim(), 'scope_required');
    }
    const status = entity.data.status === 'ready' ? 'draft' : entity.data.status === 'in_review' ? 'in_progress' : entity.data.status;
    return changed(ctx, entity, { ...p, status, contentRevision: entity.data.contentRevision + 1, currentSubmissionId: null }, 'WorkItemContentChanged', { invalidatedSubmissionId: entity.data.currentSubmissionId });
  }),

  UpdateWorkItemMetadata: command(z.strictObject({ assigneeId: uuid.nullable().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable().optional(), startDate: z.iso.date().nullable().optional(), dueDate: z.iso.date().nullable().optional() }).refine(p => Object.keys(p).length > 0, 'At least one field is required'), async ctx => {
    const entity = await workItem(ctx);
    const { startDate = entity.data.startDate ?? null, dueDate = entity.data.dueDate ?? null } = ctx.command.payload;
    assertSchedule(startDate, dueDate);
    const assigneeId = ctx.command.payload.assigneeId;
    if (assigneeId !== undefined) {
      await requireMember(ctx, assigneeId as string | null);
      assertRule(!['ready', 'in_progress', 'in_review'].includes(entity.data.status) || assigneeId, 'assignee_required');
    }
    return changed(ctx, entity, ctx.command.payload, 'WorkItemMetadataChanged');
  }),

  SetWorkItemBlockers: command(z.strictObject({ manualBlockReasons: z.array(text).max(100) }), async ctx => {
    const entity = await workItem(ctx);
    assertStatus(entity, ['draft', 'ready', 'in_progress', 'in_review']);
    return changed(ctx, entity, ctx.command.payload, 'WorkItemBlockersChanged');
  }),

  ReadyWorkItem: command(emptyPayload, async ctx => {
    const entity = await workItem(ctx);
    assertStatus(entity, ['draft']);
    assertReadyScope(entity);
    await requireMember(ctx, entity.data.assigneeId);
    return changed(ctx, entity, { status: 'ready' }, 'WorkItemReadied');
  }),

  StartWorkItem: command(emptyPayload, async ctx => {
    const entity = await workItem(ctx, 'planning.edit', true);
    assertStatus(entity, ['ready']);
    assertReadyScope(entity);
    await requireMember(ctx, entity.data.assigneeId);
    await prerequisitesDone(ctx, entity);
    return changed(ctx, entity, { status: 'in_progress' }, 'WorkItemStarted');
  }),

  AddDependency: command(z.strictObject({ prerequisiteId: uuid }), async ctx => {
    const entity = await workItem(ctx);
    assertStatus(entity, ['draft', 'ready', 'in_progress', 'in_review']);
    const id = ctx.command.payload.prerequisiteId as string;
    const prerequisite = await ctx.get(id, 'work_item');
    assertSameProject(prerequisite, entity.projectId!);
    assertRule(!entity.data.prerequisiteIds.includes(id), 'duplicate_dependency');
    assertNoDependencyCycle(await ctx.list('work_item', entity.projectId!), entity.id, id);
    return changed(ctx, entity, { prerequisiteIds: [...entity.data.prerequisiteIds, id] }, 'DependencyAdded', { prerequisiteId: id });
  }),

  RemoveDependency: command(z.strictObject({ prerequisiteId: uuid }), async ctx => {
    const entity = await workItem(ctx);
    assertStatus(entity, ['draft', 'ready', 'in_progress', 'in_review']);
    const id = ctx.command.payload.prerequisiteId as string;
    assertRule(entity.data.prerequisiteIds.includes(id), 'dependency_not_found');
    return changed(ctx, entity, { prerequisiteIds: entity.data.prerequisiteIds.filter((value: string) => value !== id) }, 'DependencyRemoved', { prerequisiteId: id });
  }),

  CreateMilestone: command(z.strictObject({ title, criteria: z.array(text).max(100), targetDate: z.iso.date().nullable().default(null) }), async ctx => {
    const scope = await createProjectScope(ctx);
    assertRule(!ctx.command.targetId, 'invalid_scope');
    const entity = await ctx.insert('milestone', { ...ctx.command.payload, status: 'planned', achievementRecord: null, achievementHistory: [] }, scope.id);
    await ctx.emit('MilestoneCreated', entity);
    return entity;
  }),

  AssignMilestone: command(z.strictObject({ milestoneId: uuid }), async ctx => {
    const entity = await workItem(ctx);
    assertStatus(entity, ['draft', 'ready', 'in_progress', 'in_review']);
    if (entity.data.milestoneId) await checkMilestoneAssignment(ctx, entity.data.milestoneId, entity.projectId!);
    await checkMilestoneAssignment(ctx, ctx.command.payload.milestoneId as string, entity.projectId!);
    assertRule(entity.data.milestoneId !== ctx.command.payload.milestoneId, 'milestone_already_assigned');
    return changed(ctx, entity, { milestoneId: ctx.command.payload.milestoneId }, 'WorkItemMilestoneChanged');
  }),

  UnassignMilestone: command(z.strictObject({ milestoneId: uuid }), async ctx => {
    const entity = await workItem(ctx);
    assertRule(entity.data.milestoneId === ctx.command.payload.milestoneId, 'milestone_mismatch');
    await checkMilestoneAssignment(ctx, entity.data.milestoneId, entity.projectId!);
    return changed(ctx, entity, { milestoneId: null }, 'WorkItemMilestoneChanged', { previousMilestoneId: entity.data.milestoneId });
  }),

  AchieveMilestone: command(z.strictObject({ reason: text, criteriaChecks }), async ctx => {
    const entity = await milestone(ctx, true);
    assertStatus(entity, ['planned']);
    confirmCriteria(entity, ctx.command.payload.criteriaChecks as any, 'criteria');
    const members = (await ctx.list('work_item', entity.projectId!)).filter(item => item.data.milestoneId === entity.id);
    assertRule(members.every(item => item.data.status === 'done'), 'milestone_members_not_done');
    return changed(ctx, entity, { status: 'achieved', achievementRecord: { ...ctx.command.payload, achievedBy: ctx.actor.id, achievedAt: new Date().toISOString() } }, 'MilestoneAchieved');
  }),

  CancelMilestone: command(reasonPayload, async ctx => {
    const entity = await milestone(ctx);
    assertStatus(entity, ['planned']);
    const members = (await ctx.list('work_item', entity.projectId!)).filter(item => item.data.milestoneId === entity.id);
    assertRule(members.length === 0, 'milestone_has_members');
    return changed(ctx, entity, { status: 'cancelled', cancellationRecord: { reason: ctx.command.payload.reason, cancelledBy: ctx.actor.id, cancelledAt: new Date().toISOString() } }, 'MilestoneCancelled');
  }),

  ReopenMilestone: command(reasonPayload, async ctx => {
    const entity = await milestone(ctx, true);
    assertStatus(entity, ['achieved', 'cancelled']);
    const history = { previousStatus: entity.data.status, achievementRecord: entity.data.achievementRecord, cancellationRecord: entity.data.cancellationRecord ?? null, reason: ctx.command.payload.reason, reopenedBy: ctx.actor.id, reopenedAt: new Date().toISOString() };
    return changed(ctx, entity, { status: 'planned', achievementRecord: null, cancellationRecord: null, achievementHistory: [...entity.data.achievementHistory, history] }, 'MilestoneReopened');
  }),

  // Core completion has no delivery prerequisites. SQL-managed work retains
  // its reviewed completion checks below when this shared payload is handled here.
  CompleteWorkItem: command(z.strictObject({ submissionId: uuid.optional(), reviewId: uuid.optional() }), async ctx => {
    const entity = await workItem(ctx, 'workitem.complete', true);
    const { submissionId, reviewId } = ctx.command.payload;
    if (typeof submissionId !== 'string' || typeof reviewId !== 'string') throw new DomainError('validation_failed', 'SQL-managed completion requires submissionId and reviewId', 400);
    assertStatus(entity, ['in_review']);
    await prerequisitesDone(ctx, entity);
    const submission = await ctx.get(submissionId, 'submission');
    const review = await ctx.get(reviewId, 'review');
    assertPassedReview(entity, submission, review);
    const completionRecord = { reviewId: review.id, submissionId: submission.id, contentRevision: entity.data.contentRevision, completedBy: ctx.actor.id, completedAt: new Date().toISOString() };
    return changed(ctx, entity, { status: 'done', completionRecord }, 'WorkItemCompleted', { ...completionRecord, completionRecord });
  }),

  CancelWorkItem: command(reasonPayload, async ctx => {
    const entity = await workItem(ctx, 'workitem.cancel_reopen');
    assertStatus(entity, ['draft', 'ready', 'in_progress', 'in_review']);
    return changed(ctx, entity, { status: 'cancelled', cancellationRecord: { reason: ctx.command.payload.reason, cancelledBy: ctx.actor.id, cancelledAt: new Date().toISOString() } }, 'WorkItemCancelled');
  }),

  ReopenWorkItem: command(reasonPayload, async ctx => {
    const entity = await workItem(ctx, 'workitem.cancel_reopen', true);
    assertStatus(entity, ['done', 'cancelled']);
    if (entity.data.milestoneId) await checkMilestoneAssignment(ctx, entity.data.milestoneId, entity.projectId!);
    const completionHistory = entity.data.completionRecord ? [...entity.data.completionHistory, entity.data.completionRecord] : entity.data.completionHistory;
    const reopened = { reason: ctx.command.payload.reason, previousStatus: entity.data.status, cancellationRecord: entity.data.cancellationRecord ?? null, reopenedBy: ctx.actor.id, reopenedAt: new Date().toISOString() };
    return changed(ctx, entity, { status: 'draft', currentSubmissionId: null, completionRecord: null, completionHistory, cancellationRecord: null, reopenHistory: [...(entity.data.reopenHistory ?? []), reopened] }, 'WorkItemReopened');
  }),

  DeleteObject: command(z.strictObject({ kind: z.enum(['project', 'work_item']) }), async () => {
    throw new DomainError('core_command_required', 'Permanent deletion requires the authoritative Markdown core and its reference guards', 409);
  }),

  ArchiveObject: command(z.strictObject({ kind: z.enum(['project', 'work_item']), reason: text }), async ctx => {
    const entity = await ctx.get(targetId(ctx), ctx.command.payload.kind as 'project' | 'work_item');
    await project(ctx, entity.kind === 'project' ? entity.id : entity.projectId!, 'planning.lifecycle', false, false);
    if (entity.kind !== 'project') assertUnarchived(await ctx.get(entity.projectId!, 'project'));
    assertUnarchived(entity);
    ctx.checkVersion(entity);
    assertStatus(entity, entity.kind === 'project' ? ['completed', 'cancelled'] : ['done', 'cancelled']);
    return changed(ctx, entity, { archivedAt: new Date().toISOString(), archiveReason: ctx.command.payload.reason }, entity.kind === 'project' ? 'ProjectArchived' : 'WorkItemArchived');
  }),

  RestoreArchivedObject: command(z.strictObject({ kind: z.enum(['project', 'work_item']), reason: text }), async ctx => {
    const entity = await ctx.get(targetId(ctx), ctx.command.payload.kind as 'project' | 'work_item');
    await project(ctx, entity.kind === 'project' ? entity.id : entity.projectId!, 'planning.lifecycle', false, false);
    if (entity.kind !== 'project') assertUnarchived(await ctx.get(entity.projectId!, 'project'));
    ctx.checkVersion(entity);
    assertRule(entity.data.archivedAt, 'object_not_archived');
    return changed(ctx, entity, { archivedAt: null, restoreHistory: [...(entity.data.restoreHistory ?? []), { reason: ctx.command.payload.reason, restoredBy: ctx.actor.id, restoredAt: new Date().toISOString() }] }, entity.kind === 'project' ? 'ProjectRestored' : 'WorkItemRestored');
  }),
};
