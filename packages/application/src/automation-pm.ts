import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isPmAutomationTemplateId, pmAutomationCandidateSchema, pmAutomationReviewReceiptSchema, pmAutomationSnapshotSchema, validatePmAutomationResult, type PmAutomationAgentEvidence, type PmAutomationArguments, type PmAutomationCandidate, type PmAutomationCandidatePreview, type PmAutomationResult, type PmAutomationReviewReceipt, type PmAutomationReviewRequest, type PmAutomationReviewResult as ReviewResult, type PmAutomationSnapshot, type PmAutomationSourceRef } from '../../contracts/src/automation-pm.ts';
import type { AgentChatToolResult } from '../../agent-contracts/src/pm-tool-result.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { workflowFor, type FileRecord } from '../../pm-schema/index.ts';
import { validateRelations } from '../../pm-schema/relations.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { getMembership, requireCapability } from './access.ts';
import { automationSnapshot, authorizeAutomationProject } from './automation-report.ts';
import { studioAuthorize, type StudioExecutionRow } from './automation-studio-store.ts';
import type { AgentChatToolContext } from './agent-chat-tools.ts';
import { buildPmAutomationSnapshot, pmSourceHash } from './automation-pm-sources.ts';
import { withPmAutomationOrigin, pmAutomationTaskFromFile } from './automation-pm-signals.ts';
import type { SqlExecutor } from './ports.ts';
import { assertTaskCreationProject, requireTaskAssignee } from './core-task-creation.ts';

export type PmAutomationMutationPort = {
  execute(name: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult>;
  recover(name: string, input: unknown, context: AgentChatToolContext): Promise<AgentChatToolResult | null>;
};
type Options = { database: () => Pool; core: NotificationCorePort; mutations?: PmAutomationMutationPort };
type CandidateRow = { candidate: PmAutomationCandidate; revision: number; active_request_id: string | null };
type ReceiptRow = { request_id: string; execution_id: string; candidate_id: string; request_hash: string; operation: string; input: ReviewInput; result: unknown; http_status: number; settled: boolean };
type StepRow = { step_id: string; operation_id: string; tool: string; input: unknown; result: AgentChatToolResult | null; error: { code: string; message: string } | null };
type ReviewInput = PmAutomationReviewRequest & { candidate?: PmAutomationCandidate | undefined; selectedItemIds?: string[] | undefined; previewToken?: string | undefined };
const unknownResult = (error: unknown): boolean => !(error instanceof DomainError) || error.status >= 500 || /unknown|pending|recovered/.test(error.code) || ['permission_denied', 'not_found_or_forbidden'].includes(error.code);

export async function validatePmAutomationScope(sql: SqlExecutor, core: NotificationCorePort, actor: Actor, workspaceId: string, projectId: string, args: PmAutomationArguments): Promise<void> {
  const snapshot = await automationSnapshot(core, workspaceId);
  await authorizeAutomationProject(sql, actor, workspaceId, projectId, snapshot);
  const tasks = snapshot.files.filter(file => file.entity.entity === 'work_item' && file.entity.project === projectId);
  if (args.taskIds?.some(id => !tasks.some(task => task.id === id)) || args.milestoneId && !snapshot.files.some(file => file.id === args.milestoneId && file.entity.entity === 'milestone' && file.entity.project === projectId)) throw new DomainError('automation_pm_scope_forbidden', 'Selected tasks or milestone are outside this project', 404);
  const workflow = workflowFor('work_item', snapshot.configuration!);
  if (!workflow || args.statusIds?.some(id => !workflow.states.some(state => state.id === id))) throw new DomainError('automation_pm_scope_invalid', 'Selected task statuses are not configured', 400);
  for (const id of args.assigneeIds ?? []) {
    const member = (await sql.query<{ project_ids: string[] | null }>('SELECT m.project_ids FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id::text=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL', [workspaceId, id])).rows[0];
    if (!member || member.project_ids !== null && !member.project_ids.includes(projectId)) throw new DomainError('automation_pm_scope_invalid', 'Selected assignee is not an active member of this project', 400);
  }
}

/** The PM result store never executes model text: only these typed user-reviewed candidates reach existing PM mutation services. */
export function createPmAutomationService(options: Options) {
  async function scoped<T>(actor: Actor, workspaceId: string, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await options.database().connect();
    try { await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); const member = await getMembership(sql, actor, workspaceId); if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403); const result = await operation(sql); await sql.query('COMMIT'); return result; }
    catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  async function executionRow(sql: SqlExecutor, actor: Actor, workspaceId: string, id: string, active = false): Promise<StudioExecutionRow> {
    const row = (await sql.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE workspace_id=$1 AND actor_id=$2 AND id=$3', [workspaceId, actor.id, id])).rows[0];
    if (!row || row.config_snapshot.action.kind !== 'template' || !isPmAutomationTemplateId(row.config_snapshot.action.templateId)) throw new DomainError('not_found_or_forbidden', 'PM automation execution is not accessible', 404);
    await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id, active);
    if (active && (!row.dispatched_at || row.finished_at || row.status === 'cancel_requested')) throw new DomainError('automation_execution_not_authorized', 'Only the original active execution can publish analysis', 403);
    return row;
  }
  async function snapshotRow(sql: SqlExecutor, executionId: string): Promise<PmAutomationSnapshot> {
    const saved = (await sql.query<{ snapshot: PmAutomationSnapshot }>('SELECT snapshot FROM automation_pm_snapshots WHERE execution_id=$1', [executionId])).rows[0];
    if (!saved) throw new DomainError('automation_pm_snapshot_missing', 'This run has not frozen its authorized sources', 404);
    // Match the Agent's contract-normalized structured quotes after JSONB key reordering.
    return pmAutomationSnapshotSchema.parse(saved.snapshot);
  }
  async function candidateRow(sql: SqlExecutor, executionId: string, candidateId: string): Promise<CandidateRow> {
    const row = (await sql.query<CandidateRow>('SELECT * FROM automation_pm_candidates WHERE execution_id=$1 AND id=$2 FOR UPDATE', [executionId, candidateId])).rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', 'Candidate is not accessible', 404);
    return row;
  }
  async function saveCandidate(sql: SqlExecutor, executionId: string, actor: Actor, requestId: string, candidate: PmAutomationCandidate, activeRequest: string | null = null): Promise<void> {
    await sql.query('UPDATE automation_pm_candidates SET candidate=$3::jsonb,revision=$4,active_request_id=$5,updated_at=clock_timestamp() WHERE execution_id=$1 AND id=$2', [executionId, candidate.id, JSON.stringify(candidate), candidate.revision, activeRequest]);
    await sql.query('INSERT INTO automation_pm_candidate_history(execution_id,candidate_id,revision,actor_id,request_id,candidate) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [executionId, candidate.id, candidate.revision, actor.id, requestId, JSON.stringify(candidate)]);
  }
  function referencedIds(candidate: PmAutomationCandidate): string[] {
    if (candidate.kind === 'task-update' || candidate.kind === 'task-comment' || candidate.kind === 'task-status') return [candidate.taskId];
    if (candidate.kind === 'task-relation') return [candidate.taskId, ...candidate.before, ...candidate.after];
    if (candidate.kind === 'create-document') return candidate.document.taskIds;
    const drafts = candidate.kind === 'plan' ? candidate.plan.tasks : [candidate.task];
    return drafts.flatMap(task => [...task.dependsOn, ...task.relatedTaskIds, ...(task.milestoneId ? [task.milestoneId] : []), ...('existingTaskId' in task && typeof task.existingTaskId === 'string' ? [task.existingTaskId] : [])]);
  }
  function trustedCandidate(candidate: PmAutomationCandidate, snapshot: PmAutomationSnapshot): PmAutomationCandidate {
    const sources = new Map(snapshot.sources.map(source => [source.refId, source]));
    if (candidate.sourceRefs.some(source => pmSourceHash(sources.get(source.refId)) !== pmSourceHash(source)) || candidate.evidence.some(item => !sources.has(item.sourceRefId))) throw new DomainError('automation_pm_untrusted_source', 'Candidate references evidence not frozen by this execution', 400);
    const refs = new Map(candidate.sourceRefs.map(source => [source.refId, source]));
    for (const id of [snapshot.project.id, ...referencedIds(candidate)]) {
      const source = snapshot.sources.find(source => source.id === id && ['project', 'task', 'milestone'].includes(source.kind) && source.refId !== snapshot.before?.sourceRefId);
      if (!source) throw new DomainError('automation_pm_scope_forbidden', 'Candidate references an object outside the authorized source selection', 403);
      refs.set(source.refId, source);
    }
    const workflow = snapshot.sources.find(source => source.kind === 'workflow'); if (workflow) refs.set(workflow.refId, workflow);
    if (candidate.kind === 'plan' || candidate.kind === 'task-status') {
      for (const id of referencedIds(candidate).flatMap(id => snapshot.tasks.find(task => task.id === id)?.dependsOn ?? [])) {
        const source = snapshot.sources.find(source => source.kind === 'task' && source.id === id && source.refId !== snapshot.before?.sourceRefId);
        if (!source) throw new DomainError('automation_pm_scope_forbidden', 'A proposal prerequisite was not observed inside the explicit selection', 403);
        refs.set(source.refId, source);
      }
    }
    if (snapshot.templateId === 'pm-goal-drift' || snapshot.templateId === 'pm-next-actions') for (const goal of snapshot.project.goals) {
      const source = snapshot.sources.find(source => source.refId === goal.sourceRefId);
      if (source) refs.set(source.refId, source);
    }
    if ('taskId' in candidate && snapshot.tasks.find(task => task.id === candidate.taskId)?.revision !== candidate.expectedRevision) throw new DomainError('automation_pm_untrusted_revision', 'Candidate expected revision must be the frozen task revision', 400);
    if (candidate.kind === 'plan') {
      const ids = new Set(candidate.plan.tasks.map(task => task.localId));
      if (ids.size !== candidate.plan.tasks.length || candidate.plan.tasks.some(task => task.dependsOnLocalIds.some(id => !ids.has(id) || id === task.localId))) throw new DomainError('automation_pm_plan_invalid', 'Plan local identities/dependencies are invalid', 400);
    }
    return pmAutomationCandidateSchema.parse({ ...candidate, sourceRefs: [...refs.values()], status: 'pending', revision: 1 });
  }
  async function currentSources(sql: SqlExecutor, actor: Actor, execution: StudioExecutionRow, snapshot: PmAutomationSnapshot, candidate: PmAutomationCandidate): Promise<{ sources: PmAutomationSourceRef[]; conflicts: string[] }> {
    const current = await automationSnapshot(options.core, execution.workspace_id);
    await authorizeAutomationProject(sql, actor, execution.workspace_id, execution.project_id, current);
    const conflicts: string[] = [], sources: PmAutomationSourceRef[] = [];
    for (const source of candidate.reviewSources ?? candidate.sourceRefs) {
      if (source.actorId !== actor.id || source.workspaceId !== execution.workspace_id || source.projectId !== execution.project_id) throw new DomainError('automation_pm_scope_forbidden', 'Candidate source identity is outside the execution', 403);
      if (source.refId === snapshot.before?.sourceRefId && source.revision !== snapshot.after?.task.revision) { sources.push(source); continue; }
      let revision: string | undefined;
      if (['task', 'project', 'document', 'milestone', 'goal'].includes(source.kind)) {
        const file = current.files.find(file => file.id === source.id && (file.entity.entity === 'project' ? file.id : file.entity.project) === execution.project_id);
        revision = file?.revision;
      } else if (source.kind === 'workflow') revision = pmSourceHash(workflowFor('work_item', current.configuration!));
      else if (source.kind === 'comment') revision = (await sql.query<{ version: number }>('SELECT version FROM task_comments WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL', [execution.workspace_id, execution.project_id, source.id])).rows[0]?.version.toString();
      else if (source.kind === 'relationship') {
        const edge = snapshot.relationships.find(edge => edge.id === source.id);
        const from = edge ? current.files.find(file => file.id === edge.fromTaskId && file.entity.project === execution.project_id) : undefined;
        const to = edge ? current.files.find(file => file.id === edge.toTaskId && file.entity.project === execution.project_id) : undefined;
        const targets = edge?.kind === 'parent' ? [from?.entity.parent] : edge?.kind === 'depends-on' ? from?.entity.blocked_by : from?.entity.related_to;
        if (from && to && targets?.includes(to.id)) revision = pmSourceHash([from.revision, to.revision]);
      } else revision = snapshot.sources.find(original => pmSourceHash(original) === pmSourceHash(source))?.revision;
      if (!revision) { conflicts.push(`Source ${source.id} is no longer available in the original scope`); continue; }
      const actual = { ...source, revision, refId: source.refId.replace(source.revision, revision) }; sources.push(actual);
      if (revision !== source.revision) conflicts.push(`Source ${source.id} changed from ${source.revision} to ${revision}`);
    }
    return { sources, conflicts };
  }
  async function previewValue(sql: SqlExecutor, actor: Actor, execution: StudioExecutionRow, candidate: PmAutomationCandidate, input: ReviewInput): Promise<PmAutomationCandidatePreview> {
    const snapshot = await snapshotRow(sql, execution.id);
    const current = await currentSources(sql, actor, execution, snapshot, candidate);
    const core = await automationSnapshot(options.core, execution.workspace_id);
    const file = 'taskId' in candidate ? core.files.find(file => file.id === candidate.taskId && file.entity.project === execution.project_id) : undefined;
    const currentTask = file ? pmAutomationTaskFromFile(file, core.configuration) : null;
    const project = core.files.find(file => file.id === execution.project_id)!;
    try { assertTaskCreationProject(project, core.configuration!); } catch (error) { if (!(error instanceof DomainError)) throw error; current.conflicts.push(error.message); }
    if (candidate.kind === 'task-comment' && file?.entity.archived) current.conflicts.push('Archived tasks cannot receive comments');
    if ('taskId' in candidate && (!currentTask || currentTask.revision !== candidate.expectedRevision)) current.conflicts.push('Target task no longer matches the explicitly reviewed revision');
    if (candidate.kind === 'task-update' && currentTask) {
      for (const key of Object.keys(candidate.after) as (keyof typeof candidate.after)[]) if (JSON.stringify(candidate.before[key]) !== JSON.stringify(currentTask[key])) current.conflicts.push(`The current ${key} value differs from the before preview`);
    }
    if (candidate.kind === 'task-status' && currentTask && candidate.before !== currentTask.status) current.conflicts.push('Current task status differs from the before preview');
    if (candidate.kind === 'task-relation' && currentTask && JSON.stringify([...candidate.before].sort()) !== JSON.stringify([...(candidate.relation === 'related' ? currentTask.relatedTaskIds : currentTask.dependsOn)].sort())) current.conflicts.push('Current task relationships differ from the before preview');
    const selectedItemIds = candidate.kind === 'plan' ? input.selectedItemIds ?? candidate.plan.tasks.map(task => task.localId) : [];
    if (candidate.kind !== 'plan' && input.selectedItemIds?.length) throw new DomainError('automation_pm_selection_invalid', 'Only plan candidates support selective publication', 400);
    if (candidate.kind === 'plan') {
      const selected = new Set(selectedItemIds), items = candidate.plan.tasks.filter(task => selected.has(task.localId));
      if (!items.length || items.length !== selected.size || items.some(task => task.dependsOnLocalIds.some(id => !selected.has(id)))) current.conflicts.push('Selected plan items must exist and include every local prerequisite; selection was not widened');
    }
    if (candidate.kind === 'task-relation' && file) {
      const entity = { ...file.entity, [candidate.relation === 'related' ? 'related_to' : 'blocked_by']: candidate.after };
      if (validateRelations(core.files.map(record => record.id === file.id ? { ...record, entity } : record), core.configuration!).some(issue => issue.severity === 'error')) current.conflicts.push('Proposed relationships do not satisfy the current native relation graph');
    }
    if (candidate.kind === 'task-update' && candidate.after.assigneeIds?.[0]) await requireTaskAssignee(sql, execution.workspace_id, execution.project_id, candidate.after.assigneeIds[0]);
    const drafts = candidate.kind === 'create-task' ? [candidate.task] : candidate.kind === 'plan' ? candidate.plan.tasks.filter(task => selectedItemIds.includes(task.localId) && !task.existingTaskId) : [];
    if (drafts.some(task => [task.description, task.acceptanceCriteria.map(text => `- [ ] ${text.replace(/\r?\n/g, ' ')}`).join('\n')].filter(Boolean).join('\n\n').length > 24000)) current.conflicts.push('Task Markdown plus acceptance checklist exceeds the native 24000-character write boundary');
    if (candidate.kind === 'plan' && candidate.plan.description.length + candidate.plan.tasks.filter(task => selectedItemIds.includes(task.localId)).reduce((size, task) => size + task.title.length + 100, 30) > 24000) current.conflicts.push('Reviewed plan document exceeds the native Markdown write boundary');
    if (candidate.revision !== input.expectedRevision) current.conflicts.push('Candidate revision changed; reload and explicitly decide again');
    if (!['pending', 'conflict'].includes(candidate.status)) current.conflicts.push('Candidate has already been decided or its original application is unresolved');
    if (!options.mutations) current.conflicts.push('Native PM mutation service is unavailable');
    await requireCapability(sql, actor, execution.workspace_id, candidate.kind === 'task-comment' ? 'intent.propose' : 'planning.edit', execution.project_id);
    if (candidate.kind === 'task-status') {
      const configured = workflowFor('work_item', core.configuration!);
      const status = configured?.states.find(status => status.id === candidate.after);
      if (!status || status.category === 'completed' || status.category === 'canceled') current.conflicts.push('Automation status suggestions may not complete or cancel tasks');
      if (!configured?.transitions.some(transition => transition.from === candidate.before && transition.to === candidate.after)) current.conflicts.push('The configured workflow does not permit this transition');
    }
    const canApply = current.conflicts.length === 0;
    return { candidate, currentTask, currentSources: current.sources, conflicts: current.conflicts, canApply, selectedItemIds, previewToken: canApply ? pmSourceHash({ executionId: execution.id, candidate, sources: current.sources, selectedItemIds }) : null };
  }
  async function receiptRow(sql: SqlExecutor, actor: Actor, workspaceId: string, requestId: string): Promise<ReceiptRow | undefined> {
    const row = (await sql.query<ReceiptRow>('SELECT * FROM automation_pm_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
    if (row) await executionRow(sql, actor, workspaceId, row.execution_id);
    return row;
  }
  async function settle(sql: SqlExecutor, actor: Actor, workspaceId: string, requestId: string, result: unknown, httpStatus = 200, settled = true): Promise<void> {
    await sql.query('UPDATE automation_pm_receipts SET result=$4::jsonb,http_status=$5,settled=$6 WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND NOT settled', [workspaceId, actor.id, requestId, JSON.stringify(result), httpStatus, settled]);
  }
  async function review(actor: Actor, workspaceId: string, executionId: string, candidateId: string, operation: 'edit' | 'preview' | 'apply' | 'ignore', input: ReviewInput): Promise<unknown> {
    const saved = await scoped(actor, workspaceId, async sql => {
      const execution = await executionRow(sql, actor, workspaceId, executionId);
      const hash = pmSourceHash({ executionId, candidateId, operation, input });
      const prior = await receiptRow(sql, actor, workspaceId, input.requestId);
      if (prior) { if (prior.request_hash !== hash) throw new DomainError('idempotency_conflict', 'The original request ID represents another review decision', 409); return prior; }
      const row = await candidateRow(sql, executionId, candidateId);
      if (row.active_request_id) throw new DomainError('automation_pm_outcome_unknown', 'Reconcile the original application request before any new decision', 409);
      const initial: ReviewResult = { candidate: row.candidate, idMap: {}, status: 'outcome_unknown' };
      await sql.query('INSERT INTO automation_pm_receipts(workspace_id,actor_id,request_id,execution_id,candidate_id,request_hash,operation,input,http_status,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,202,$9::jsonb)', [workspaceId, actor.id, input.requestId, executionId, candidateId, hash, operation, JSON.stringify(input), JSON.stringify(initial)]);
      await sql.query('SAVEPOINT pm_review');
      try {
        if (row.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Candidate revision changed', 409);
        if (!['pending', 'conflict'].includes(row.candidate.status)) throw new DomainError('automation_pm_candidate_decided', 'Candidate is already decided', 409);
        if (operation === 'preview' || operation === 'apply') {
          const preview = await previewValue(sql, actor, execution, row.candidate, input);
          if (operation === 'preview') { await settle(sql, actor, workspaceId, input.requestId, preview); }
          else {
            if (!preview.canApply || !input.previewToken || preview.previewToken !== input.previewToken) throw new DomainError('version_conflict', preview.conflicts.join('; ') || 'Preview is stale; review current sources again', 409);
            const intent = { ...row.candidate, status: 'outcome_unknown' as const, revision: row.revision + 1, application: { requestId: input.requestId, idMap: {} } };
            await saveCandidate(sql, executionId, actor, input.requestId, intent, input.requestId);
            await settle(sql, actor, workspaceId, input.requestId, { candidate: intent, idMap: {}, status: 'outcome_unknown' }, 202, false);
          }
        } else {
          const snapshot = await snapshotRow(sql, executionId);
          let candidate: PmAutomationCandidate;
          if (operation === 'ignore') candidate = { ...row.candidate, revision: row.revision + 1, status: 'ignored' };
          else {
            const proposed = pmAutomationCandidateSchema.parse(input.candidate);
            if (proposed.id !== candidateId || proposed.kind !== row.candidate.kind) throw new DomainError('automation_pm_candidate_identity', 'Edits cannot change candidate identity or application kind', 400);
            if ('taskId' in proposed && 'taskId' in row.candidate && proposed.taskId !== row.candidate.taskId) throw new DomainError('automation_pm_candidate_identity', 'Editing a finding cannot retarget another task', 400);
            if (pmSourceHash(proposed.sourceRefs) !== pmSourceHash(row.candidate.sourceRefs) || pmSourceHash(proposed.evidence) !== pmSourceHash(row.candidate.evidence) || pmSourceHash(proposed.application) !== pmSourceHash(row.candidate.application)) throw new DomainError('automation_pm_untrusted_source', 'Original analysis evidence and application receipts are immutable', 409);
            const actual = await currentSources(sql, actor, execution, snapshot, row.candidate);
            const bindings = proposed.reviewSources ?? row.candidate.reviewSources ?? row.candidate.sourceRefs;
            if (actual.sources.length !== (row.candidate.reviewSources ?? row.candidate.sourceRefs).length || bindings.length !== actual.sources.length || bindings.some(source => !actual.sources.some(current => pmSourceHash(current) === pmSourceHash(source)))) throw new DomainError('automation_pm_untrusted_source', 'Explicit review sources must retain every available original source at its current authorized revision', 409);
            const additional: PmAutomationSourceRef[] = [];
            for (const id of new Set(referencedIds(proposed))) {
              const source = snapshot.sources.find(source => source.id === id && ['task', 'milestone'].includes(source.kind) && source.refId !== snapshot.before?.sourceRefId);
              if (!source) throw new DomainError('automation_pm_scope_forbidden', 'Edited candidate widened its original source selection', 403);
              if (!bindings.some(binding => binding.id === id && binding.kind === source.kind)) additional.push(source);
            }
            const reviewed = additional.length ? await currentSources(sql, actor, execution, snapshot, { ...row.candidate, reviewSources: [...bindings, ...additional] }) : actual;
            if (reviewed.sources.length !== bindings.length + additional.length || reviewed.sources.length > 100) throw new DomainError('automation_pm_scope_forbidden', 'A newly selected reference is unavailable or exceeds the bounded source selection', 409);
            if ('taskId' in proposed && !reviewed.sources.some(source => source.id === proposed.taskId && source.revision === proposed.expectedRevision)) throw new DomainError('automation_pm_untrusted_revision', 'Edited task revision is not an authorized current review source', 409);
            candidate = { ...proposed, ...(proposed.reviewSources || additional.length ? { reviewSources: reviewed.sources } : {}), revision: row.revision + 1, status: 'pending' };
          }
          await saveCandidate(sql, executionId, actor, input.requestId, candidate);
          await settle(sql, actor, workspaceId, input.requestId, { candidate, idMap: {}, status: operation === 'ignore' ? 'ignored' : 'edited' });
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await sql.query('ROLLBACK TO SAVEPOINT pm_review');
        await settle(sql, actor, workspaceId, input.requestId, { ...initial, status: 'conflict' }, error.status);
      }
      await sql.query('RELEASE SAVEPOINT pm_review');
      return (await receiptRow(sql, actor, workspaceId, input.requestId))!;
    });
    if (!saved.settled && operation === 'apply') return reconcile(actor, workspaceId, input.requestId, true);
    if (saved.http_status >= 400) throw new DomainError('automation_pm_review_conflict', 'The original review request conflicted; read its receipt and preview current sources before deciding again', saved.http_status);
    return saved.result;
  }

  async function reconcile(actor: Actor, workspaceId: string, requestId: string, allowNewSteps = false): Promise<ReviewResult> {
    const state = await scoped(actor, workspaceId, async sql => {
      const receipt = await receiptRow(sql, actor, workspaceId, requestId);
      if (!receipt) throw new DomainError('not_found_or_forbidden', 'Original review receipt is not accessible', 404);
      if (receipt.settled) return { receipt, execution: await executionRow(sql, actor, workspaceId, receipt.execution_id), candidate: (await candidateRow(sql, receipt.execution_id, receipt.candidate_id)).candidate };
      const execution = await executionRow(sql, actor, workspaceId, receipt.execution_id);
      const candidate = (await candidateRow(sql, receipt.execution_id, receipt.candidate_id)).candidate;
      return { receipt, execution, candidate };
    });
    if (state.receipt.settled) return state.receipt.result as ReviewResult;
    if (!options.mutations) throw new DomainError('automation_pm_mutation_unavailable', 'Native PM mutations are unavailable', 503);
    const { receipt, execution, candidate } = state;
    const idMap: Record<string, string> = { ...candidate.application?.idMap };
    const ownRevisions = new Map<string, string>();
    let attemptedMutation = false;
    const guarded = async (sql: SqlExecutor): Promise<void> => {
      await requireCapability(sql, actor, workspaceId, 'domain.read', execution.project_id);
      const current = await automationSnapshot(options.core, workspaceId);
      await authorizeAutomationProject(sql, actor, workspaceId, execution.project_id, current);
      if (candidate.kind === 'task-status') {
        const target = workflowFor('work_item', current.configuration!)?.states.find(state => state.id === candidate.after);
        if (!target || target.category === 'completed' || target.category === 'canceled') throw new DomainError('automation_pm_terminal_status_forbidden', 'Automation candidates cannot complete or cancel a task', 403);
      }
      const frozen = await snapshotRow(sql, execution.id);
      const check = await currentSources(sql, actor, execution, frozen, candidate);
      const ownedEdges = frozen.relationships.filter(edge => {
        if (!ownRevisions.has(edge.fromTaskId) && !ownRevisions.has(edge.toTaskId)) return false;
        return [edge.fromTaskId, edge.toTaskId].every(id => {
          const expected = ownRevisions.get(id) ?? (candidate.reviewSources ?? candidate.sourceRefs).find(source => source.kind === 'task' && source.id === id)?.revision ?? frozen.tasks.find(task => task.id === id)?.revision;
          return expected !== undefined && current.files.find(file => file.id === id)?.revision === expected;
        });
      });
      const unexpected = check.conflicts.filter(message => ![...ownRevisions].some(([id, revision]) => message.startsWith(`Source ${id} changed`) && current.files.find(file => file.id === id)?.revision === revision) && !ownedEdges.some(edge => message.startsWith(`Source ${edge.id} `)));
      if (unexpected.length) throw new DomainError('version_conflict', unexpected.join('; '), 409);
    };
    const step = async (stepId: string, tool: string, input: unknown): Promise<AgentChatToolResult> => {
      const prepared = await scoped(actor, workspaceId, async sql => {
        await executionRow(sql, actor, workspaceId, execution.id);
        const prior = (await sql.query<StepRow>('SELECT * FROM automation_pm_apply_steps WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND step_id=$4', [workspaceId, actor.id, requestId, stepId])).rows[0];
        if (prior) return { row: prior, fresh: false };
        if (!allowNewSteps) throw new DomainError('automation_pm_outcome_unknown', 'Only an explicit continuation of the original approved request may start its remaining native steps', 503);
        await guarded(sql);
        const row = (await sql.query<StepRow>('INSERT INTO automation_pm_apply_steps(workspace_id,actor_id,request_id,step_id,operation_id,tool,input) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *', [workspaceId, actor.id, requestId, stepId, randomUUID(), tool, JSON.stringify(input)])).rows[0]!;
        return { row, fresh: true };
      });
      if (prepared.row.error) throw new DomainError(prepared.row.error.code, prepared.row.error.message, 409);
      attemptedMutation = true;
      const context: AgentChatToolContext = { actor, workspaceId, threadId: `pm-automation-review:${execution.id}`, messageId: candidate.id, operationId: prepared.row.operation_id, scope: { kind: 'projects', projectIds: [execution.project_id] }, checkAuthorization: guarded };
      let result = prepared.row.result;
      if (!result) {
        try {
          result = await withPmAutomationOrigin(execution.id, () => prepared.fresh ? options.mutations!.execute(prepared.row.tool, prepared.row.input, context) : options.mutations!.recover(prepared.row.tool, prepared.row.input, context));
          if (!result?.receipt) throw new DomainError('automation_pm_outcome_unknown', 'Original native mutation receipt is not yet known; it was not reissued', 503);
          await scoped(actor, workspaceId, async sql => { await sql.query('UPDATE automation_pm_apply_steps SET result=$5::jsonb WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND step_id=$4 AND result IS NULL AND error IS NULL', [workspaceId, actor.id, requestId, stepId, JSON.stringify(result)]); });
        } catch (error) {
          if (!unknownResult(error)) await scoped(actor, workspaceId, async sql => { await sql.query('UPDATE automation_pm_apply_steps SET error=$5::jsonb WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND step_id=$4 AND result IS NULL AND error IS NULL', [workspaceId, actor.id, requestId, stepId, JSON.stringify({ code: error instanceof DomainError ? error.code : 'automation_pm_rejected', message: error instanceof Error ? error.message : 'Native mutation rejected' })]); });
          throw error;
        }
      }
      if (result.receipt?.targetId && result.receipt.revision) ownRevisions.set(result.receipt.targetId, result.receipt.revision);
      return result;
    };
    const currentFile = async (id: string): Promise<FileRecord> => {
      const source = await automationSnapshot(options.core, workspaceId), file = source.files.find(file => file.id === id && (file.entity.entity === 'project' ? file.id : file.entity.project) === execution.project_id);
      if (!file) throw new DomainError('not_found_or_forbidden', 'Application target is no longer in the original project', 404);
      return file;
    };
    const relate = async (stepId: string, sourceId: string, targetId: string, relation: string, remove = false): Promise<void> => {
      const source = await currentFile(sourceId), target = await currentFile(targetId);
      await step(stepId, remove ? 'pm_remove_relation' : 'pm_add_relation', { sourceId, targetId, relation, revision: source.revision, targetRevision: target.revision });
    };
    const publishTask = async (localId: string, draft: Extract<PmAutomationCandidate, { kind: 'create-task' }>['task']): Promise<string> => {
      const description = [draft.description, draft.acceptanceCriteria.map(text => `- [ ] ${text.replace(/\r?\n/g, ' ')}`).join('\n')].filter(Boolean).join('\n\n');
      const result = await step(`task:${localId}`, 'pm_create_task', { projectId: execution.project_id, title: draft.title, description, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: draft.labels });
      const id = result.receipt?.targetId;
      if (!id) throw new DomainError('automation_pm_outcome_unknown', 'Original task receipt does not identify its actual created task', 503);
      idMap[localId] = id;
      for (const target of draft.dependsOn) await relate(`task:${localId}:dependency:${target}`, id, target, 'blocked_by');
      for (const target of draft.relatedTaskIds) await relate(`task:${localId}:related:${target}`, id, target, 'related_to');
      if (draft.milestoneId) await relate(`task:${localId}:milestone`, id, draft.milestoneId, 'milestone');
      return id;
    };
    try {
      if (candidate.kind === 'task-comment') await step('comment', 'pm_create_comment', { projectId: execution.project_id, taskId: candidate.taskId, content: candidate.body });
      else if (candidate.kind === 'task-status') await step('status', 'pm_transition_task', { id: candidate.taskId, revision: candidate.expectedRevision, status: candidate.after });
      else if (candidate.kind === 'task-update') {
        const file = await currentFile(candidate.taskId);
        const after = candidate.after;
        if (after.title !== undefined || after.description !== undefined || after.acceptanceCriteria !== undefined || after.progressNote !== undefined) {
          await step('content', 'pm_update_task_content', { id: file.id, revision: file.revision, title: after.title ?? file.entity.title, description: after.description ?? null, acceptanceCriteria: after.acceptanceCriteria ?? null, progressNote: after.progressNote ?? null });
        }
        if (after.labels !== undefined || after.assigneeIds !== undefined) await step('fields', 'pm_update_task', { id: candidate.taskId, revision: (await currentFile(candidate.taskId)).revision, title: null, description: null, assigneeId: after.assigneeIds === undefined ? null : after.assigneeIds[0] ?? '', priority: null, startDate: null, dueDate: null, labels: after.labels ?? null });
      } else if (candidate.kind === 'task-relation') {
        for (const target of candidate.before.filter(id => !candidate.after.includes(id))) await relate(`remove:${target}`, candidate.taskId, target, candidate.relation === 'related' ? 'related_to' : 'blocked_by', true);
        for (const target of candidate.after.filter(id => !candidate.before.includes(id))) await relate(`add:${target}`, candidate.taskId, target, candidate.relation === 'related' ? 'related_to' : 'blocked_by');
      } else if (candidate.kind === 'create-task') await publishTask(candidate.id, candidate.task);
      else if (candidate.kind === 'create-document') {
        const result = await step('document', 'pm_create_document', { projectId: execution.project_id, title: candidate.document.title, body: candidate.document.body });
        const id = result.receipt?.targetId;
        if (!id) throw new DomainError('automation_pm_outcome_unknown', 'Document original receipt has no actual ID', 503);
        idMap[candidate.id] = id;
        for (const taskId of candidate.document.taskIds) await relate(`document:task:${taskId}`, id, taskId, 'related_to');
      } else {
        const selected = new Set(receipt.input.selectedItemIds ?? candidate.plan.tasks.map(task => task.localId));
        const items = candidate.plan.tasks.filter(task => selected.has(task.localId));
        for (const item of items) { if (item.existingTaskId) { await currentFile(item.existingTaskId); idMap[item.localId] = item.existingTaskId; } else await publishTask(item.localId, item); }
        for (const item of items) if (!item.existingTaskId) for (const dependency of item.dependsOnLocalIds) await relate(`plan:${item.localId}:dependency:${dependency}`, idMap[item.localId]!, idMap[dependency]!, 'blocked_by');
        const planBody = `${candidate.plan.description}\n\n## Reviewed plan\n\n${items.map(item => `- [[${idMap[item.localId]}]] — ${item.title}`).join('\n')}`;
        const document = await step('plan-document', 'pm_create_document', { projectId: execution.project_id, title: candidate.plan.title, body: planBody });
        const documentId = document.receipt?.targetId;
        if (!documentId) throw new DomainError('automation_pm_outcome_unknown', 'Original planning document receipt has no actual ID', 503);
        idMap[`plan-document:${candidate.id}`] = documentId;
        for (const item of items) await relate(`plan-document:${item.localId}`, documentId, idMap[item.localId]!, 'related_to');
      }
      return await scoped(actor, workspaceId, async sql => { const current = await candidateRow(sql, execution.id, candidate.id); if (current.active_request_id !== requestId) return (await receiptRow(sql, actor, workspaceId, requestId))!.result as ReviewResult; await guarded(sql); const applied = { ...candidate, status: 'applied' as const, revision: current.revision + 1, application: { requestId, idMap } }; await saveCandidate(sql, execution.id, actor, requestId, applied); const result: ReviewResult = { candidate: applied, idMap, status: 'applied' }; await settle(sql, actor, workspaceId, requestId, result); return result; });
    } catch (error) {
      const unknown = unknownResult(error);
      return scoped(actor, workspaceId, async sql => {
        const current = await candidateRow(sql, execution.id, candidate.id);
        const partial = attemptedMutation || Object.keys(idMap).length > 0;
        const status = unknown ? 'outcome_unknown' as const : 'conflict' as const;
        const application = partial ? { requestId, idMap } : current.candidate.application;
        const changed = current.candidate.status !== status || pmSourceHash(current.candidate.application) !== pmSourceHash(application);
        const updated = { ...current.candidate, status, revision: current.revision + (changed ? 1 : 0), ...(application ? { application } : {}) };
        if (changed) await saveCandidate(sql, execution.id, actor, requestId, updated, unknown || partial ? requestId : null);
        const result: ReviewResult = { candidate: updated, idMap, status: unknown ? 'outcome_unknown' : 'conflict' };
        await settle(sql, actor, workspaceId, requestId, result, unknown ? 202 : error instanceof DomainError ? error.status : 409, !unknown); return result;
      });
    }
  }
  return {
    snapshot: (actor: Actor, workspaceId: string, executionId: string) => scoped(actor, workspaceId, async sql => { await executionRow(sql, actor, workspaceId, executionId); return snapshotRow(sql, executionId); }),
    freeze: (actor: Actor, workspaceId: string, executionId: string, agentEvidence: PmAutomationAgentEvidence) => scoped(actor, workspaceId, async sql => {
      const execution = await executionRow(sql, actor, workspaceId, executionId, true);
      const prior = (await sql.query<{ snapshot: PmAutomationSnapshot }>('SELECT snapshot FROM automation_pm_snapshots WHERE execution_id=$1', [executionId])).rows[0]; if (prior) return pmAutomationSnapshotSchema.parse(prior.snapshot);
      const snapshot = await buildPmAutomationSnapshot(sql, options.core, actor, execution, agentEvidence);
      await sql.query('INSERT INTO automation_pm_snapshots(execution_id,workspace_id,actor_id,project_id,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)', [executionId, workspaceId, actor.id, execution.project_id, JSON.stringify(snapshot)]); return snapshot;
    }),
    publish: (actor: Actor, workspaceId: string, executionId: string, value: PmAutomationResult) => scoped(actor, workspaceId, async sql => {
      const execution = await executionRow(sql, actor, workspaceId, executionId, true), snapshot = await snapshotRow(sql, executionId);
      let parsed: PmAutomationResult;
      try { parsed = validatePmAutomationResult(snapshot, value); } catch (error) { throw new DomainError('automation_pm_result_invalid', error instanceof Error ? error.message : 'Result does not match its trusted sources', 400); }
      if (parsed.executionId !== executionId || parsed.templateId !== snapshot.templateId || parsed.observedAt !== snapshot.observedAt) throw new DomainError('automation_pm_result_identity', 'Result must identify its exact frozen source execution and time', 400);
      const hash = pmSourceHash(parsed), prior = (await sql.query<{ result: PmAutomationResult; result_hash: string }>('SELECT result,result_hash FROM automation_pm_results WHERE execution_id=$1', [executionId])).rows[0];
      if (prior) { if (prior.result_hash !== hash) throw new DomainError('idempotency_conflict', 'An immutable result was already published for this execution', 409); return prior.result; }
      const refs = new Set(snapshot.sources.map(source => source.refId));
      if (parsed.findings.some(finding => finding.evidence.some(item => !refs.has(item.sourceRefId))) || new Set(parsed.candidates.map(candidate => candidate.id)).size !== parsed.candidates.length) throw new DomainError('automation_pm_untrusted_source', 'Findings need actual frozen evidence and unique candidate identities', 400);
      const result = parsed;
      const reviewCandidates = parsed.candidates.map(candidate => trustedCandidate(candidate, snapshot));
      if (result.findings.some(finding => finding.candidateIds.some(id => !result.candidates.some(candidate => candidate.id === id)))) throw new DomainError('automation_pm_candidate_missing', 'Finding references an unknown candidate', 400);
      await sql.query('INSERT INTO automation_pm_results(execution_id,workspace_id,actor_id,project_id,result,result_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [executionId, workspaceId, actor.id, execution.project_id, JSON.stringify(result), hash]);
      for (const candidate of reviewCandidates) { await sql.query('INSERT INTO automation_pm_candidates(execution_id,id,revision,candidate) VALUES($1,$2,1,$3::jsonb)', [executionId, candidate.id, JSON.stringify(candidate)]); await sql.query('INSERT INTO automation_pm_candidate_history(execution_id,candidate_id,revision,actor_id,candidate) VALUES($1,$2,1,$3,$4::jsonb)', [executionId, candidate.id, actor.id, JSON.stringify(candidate)]); }
      return result;
    }),
    result: (actor: Actor, workspaceId: string, executionId: string, original = false) => scoped(actor, workspaceId, async sql => { await executionRow(sql, actor, workspaceId, executionId); const row = (await sql.query<{ result: PmAutomationResult }>('SELECT result FROM automation_pm_results WHERE execution_id=$1', [executionId])).rows[0]; if (!row) throw new DomainError('automation_pm_result_missing', 'This execution has no published PM result yet', 404); if (original) return row.result; const candidates = (await sql.query<{ candidate: PmAutomationCandidate }>('SELECT candidate FROM automation_pm_candidates WHERE execution_id=$1 ORDER BY id', [executionId])).rows.map(row => row.candidate); return { ...row.result, candidates }; }),
    edit: (actor: Actor, workspaceId: string, executionId: string, candidateId: string, input: ReviewInput) => review(actor, workspaceId, executionId, candidateId, 'edit', input),
    preview: (actor: Actor, workspaceId: string, executionId: string, candidateId: string, input: ReviewInput) => review(actor, workspaceId, executionId, candidateId, 'preview', input),
    apply: (actor: Actor, workspaceId: string, executionId: string, candidateId: string, input: ReviewInput) => review(actor, workspaceId, executionId, candidateId, 'apply', input),
    ignore: (actor: Actor, workspaceId: string, executionId: string, candidateId: string, input: ReviewInput) => review(actor, workspaceId, executionId, candidateId, 'ignore', input),
    async receipt(actor: Actor, workspaceId: string, requestId: string): Promise<PmAutomationReviewReceipt> {
      let row = await scoped(actor, workspaceId, sql => receiptRow(sql, actor, workspaceId, requestId));
      if (!row) throw new DomainError('not_found_or_forbidden', 'Review receipt is not accessible', 404);
      if (!row.settled && row.operation === 'apply') { await reconcile(actor, workspaceId, requestId); row = await scoped(actor, workspaceId, sql => receiptRow(sql, actor, workspaceId, requestId)); }
      return pmAutomationReviewReceiptSchema.parse({ requestId, httpStatus: row!.http_status, result: row!.result });
    },
  };
}
