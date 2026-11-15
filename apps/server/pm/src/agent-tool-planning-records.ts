import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError, type Actor, type Command, type CommandReceipt, type Entity } from '../../../../packages/domain/src/core.ts';
import { PlanningRecordsToolInputSchemas, PlanningRecordsToolMetadata, planningRecordsToolCommands, type PlanningRecordsToolName } from '../../../../packages/application/src/agent-tool-planning-records.ts';
import { assertAgentToolNotAborted, assertAgentToolProject, type AgentChatToolContext } from '../../../../packages/application/src/agent-chat-tools.ts';
import { getMembership, requireCapability } from '../../../../packages/application/src/access.ts';
import { listEntities, readEntity } from '../../../../packages/application/src/queries.ts';
import { readExternalReceipt } from '../../../../packages/application/src/core-bridge.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { roadmapDependencyClosure, taskInput } from '../../../../packages/application/src/product-roadmap.ts';
import { PlanningRecordsToolResultSchema, planningRecordsRecordSchema, type PlanningRecordsRecord, type PlanningRecordsToolResult } from '../../../../packages/agent-contracts/src/pm-tool-planning-records.ts';
import type { AgentChatToolReceipt } from '../../../../packages/agent-contracts/src/pm-tool-shared.ts';
import type { RoadmapAction, RoadmapRead } from '../../../../packages/contracts/src/product-roadmap.ts';
import { createProductRoadmapService, type ProductRoadmapMutationContext } from './product-roadmap-service.ts';
import { nativeCommandId, type CoreWorkspacePool } from './core-routes.ts';
import { coreVersion } from './core-adapter.ts';
import { WorkspaceError } from '../../../../packages/pm-core/index.ts';
import { CoreCommandJournal } from './core-journal.ts';
import type { AgentChatToolFamily, AgentToolRecoveryIdentity } from './agent-chat-tools.ts';

export type PlanningRecordsToolDependencies = {
  database: () => Pool;
  coreWorkspaces: CoreWorkspacePool;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
};
const names = Object.keys(PlanningRecordsToolInputSchemas) as PlanningRecordsToolName[];
const emptyResult = { nextCursor: null, truncated: false, sources: [] };
const nativeEntity = z.strictObject({ id: z.string(), workspaceId: z.string(), projectId: z.string().nullable(), kind: z.string(), version: z.number(), data: z.record(z.string(), z.unknown()), createdBy: z.string(), createdAt: z.string().nullable(), updatedAt: z.string().nullable() });
type NativeWrite = { projectId: string | null; targetId: string | null; expectedVersions: { id: string; version: number }[]; payload: Record<string, unknown> };

/** Project typed record data only: never leak storage paths, unknown payloads, or invented core entities. */
export function projectPlanningRecord(entity: Entity, messageOffset = 0, messageLimit = 20): PlanningRecordsRecord {
  const { id, workspaceId, projectId, version, createdBy, createdAt, updatedAt } = entity;
  const base = { id, workspaceId, projectId, version, createdBy, createdAt, updatedAt }, d = entity.data;
  switch (entity.kind) {
    case 'conversation': {
      if (!Array.isArray(d.messages)) throw new DomainError('planning_record_invalid', 'The authoritative conversation messages are invalid', 409);
      const messages = d.messages;
      const end = Math.min(messages.length, messageOffset + messageLimit);
      return planningRecordsRecordSchema.parse({ ...base, resource: 'conversation', title: d.title, messages: messages.slice(messageOffset, end), messageOffset, nextMessageOffset: end < messages.length ? end : null, totalMessages: messages.length });
    }
    case 'intent': return planningRecordsRecordSchema.parse({ ...base, resource: 'intent', summary: d.summary, goal: d.goal, conversationId: d.conversationId, sourceMessageRefs: d.sourceMessageRefs, revision: d.revision, status: d.status, acceptedDecisionId: d.acceptedDecisionId, terminalDecisionId: d.terminalDecisionId ?? null, withdrawalRecord: d.withdrawalRecord ?? null });
    case 'decision': return planningRecordsRecordSchema.parse({ ...base, resource: 'decision', subjectRef: d.subjectRef, decisionType: d.decisionType, actorId: d.actorId, reason: d.reason, basisRefs: d.basisRefs, supersedesDecisionId: d.supersedesDecisionId, acceptedRevision: d.acceptedRevision ?? null, rejectedRevision: d.rejectedRevision ?? null });
    case 'evidence': return planningRecordsRecordSchema.parse({ ...base, resource: 'evidence', subjectRefs: d.subjectRefs, method: d.method, scope: d.scope, result: d.result, observedAt: d.observedAt, artifactVersionRefs: d.artifactVersionRefs, sourceRunId: d.sourceRunId, producerId: d.producerId });
    case 'submission': {
      const snapshot = d.workScopeSnapshot;
      if (!snapshot || typeof snapshot.title !== 'string' || typeof snapshot.description !== 'string' || !Array.isArray(snapshot.acceptanceCriteria)) throw new DomainError('planning_record_invalid', 'The authoritative submission snapshot is invalid', 409);
      const snapshotTruncated = snapshot.title.length > 300 || snapshot.description.length > 64000 || snapshot.acceptanceCriteria.length > 100 || snapshot.acceptanceCriteria.some((item: { text: string }) => typeof item.text === 'string' && item.text.length > 16000);
      const workScopeSnapshot = { ...snapshot, title: snapshot.title.slice(0, 300), description: snapshot.description.slice(0, 64000), acceptanceCriteria: snapshot.acceptanceCriteria.slice(0, 100).map((item: { id: string; text: string }) => ({ id: item.id, text: item.text.slice(0, 16000) })) };
      return planningRecordsRecordSchema.parse({ ...base, resource: 'submission', workItemId: d.workItemId, contentRevision: d.contentRevision, snapshotTruncated, workScopeSnapshot, artifactVersionIds: d.artifactVersionIds, evidenceIds: d.evidenceIds, submittedBy: d.submittedBy, submittedAt: d.submittedAt });
    }
    case 'review': return planningRecordsRecordSchema.parse({ ...base, resource: 'review', submissionId: d.submissionId, workItemId: d.workItemId, contentRevision: d.contentRevision, criterionResults: d.criterionResults, verdict: d.verdict, reason: d.reason, reviewerId: d.reviewerId, reviewedAt: d.reviewedAt });
    default: throw new DomainError('planning_record_kind_mismatch', 'This is not a PM planning or independent delivery record', 409);
  }
}
function assertScope(context: AgentChatToolContext, projectId: string | null): void {
  if (projectId === null) {
    if (context.scope.kind !== 'workspace') throw new DomainError('not_found_or_forbidden', 'Workspace-level records require explicit workspace scope', 404);
  } else assertAgentToolProject(context.scope, projectId);
}
function asCommand(name: PlanningRecordsToolName, input: unknown, context: AgentChatToolContext): Command | null {
  if (!Object.hasOwn(planningRecordsToolCommands, name)) return null;
  const commandType = planningRecordsToolCommands[name as keyof typeof planningRecordsToolCommands];
  const args = PlanningRecordsToolInputSchemas[name].parse(input) as NativeWrite;
  return { commandId: context.operationId, commandType, ...(args.projectId === null ? {} : { projectId: args.projectId }), ...(args.targetId === null ? {} : { targetId: args.targetId }), expectedVersions: Object.fromEntries(args.expectedVersions.map(item => [item.id, item.version])), payload: args.payload };
}
function roadmapInput(name: PlanningRecordsToolName, input: unknown, context: AgentChatToolContext): RoadmapAction | null {
  if (name === 'pm_save_roadmap') { const { projectId: _projectId, ...args } = PlanningRecordsToolInputSchemas.pm_save_roadmap.parse(input); return { ...args, action: 'save', commandId: context.operationId }; }
  if (name === 'pm_publish_roadmap') { const { projectId: _projectId, ...args } = PlanningRecordsToolInputSchemas.pm_publish_roadmap.parse(input); return { ...args, action: 'publish', commandId: context.operationId }; }
  return null;
}
function receipt(context: AgentChatToolContext, command: Command, targetId: string | null): AgentChatToolReceipt {
  return { kind: 'command', operationId: context.operationId, commandId: command.commandId, action: command.commandType, targetId, revision: null, ...(context.linkage ? { linkage: context.linkage } : {}) };
}
function recordTruncated(record: PlanningRecordsRecord): boolean {
  return record.resource === 'conversation' && record.nextMessageOffset !== null || record.resource === 'submission' && record.snapshotTruncated;
}
function roadmapProjection(value: RoadmapRead): { roadmap: RoadmapRead; truncated: boolean } {
  const truncated = value.title.length > 300 || Object.values(value.tasks).some(rows => rows.some(row => row.title.length > 300));
  if (!truncated) return { roadmap: value, truncated: false };
  return { roadmap: { ...value, title: value.title.slice(0, 300), tasks: Object.fromEntries(Object.entries(value.tasks).map(([id, rows]) => [id, rows.map(row => row.title.length > 300 ? { ...row, title: row.title.slice(0, 300) } : row)])) }, truncated: true };
}
function roadmapResult(roadmap: RoadmapRead, nativeReceipt?: AgentChatToolReceipt): PlanningRecordsToolResult {
  return PlanningRecordsToolResultSchema.parse({ kind: 'planning_roadmap', selectedNodeIds: [], dependencyClosure: [], idMap: [], ...emptyResult, ...roadmapProjection(roadmap), ...(nativeReceipt ? { receipt: nativeReceipt } : {}) });
}

export function createPlanningRecordsToolFamily(options: PlanningRecordsToolDependencies): AgentChatToolFamily {
  const roadmap = createProductRoadmapService(options);
  async function authorize(name: PlanningRecordsToolName, context: AgentChatToolContext, projectId: string | null): Promise<void> {
    if (name === 'pm_list_planning_records' && projectId === null) {
      const member = await getMembership(options.database(), context.actor, context.workspaceId);
      if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
      return;
    }
    assertScope(context, projectId);
    for (const capability of PlanningRecordsToolMetadata[name].capabilities) await requireCapability(options.database(), context.actor, context.workspaceId, capability, projectId);
  }
  async function reference(context: AgentChatToolContext, id: string): Promise<void> {
    if (/^[A-Z]/.test(id)) {
      const workspace = await options.coreWorkspaces.get(context.workspaceId), record = workspace.get(id);
      const projectId = record.entity.entity === 'project' ? record.id : typeof record.entity.project === 'string' ? record.entity.project : null;
      assertScope(context, projectId);
      await requireCapability(options.database(), context.actor, context.workspaceId, 'domain.read', projectId);
    } else {
      const record = await readEntity(options.database(), context.actor, context.workspaceId, id);
      assertScope(context, record.projectId);
    }
  }
  async function commandAuthorization(name: PlanningRecordsToolName, command: Command, context: AgentChatToolContext): Promise<void> {
    await authorize(name, context, command.projectId ?? null);
    const refs = new Set<string>();
    if (command.targetId) refs.add(command.targetId);
    const p = command.payload;
    for (const field of ['subjectRefs', 'artifactVersionRefs', 'artifactVersionIds', 'evidenceIds']) if (Array.isArray(p[field])) for (const id of p[field]) if (typeof id === 'string') refs.add(id);
    for (const field of ['conversationId', 'supersedesDecisionId', 'intentId', 'decisionId', 'parentId', 'reviewId']) if (typeof p[field] === 'string') refs.add(p[field]);
    for (const value of [p.subjectRef, ...(Array.isArray(p.basisRefs) ? p.basisRefs : [])]) if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') refs.add(value.id);
    for (const id of refs) await reference(context, id);
  }
  async function commandResult(command: Command, original: CommandReceipt, context: AgentChatToolContext): Promise<PlanningRecordsToolResult> {
    if (original.status !== 'committed') throw new DomainError('agent_tool_recovered_rejection', 'The original business command was rejected', 409);
    const parsed = nativeEntity.safeParse(original.result);
    const candidates = parsed.success ? [parsed.data] : original.result && typeof original.result === 'object' ? Object.values(original.result).flatMap(value => { const item = nativeEntity.safeParse(value); return item.success ? [item.data] : []; }) : [];
    const records: PlanningRecordsRecord[] = [];
    let generatedTask: { id: string; projectId: string; title: string; titleTruncated: boolean; revision: string; version: number } | null = null;
    for (const value of candidates) {
      assertScope(context, value.projectId);
      if (value.kind === 'work_item') {
        if (command.commandType !== 'CreateWorkItemFromIntent') continue;
        // Original receipt proves creation. Current source is optional, never recreated or substituted.
        const workspace = await options.coreWorkspaces.get(context.workspaceId);
        try {
          const current = workspace.get(value.id); assertScope(context, typeof current.entity.project === 'string' ? current.entity.project : null);
          generatedTask = { id: current.id, projectId: String(current.entity.project), title: current.entity.title.slice(0, 300), titleTruncated: current.entity.title.length > 300, revision: current.revision, version: coreVersion(current.revision) };
        } catch (error) { if (!(error instanceof WorkspaceError) || error.status !== 404) throw error; }
      } else {
        // Re-read authorization and present current data, not stale historical/private content from the receipt.
        const current = await readEntity(options.database(), context.actor, context.workspaceId, value.id);
        assertScope(context, current.projectId); records.push(projectPlanningRecord(current));
      }
    }
    return PlanningRecordsToolResultSchema.parse({ kind: 'planning_record_receipt', records, generatedTask, ...emptyResult, receipt: receipt(context, command, candidates[0]?.id ?? command.targetId ?? null), truncated: records.some(recordTruncated) || generatedTask?.titleTruncated === true });
  }
  async function roadmapReceipt(context: AgentChatToolContext, projectId: string, action: RoadmapAction): Promise<AgentChatToolReceipt | undefined> {
    const workspace = await options.coreWorkspaces.get(context.workspaceId);
    const actionName = action.action === 'materialize' ? 'MaterializeRoadmapTask' : 'UpdateProductRoadmap';
    const targetId = action.action === 'materialize' ? undefined : projectId;
    const key = action.action === 'materialize' ? `${action.releaseId}:${action.nodeId}` : action.commandId;
    let payload: Record<string, unknown> = action;
    if (action.action === 'materialize') {
      const current = await roadmap.read(context.actor, context.workspaceId, projectId), release = current.store.releases.find(item => item.id === action.releaseId);
      if (!release) return undefined;
      payload = taskInput(projectId, release, action.nodeId, (current.tasks[release.id] ?? []).map(row => ({ ...row, drifted: false, archived: false })));
    }
    const commandId = nativeCommandId(context.workspaceId, context.actor.id, actionName, targetId, key);
    const original = new CoreCommandJournal(workspace.root).httpOutcome(commandId, context.actor.id);
    if (!original || original.kind !== 'http_completed' || original.hash !== requestHash({ action: actionName, targetId, input: payload })) return undefined;
    return { kind: 'core', operationId: context.operationId, commandId, action: actionName, targetId: original.targetId, revision: original.revision, ...(context.linkage ? { linkage: context.linkage } : {}) };
  }
  function caller(context: AgentChatToolContext, projectId: string): ProductRoadmapMutationContext {
    return { actor: context.actor, workspaceId: context.workspaceId, projectId, checkAuthorization: async sql => { assertAgentToolNotAborted(context); await context.checkAuthorization?.(sql); } };
  }
  async function execute(rawName: string, input: unknown, context: AgentChatToolContext): Promise<PlanningRecordsToolResult> {
    const name = rawName as PlanningRecordsToolName;
    assertAgentToolNotAborted(context);
    const command = asCommand(name, input, context);
    if (command) {
      await commandAuthorization(name, command, context);
      const result = await options.executeCommand(context.actor, context.workspaceId, command, async sql => { assertAgentToolNotAborted(context); await context.checkAuthorization?.(sql); });
      if (result.status !== 'committed') throw new DomainError(result.error?.code ?? 'planning_record_rejected', 'The native business command was rejected', result.httpStatus);
      return commandResult(command, result, context);
    }
    if (name === 'pm_list_planning_records') {
      const args = PlanningRecordsToolInputSchemas.pm_list_planning_records.parse(input);
      await authorize(name, context, args.projectId);
      const page = await listEntities(options.database(), context.actor, context.workspaceId, { kind: args.resource, ...(args.projectId === null ? {} : { projectId: args.projectId }), limit: args.limit, ...(args.after === null ? {} : { after: args.after }) }, { projectIds: context.scope.projectIds, includeWorkspace: context.scope.kind === 'workspace' });
      const records = page.items.map(row => projectPlanningRecord(row));
      return PlanningRecordsToolResultSchema.parse({ kind: 'planning_records', records, cursor: page.cursor, ...emptyResult, nextCursor: page.nextCursor, truncated: page.nextCursor !== null || records.some(recordTruncated) });
    }
    if (name === 'pm_read_planning_record') {
      const args = PlanningRecordsToolInputSchemas.pm_read_planning_record.parse(input), row = await readEntity(options.database(), context.actor, context.workspaceId, args.id);
      if (row.kind !== args.resource) throw new DomainError('not_found_or_forbidden', 'Record does not match the requested business resource', 404);
      await authorize(name, context, row.projectId);
      const record = projectPlanningRecord(row, args.messageOffset, args.messageLimit);
      return PlanningRecordsToolResultSchema.parse({ kind: 'planning_records', records: [record], cursor: null, ...emptyResult, truncated: recordTruncated(record) });
    }
    if (name === 'pm_read_roadmap') {
      const args = PlanningRecordsToolInputSchemas.pm_read_roadmap.parse(input); await authorize(name, context, args.projectId);
      return roadmapResult(await roadmap.read(context.actor, context.workspaceId, args.projectId));
    }
    if (name === 'pm_materialize_roadmap') {
      const args = PlanningRecordsToolInputSchemas.pm_materialize_roadmap.parse(input); await authorize(name, context, args.projectId);
      const result = await roadmap.materialize(caller(context, args.projectId), args.releaseId, args.nodeIds);
      const nativeReceipt = await roadmapReceipt(context, args.projectId, { action: 'materialize', releaseId: args.releaseId, nodeId: result.dependencyClosure.at(-1)!, confirm: true });
      return PlanningRecordsToolResultSchema.parse({ kind: 'planning_roadmap', ...result, ...emptyResult, ...roadmapProjection(result.roadmap), ...(nativeReceipt ? { receipt: nativeReceipt } : {}) });
    }
    const action = roadmapInput(name, input, context);
    if (action) {
      const { projectId } = PlanningRecordsToolInputSchemas[name].parse(input) as { projectId: string };
      await authorize(name, context, projectId);
      const result = await roadmap.act(caller(context, projectId), action);
      return roadmapResult(result, await roadmapReceipt(context, projectId, action));
    }
    throw new DomainError('agent_tool_not_available', 'Unregistered planning-records operation', 403);
  }
  async function recover(rawName: string, input: unknown, context: AgentChatToolContext): Promise<PlanningRecordsToolResult | null> {
    const name = rawName as PlanningRecordsToolName, command = asCommand(name, input, context);
    if (command) {
      await commandAuthorization(name, command, context);
      const original = await readExternalReceipt(options.database(), context.actor, context.workspaceId, command.commandId, requestHash(command as unknown as Record<string, unknown>));
      return original ? commandResult(command, original, context) : null;
    }
    if (name === 'pm_materialize_roadmap') {
      const args = PlanningRecordsToolInputSchemas.pm_materialize_roadmap.parse(input); await authorize(name, context, args.projectId);
      const current = await roadmap.read(context.actor, context.workspaceId, args.projectId), release = current.store.releases.find(r => r.id === args.releaseId);
      if (!release) return null;
      const closure = roadmapDependencyClosure(release, args.nodeIds);
      let confirmed: RoadmapRead | null = null;
      for (const nodeId of closure) { confirmed = await roadmap.recover(caller(context, args.projectId), { action: 'materialize', releaseId: args.releaseId, nodeId, confirm: true }); if (!confirmed) return null; }
      const idMap = closure.map(nodeId => { const rows = (confirmed!.tasks[args.releaseId] ?? []).filter(row => row.nodeId === nodeId); return rows.length === 1 ? { nodeId, taskId: rows[0]!.taskId, revision: rows[0]!.revision } : null; });
      if (idMap.some(row => row === null)) return null;
      const nativeReceipt = await roadmapReceipt(context, args.projectId, { action: 'materialize', releaseId: args.releaseId, nodeId: closure.at(-1)!, confirm: true });
      return PlanningRecordsToolResultSchema.parse({ kind: 'planning_roadmap', selectedNodeIds: args.nodeIds, dependencyClosure: closure, idMap, ...emptyResult, ...roadmapProjection(confirmed!), ...(nativeReceipt ? { receipt: nativeReceipt } : {}) });
    }
    const action = roadmapInput(name, input, context);
    if (action) { const { projectId } = PlanningRecordsToolInputSchemas[name].parse(input) as { projectId: string }; await authorize(name, context, projectId); const original = await roadmap.recover(caller(context, projectId), action); return original ? roadmapResult(original, await roadmapReceipt(context, projectId, action)) : null; }
    return null;
  }
  function recoveryIdentity(rawName: string, input: unknown, context: AgentChatToolContext): AgentToolRecoveryIdentity | null {
    const name = rawName as PlanningRecordsToolName, command = asCommand(name, input, context);
    if (command) return { kind: 'command', commandId: command.commandId, action: command.commandType, hash: requestHash(command as unknown as Record<string, unknown>) };
    const action = roadmapInput(name, input, context);
    if (!action || action.action === 'materialize') return null;
    const { projectId } = PlanningRecordsToolInputSchemas[name].parse(input) as { projectId: string };
    return { kind: 'core', commandId: nativeCommandId(context.workspaceId, context.actor.id, 'UpdateProductRoadmap', projectId, action.commandId), action: 'UpdateProductRoadmap', hash: requestHash({ action: 'UpdateProductRoadmap', targetId: projectId, input: action }) };
  }
  async function authorizeResult(rawName: string, input: unknown, saved: unknown, context: AgentChatToolContext): Promise<void> {
    const name = rawName as PlanningRecordsToolName, result = PlanningRecordsToolResultSchema.parse(saved);
    const command = asCommand(name, input, context);
    if (command) await commandAuthorization(name, command, context);
    else if (name === 'pm_list_planning_records') {
      const args = PlanningRecordsToolInputSchemas.pm_list_planning_records.parse(input);
      await authorize(name, context, args.projectId);
      if (result.kind === 'planning_records' && result.nextCursor !== null) {
        // A saved empty/legacy page is not authority to disclose an out-of-scope cursor anchor.
        await listEntities(options.database(), context.actor, context.workspaceId, { kind: args.resource, ...(args.projectId === null ? {} : { projectId: args.projectId }), limit: 1, after: result.nextCursor }, { projectIds: context.scope.projectIds, includeWorkspace: context.scope.kind === 'workspace' });
      }
    }
    if (result.kind === 'planning_roadmap') {
      await authorize(name, context, result.roadmap.projectId);
      await roadmap.read(context.actor, context.workspaceId, result.roadmap.projectId);
      for (const rows of Object.values(result.roadmap.tasks)) for (const row of rows) await reference(context, row.taskId);
      return;
    }
    for (const record of result.records) {
      const current = await readEntity(options.database(), context.actor, context.workspaceId, record.id);
      if (current.kind !== record.resource || current.workspaceId !== record.workspaceId || current.projectId !== record.projectId) throw new DomainError('not_found_or_forbidden', 'Stored business record is no longer readable in its original scope', 404);
      await authorize(name, context, current.projectId);
      const refs = record.resource === 'evidence' ? [...record.subjectRefs, ...record.artifactVersionRefs]
        : record.resource === 'submission' ? [record.workItemId, ...record.artifactVersionIds, ...record.evidenceIds]
        : record.resource === 'review' ? [record.workItemId, record.submissionId, ...record.criterionResults.flatMap(item => item.basisRefs)]
        : record.resource === 'decision' ? [record.subjectRef.id, ...record.basisRefs.map(item => item.id), ...(record.supersedesDecisionId ? [record.supersedesDecisionId] : [])]
        : record.resource === 'intent' ? [...(record.conversationId ? [record.conversationId] : []), ...(record.acceptedDecisionId ? [record.acceptedDecisionId] : [])] : [];
      for (const id of new Set(refs)) await reference(context, id);
    }
    if (result.kind === 'planning_record_receipt' && result.generatedTask) await reference(context, result.generatedTask.id);
  }
  return { names, execute, recover, recoveryIdentity, authorizeResult };
}
