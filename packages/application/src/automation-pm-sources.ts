import type { PoolClient } from 'pg';
import { pmAutomationArgumentsSchema, pmAutomationEventSchema, pmAutomationSnapshotSchema, type PmAutomationAgentEvidence, type PmAutomationSnapshot, type PmAutomationSourceRef, type PmAutomationTask, type PmAutomationCoverage } from '../../contracts/src/automation-pm.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { statusCategory, workflowFor, type FileRecord } from '../../pm-schema/index.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { automationSnapshot, authorizeAutomationProject } from './automation-report.ts';
import type { StudioExecutionRow } from './automation-studio-store.ts';
import { pmAutomationTaskFromFile } from './automation-pm-signals.ts';
import { requestHash } from './kernel.ts';

/** JSONB reorders object keys; source equality uses the existing canonical command fingerprint. */
export const pmSourceHash = (value: unknown): string => requestHash({ value });
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const time = (value: unknown): string | null => { if (typeof value !== 'string' && !(value instanceof Date)) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };

/** Current PM facts are read only from the native core and scope-bound SQL records, never from runtime-supplied PM objects. */
export async function buildPmAutomationSnapshot(sql: PoolClient, core: NotificationCorePort, actor: Actor, execution: StudioExecutionRow, evidence: PmAutomationAgentEvidence): Promise<PmAutomationSnapshot> {
  const action = execution.config_snapshot.action;
  if (action.kind !== 'template') throw new DomainError('automation_pm_template_required', 'This execution is not a PM template', 400);
  const args = pmAutomationArgumentsSchema.parse(action.arguments);
  const current = await automationSnapshot(core, execution.workspace_id);
  await authorizeAutomationProject(sql, actor, execution.workspace_id, execution.project_id, current);
  const configuration = current.configuration!;
  const project = current.files.find(file => file.id === execution.project_id && file.entity.entity === 'project')!;
  const projectFiles = current.files.filter(file => file.entity.project === project.id);
  const allTasks = projectFiles.filter(file => file.entity.entity === 'work_item');
  const taskById = new Map(allTasks.map(file => [file.id, file]));
  if (args.taskIds?.some(id => !taskById.has(id))) throw new DomainError('automation_pm_scope_forbidden', 'A selected task is not in the execution project', 404);
  const workflow = workflowFor('work_item', configuration);
  if (!workflow || args.statusIds?.some(id => !workflow.states.some(state => state.id === id))) throw new DomainError('automation_pm_scope_invalid', 'A selected workflow state is not configured', 400);
  if (args.milestoneId && !projectFiles.some(file => file.id === args.milestoneId && file.entity.entity === 'milestone')) throw new DomainError('automation_pm_scope_forbidden', 'The selected milestone is not in the execution project', 404);
  if (args.assigneeIds) for (const id of args.assigneeIds) {
    const member = (await sql.query<{ project_ids: string[] | null }>('SELECT m.project_ids FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id::text=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL', [execution.workspace_id, id])).rows[0];
    if (!member || member.project_ids !== null && !member.project_ids.includes(project.id)) throw new DomainError('automation_pm_scope_invalid', 'A selected assignee is not an active project member', 400);
  }
  const selected = allTasks.filter(file => (!args.taskIds || args.taskIds.includes(file.id)) && (!args.statusIds || args.statusIds.includes(file.entity.status ?? '')) && (!args.assigneeIds || args.assigneeIds.includes(String(file.entity.assignee ?? ''))) && (!args.labels || args.labels.every(label => file.entity.labels.includes(label))) && (!args.milestoneId || action.templateId === 'pm-next-phase-plan' || file.entity.milestone === args.milestoneId));
  const taskScope = !!(args.taskIds || args.statusIds || args.assigneeIds || args.labels || args.milestoneId && action.templateId !== 'pm-next-phase-plan');
  const selectedTaskIds = new Set(selected.map(file => file.id));
  const linkedDocumentIds = projectFiles.filter(file => file.entity.entity === 'document' && ([...file.entity.related_to, ...file.entity.links].some(id => selectedTaskIds.has(id)) || selected.some(task => task.entity.related_to.includes(file.id)))).map(file => file.id);
  const coverage: PmAutomationCoverage[] = [];
  const capped = <T>(source: PmAutomationCoverage['source'], items: T[], maximum: number): T[] => { coverage.push({ source, status: items.length > maximum ? 'partial' : 'complete', observedRecords: Math.min(items.length, maximum), totalRecords: items.length, reason: items.length > maximum ? 'Record limit reached; excluded records were not analyzed' : null }); return items.slice(0, maximum); };
  const sources: PmAutomationSourceRef[] = [];
  const ref = (kind: PmAutomationSourceRef['kind'], id: string, revision: string, label: string, updatedAt: string | null): string => {
    const refId = `${kind}:${id}:${revision}`;
    const url = kind === 'project' ? `/pm/${execution.workspace_id}/projects/${id}` : ['task', 'document', 'milestone', 'goal'].includes(kind) ? `/pm/${execution.workspace_id}/entities/${encodeURIComponent(id)}` : null;
    if (!sources.some(source => source.refId === refId)) sources.push({ refId, kind, id, revision, actorId: actor.id, workspaceId: execution.workspace_id, projectId: project.id, label: label.slice(0, 1000), url, updatedAt });
    return refId;
  };
  const audit = (await sql.query<{ id: string; target_id: string; action: string; after_version: string | null; occurred_at: Date; changes: unknown; automation_origin: boolean }>(`SELECT a.id::text,a.target_id,a.action,a.after_version,a.occurred_at,a.changes,
    EXISTS(SELECT 1 FROM automation_pm_apply_steps s WHERE s.workspace_id=a.workspace_id AND s.result#>>'{receipt,commandId}'=a.command_id) AS automation_origin
    FROM project_audit a WHERE a.workspace_id=$1 AND a.project_id=$2 AND (a.audience_actor_id IS NULL OR a.audience_actor_id=$3)
    AND (NOT $4::boolean OR a.target_id=ANY($5::text[]) OR EXISTS(SELECT 1 FROM task_comments c WHERE c.workspace_id=a.workspace_id AND c.project_id=a.project_id AND c.id::text=a.target_id AND c.task_id=ANY($6::text[])))
    ORDER BY a.id DESC LIMIT 2001`, [execution.workspace_id, project.id, actor.id, taskScope, [...selectedTaskIds, ...linkedDocumentIds], [...selectedTaskIds]])).rows;
  const latestAt = (id: string): string | null => audit.find(item => item.target_id === id)?.occurred_at.toISOString() ?? null;
  const body = (record: FileRecord): string => {
    if (record.entity.body.length > 24000) coverage.push({ source: record.entity.entity === 'work_item' ? 'tasks' : record.entity.entity === 'project' || record.entity.entity === 'goal' ? 'project' : 'documents', status: 'partial', observedRecords: 1, totalRecords: 1, reason: `${record.id} body exceeds 24000 characters; only a bounded prefix is available` });
    return record.entity.body.slice(0, 24000);
  };
  const observedAt = (await sql.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const selectedFiles = capped('tasks', selected, 1000);
  const selectedIds = new Set(selectedFiles.map(file => file.id));
  const tasks: PmAutomationTask[] = [];
  for (const record of selectedFiles) {
    const normalized = pmAutomationTaskFromFile(record, configuration);
    if (!normalized) {
      coverage.push({ source: 'tasks', status: 'partial', observedRecords: tasks.length, totalRecords: selected.length, reason: `${record.id} cannot be represented safely; it was not analyzed` });
      continue;
    }
    const observed = latestAt(record.id);
    tasks.push({ ...normalized, sourceRefId: ref('task', record.id, record.revision, record.entity.title, observed), updatedAt: observed ?? normalized.updatedAt, lastActivityAt: observed ?? normalized.lastActivityAt });
  }
  if (tasks.length !== selectedFiles.length) {
    selectedIds.clear();
    for (const item of tasks) selectedIds.add(item.id);
  }
  const hiddenDependencies = selectedFiles.some(file => file.entity.blocked_by.some(id => !selectedIds.has(id)));
  if (hiddenDependencies) coverage.push({ source: 'relationships', status: 'partial', observedRecords: 0, totalRecords: null, reason: 'Dependencies outside the explicitly selected task set were not read; readiness cannot be asserted for those tasks' });
  const documentIds = projectFiles.filter(file => file.entity.entity === 'document' && (!taskScope || linkedDocumentIds.includes(file.id))).map(file => file.id);
  const automationDocuments = new Set((await sql.query<{ id: string }>(`SELECT current_source.id FROM automation_pm_apply_steps s JOIN unnest($2::text[],$3::text[]) AS current_source(id,revision)
    ON s.result#>>'{receipt,targetId}'=current_source.id AND s.result#>>'{receipt,revision}'=current_source.revision
    WHERE s.workspace_id=$1 AND EXISTS(SELECT 1 FROM automation_pm_apply_steps creation WHERE creation.workspace_id=s.workspace_id AND creation.actor_id=s.actor_id AND creation.request_id=s.request_id AND creation.tool='pm_create_document' AND creation.result#>>'{receipt,targetId}'=current_source.id)`, [execution.workspace_id, documentIds, projectFiles.filter(file => documentIds.includes(file.id)).map(file => file.revision)])).rows.map(row => row.id));
  const documents = capped('documents', projectFiles.filter(file => documentIds.includes(file.id)), 200).map(file => ({ id: file.id, sourceRefId: ref('document', file.id, file.revision, file.entity.title, latestAt(file.id)), revision: file.revision, title: file.entity.title, body: body(file), taskIds: [...new Set([...file.entity.related_to, ...file.entity.links, ...selected.filter(task => task.entity.related_to.includes(file.id)).map(task => task.id)].filter(id => selectedIds.has(id)))], createdAt: time(file.entity['x-pm-created-at']), updatedAt: latestAt(file.id) ?? time(file.entity['x-pm-updated-at']), automationOrigin: automationDocuments.has(file.id) }));
  const relationships = capped('relationships', selectedFiles.flatMap(file => ([['blocked_by', 'depends-on'], ['related_to', 'related'], ['parent', 'parent']] as const).flatMap(([field, kind]) => (typeof file.entity[field] === 'string' ? [file.entity[field] as string] : strings(file.entity[field])).filter(id => selectedIds.has(id)).map(id => { const key = `${file.id}:${field}:${id}`; return { id: key, sourceRefId: ref('relationship', key, pmSourceHash([file.revision, taskById.get(id)?.revision]), key, latestAt(file.id)), fromTaskId: file.id, toTaskId: id, kind }; }))), 5000);
  const commentsRows = (await sql.query<{ id: string; task_id: string; version: number; content: string; author_id: string; updated_at: Date }>('SELECT id,task_id,version,content,author_id,updated_at FROM task_comments WHERE workspace_id=$1 AND project_id=$2 AND task_id=ANY($3::text[]) AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1001', [execution.workspace_id, project.id, [...selectedIds]])).rows;
  const comments = capped('comments', commentsRows, 1000).map(row => ({ id: row.id, sourceRefId: ref('comment', row.id, String(row.version), 'Task comment', row.updated_at.toISOString()), taskId: row.task_id, text: row.content, at: row.updated_at.toISOString(), actorId: row.author_id }));
  for (const item of tasks) item.lastActivityAt = [item.lastActivityAt, ...comments.filter(comment => comment.taskId === item.id).map(comment => comment.at)].filter((at): at is string => at !== null).sort().at(-1) ?? null;
  const activities = capped('activities', audit, 1000).map(row => ({ id: row.id, sourceRefId: ref('activity', row.id, pmSourceHash({ ...row, occurred_at: row.occurred_at.toISOString() }), row.action, row.occurred_at.toISOString()), taskId: selectedIds.has(row.target_id) ? row.target_id : null, title: row.action, detail: JSON.stringify(row.changes), at: row.occurred_at.toISOString(), automationOrigin: row.automation_origin }));
  const milestones = capped('milestones', projectFiles.filter(file => file.entity.entity === 'milestone' && (!args.milestoneId || file.id === args.milestoneId)), 200).map(file => ({ id: file.id, sourceRefId: ref('milestone', file.id, file.revision, file.entity.title, latestAt(file.id)), title: file.entity.title, taskIds: tasks.filter(task => task.milestoneId === file.id).map(task => task.id), dueAt: file.entity.due ? time(`${file.entity.due}T00:00:00Z`) : null, completed: statusCategory(file.entity, configuration) === 'completed' }));
  const workflowRef = ref('workflow', 'work_item', pmSourceHash(workflow), 'Current task workflow', null);
  coverage.push({ source: 'workflow', status: 'complete', observedRecords: workflow.states.length, totalRecords: workflow.states.length, reason: null }, { source: 'project', status: 'complete', observedRecords: 1, totalRecords: 1, reason: null });
  const agentKinds: Partial<Record<PmAutomationSourceRef['kind'], true>> = { session: true, message: true, execution: true, test: true, tool: true, diff: true, 'pull-request': true };
  if (evidence.sources.some(source => source.actorId !== actor.id || source.workspaceId !== execution.workspace_id || source.projectId !== project.id || !agentKinds[source.kind])) throw new DomainError('automation_pm_evidence_scope_forbidden', 'Agent evidence is outside the execution identity or source boundary', 403);
  const sessionIds = new Set(evidence.sessions.map(session => session.id));
  if (evidence.sessions.some(session => taskScope && !session.taskIds.length || session.taskIds.some(id => !selectedIds.has(id))) || evidence.executions.some(run => !sessionIds.has(run.sessionId) || run.taskId !== null && !selectedIds.has(run.taskId)) || evidence.pullRequests.some(pr => !selectedIds.has(pr.taskId) || args.taskIds?.length !== 1 || args.taskIds[0] !== pr.taskId)) throw new DomainError('automation_pm_evidence_scope_forbidden', 'Agent evidence references a task outside the explicit selection', 403);
  const refs = new Set(evidence.sources.map(source => source.refId));
  const agentRefs = [...evidence.sessions.flatMap(session => [session.sourceRefId, ...session.messages.map(message => message.sourceRefId)]), ...evidence.executions.flatMap(run => [run.sourceRefId, ...run.tests.map(test => test.sourceRefId), ...run.tools.map(tool => tool.sourceRefId), ...run.logs.map(log => log.sourceRefId)]), ...evidence.pullRequests.flatMap(pr => [pr.sourceRefId, ...pr.coverage.map(item => item.sourceRefId)])];
  if (agentRefs.some(id => !refs.has(id)) || evidence.sources.some(source => sources.some(pm => pm.refId === source.refId))) throw new DomainError('automation_pm_evidence_invalid', 'Agent evidence has missing or colliding source references', 400);
  sources.push(...evidence.sources); coverage.push(...evidence.coverage.filter(item => ['sessions', 'executions', 'pull-requests'].includes(item.source)));
  const eventResult = pmAutomationEventSchema.safeParse(execution.payload);
  let suppliedEvent: PmAutomationSnapshot['event'] = null;
  if (execution.trigger === 'event' && execution.config_snapshot.trigger.kind === 'event' && execution.config_snapshot.trigger.source === 'pm' && eventResult.success) {
    const stored = (await sql.query<{ payload: unknown }>('SELECT payload FROM automation_pm_signals WHERE workspace_id=$1 AND project_id=$2 AND source_key=$3 AND (actor_id IS NULL OR actor_id=$4)', [execution.workspace_id, project.id, eventResult.data.eventId, actor.id])).rows[0];
    const original = pmAutomationEventSchema.safeParse(stored?.payload);
    if (original.success && execution.source_key === `event:${original.data.eventId}` && original.data.key === execution.config_snapshot.trigger.key) {
      const bound = { ...original.data, actorId: actor.id, sourceRef: { ...original.data.sourceRef, actorId: actor.id } };
      if (pmSourceHash(bound) === pmSourceHash(eventResult.data)) suppliedEvent = bound;
    }
  }
  const event = suppliedEvent && [suppliedEvent.before, suppliedEvent.after].every(boundary => !boundary || selectedIds.has(boundary.task.id)) ? suppliedEvent : null;
  if (event) {
    if (!sources.some(source => source.refId === event.sourceRef.refId)) sources.push(event.sourceRef);
    for (const boundary of [event.before, event.after]) if (boundary && !sources.some(source => source.refId === boundary.sourceRefId)) sources.push({ ...event.sourceRef, refId: boundary.sourceRefId, id: boundary.task.id, kind: 'task', revision: boundary.task.revision });
  }
  coverage.push({ source: 'versions', status: event?.before && event.after ? 'complete' : 'unavailable', observedRecords: event?.before && event.after ? 2 : 0, totalRecords: event?.before && event.after ? 2 : null, reason: event?.before && event.after ? null : 'No durable before/after boundary is available inside this exact source selection' });
  coverage.push({ source: 'visits', status: event?.lastVisitAt ? 'complete' : 'unavailable', observedRecords: event?.lastVisitAt ? 1 : 0, totalRecords: event?.lastVisitAt ? 1 : null, reason: event?.lastVisitAt ? null : 'No previous actor/project visit boundary is available for this run' });
  const from = event?.lastVisitAt ?? (action.templateId === 'pm-project-digest' && args.lookbackDays === undefined ? `${observedAt.slice(0, 10)}T00:00:00.000Z` : new Date(Date.parse(observedAt) - (args.lookbackDays ?? 7) * 86400000).toISOString());
  const projectRef = ref('project', project.id, project.revision, project.entity.title, latestAt(project.id));
  const goalFiles = projectFiles.filter(file => file.entity.entity === 'goal' && ((project.entity.goals ?? []).includes(file.id) || tasks.some(task => task.goalIds.includes(file.id))));
  const goals: PmAutomationSnapshot['project']['goals'] = goalFiles.slice(0, 100).map(file => ({ id: file.id, sourceRefId: ref('goal', file.id, file.revision, file.entity.title, latestAt(file.id)), revision: file.revision, title: file.entity.title, description: body(file), taskIds: tasks.filter(task => task.goalIds.includes(file.id)).map(task => task.id), allowedPaths: strings(file.entity['x-pm-allowed-paths']) }));
  if (typeof project.entity.goal === 'string' && project.entity.goal.trim() && goals.length < 100) goals.push({ id: `${project.id}:goal`, sourceRefId: projectRef, revision: project.revision, title: project.entity.goal.slice(0, 2000), description: project.entity.goal, taskIds: [], allowedPaths: [] });
  const totalGoals = goalFiles.length + (typeof project.entity.goal === 'string' && project.entity.goal.trim() ? 1 : 0);
  coverage.push({ source: 'project', status: totalGoals > goals.length ? 'partial' : 'complete', observedRecords: goals.length + 1, totalRecords: totalGoals + 1, reason: totalGoals > goals.length ? 'Project goal record limit reached' : null });
  if (audit.length > 2000) coverage.push({ source: 'activities', status: 'partial', observedRecords: activities.length, totalRecords: null, reason: 'Scoped historical audit query reached its bound; older activity was not observed' });
  if (commentsRows.length > 1000) coverage.push({ source: 'comments', status: 'partial', observedRecords: comments.length, totalRecords: null, reason: 'Comment query reached its bound; older comments were not observed' });
  const unsettledOrigin = (await sql.query<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM automation_pm_apply_steps s JOIN automation_pm_receipts r USING(workspace_id,actor_id,request_id) JOIN automation_studio_executions e ON e.id=r.execution_id WHERE s.workspace_id=$1 AND e.project_id=$2 AND s.result IS NULL AND s.error IS NULL) AS pending`, [execution.workspace_id, project.id])).rows[0]!.pending;
  if (unsettledOrigin) for (const source of ['documents', 'activities'] as const) coverage.push({ source, status: 'partial', observedRecords: source === 'documents' ? documents.length : activities.length, totalRecords: null, reason: 'An original PM automation mutation is not reconciled; its output origin cannot yet be attributed completely' });
  const value = { templateId: action.templateId, executionId: execution.id, actorId: actor.id, workspaceId: execution.workspace_id, projectId: project.id, observedAt, args, sources,
    project: { id: project.id, sourceRefId: projectRef, revision: project.revision, title: project.entity.title, description: body(project), goals, createdAt: time(project.entity['x-pm-created-at']), updatedAt: latestAt(project.id) ?? time(project.entity['x-pm-updated-at']), archived: project.entity.archived === true },
    workflow: { sourceRefId: workflowRef, statuses: workflow.states.map(state => ({ id: state.id, name: state.label, category: state.category, nextStatusIds: workflow.transitions.filter(transition => transition.from === state.id).map(transition => transition.to) })), readyStatusId: workflow.default_targets?.unstarted ?? workflow.states.find(state => state.category === 'unstarted')?.id ?? null, reviewStatusId: workflow.states.find(state => state.category === 'started' && /review|审核|评审/i.test(state.label))?.id ?? null },
    tasks, documents, relationships, comments, activities, milestones, sessions: evidence.sessions, executions: evidence.executions, pullRequests: evidence.pullRequests.map(pr => ({ ...pr, taskRevision: tasks.find(task => task.id === pr.taskId)!.revision })), coverage, lastVisitAt: event?.lastVisitAt ?? null, before: event?.before ?? null, after: event?.after ?? null, event,
    timeWindow: { from, to: event?.visitedAt ?? observedAt, basis: event?.lastVisitAt ? 'last-visit' as const : 'lookback' as const } };
  const consolidated = new Map<PmAutomationCoverage['source'], PmAutomationCoverage>();
  for (const item of coverage) {
    const prior = consolidated.get(item.source);
    if (!prior) consolidated.set(item.source, item);
    else consolidated.set(item.source, { ...item, observedRecords: Math.max(item.observedRecords, prior.observedRecords), totalRecords: item.totalRecords === null || prior.totalRecords === null ? null : Math.max(item.totalRecords, prior.totalRecords), status: item.status === 'partial' || prior.status === 'partial' ? 'partial' : item.status, reason: [prior.reason, item.reason].filter(Boolean).join('; ') || null });
  }
  for (const source of ['sessions', 'executions', 'pull-requests'] as const) if (!consolidated.has(source)) consolidated.set(source, { source, status: 'unavailable', observedRecords: 0, totalRecords: null, reason: 'Agent did not provide authorized coverage for this source' });
  value.coverage = [...consolidated.values()];
  let estimatedBytes = Buffer.byteLength(JSON.stringify(value));
  const maximumBytes = 4 * 1024 * 1024;
  const bounded: { key: PmAutomationCoverage['source']; records: unknown[] }[] = [
    { key: 'activities', records: value.activities }, { key: 'comments', records: value.comments }, { key: 'documents', records: value.documents },
    { key: 'sessions', records: value.sessions }, { key: 'executions', records: value.executions }, { key: 'relationships', records: value.relationships },
    { key: 'tasks', records: value.tasks }, { key: 'pull-requests', records: value.pullRequests }, { key: 'milestones', records: value.milestones },
    { key: 'project', records: value.project.goals },
  ];
  for (const group of bounded) {
    let removed = false;
    while (estimatedBytes > maximumBytes - 8192 && group.records.length) {
      estimatedBytes -= Buffer.byteLength(JSON.stringify(group.records.pop()) ?? 'null') + 1;
      removed = true;
    }
    if (removed) {
      const original = consolidated.get(group.key)!;
      consolidated.set(group.key, { ...original, status: 'partial', observedRecords: group.records.length, reason: [original.reason, 'Snapshot byte boundary reached; omitted records were not analyzed'].filter(Boolean).join('; ') });
    }
    if (estimatedBytes <= maximumBytes - 8192) break;
  }
  const used = new Set<string>();
  const sourceIds = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) sourceIds(item); return; }
    for (const [key, item] of Object.entries(node)) {
      if (key === 'sources') continue;
      if (key === 'sourceRefId' && typeof item === 'string') used.add(item);
      else sourceIds(item);
    }
  };
  sourceIds(value); if (event) used.add(event.sourceRef.refId);
  value.sources = value.sources.filter(source => used.has(source.refId));
  for (const group of bounded) {
    const item = consolidated.get(group.key);
    if (item) consolidated.set(group.key, { ...item, observedRecords: group.records.length + (group.key === 'project' ? 1 : 0) });
  }
  value.coverage = [...consolidated.values()];
  const snapshot = pmAutomationSnapshotSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) throw new DomainError('automation_pm_snapshot_too_large', 'Combined evidence exceeds the 4 MiB analysis boundary; narrow the explicit scope', 413);
  return snapshot;
}
