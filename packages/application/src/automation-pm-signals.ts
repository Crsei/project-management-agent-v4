import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { pmAutomationEventSchema, pmAutomationTaskSchema, isPmAutomationTemplateId, type PmAutomationEvent, type PmAutomationSourceRef, type PmAutomationTask } from '../../contracts/src/automation-pm.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { statusCategory, type FileRecord, type ProtocolConfiguration } from '../../pm-schema/index.ts';
import { descriptionOf } from '../../pm-markdown/index.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import type { CoreFactObservation } from '../../pm-core/service-facts.ts';
import type { SqlExecutor } from './ports.ts';
import { enqueueAutomationStudioEvent, studioAuthorize, type StudioDefinitionRow } from './automation-studio-store.ts';
import { matchesAutomationEventFilter } from './automation-events-filter.ts';

const origin = new AsyncLocalStorage<string>();
/** Origin is trusted application context, never a Markdown field or browser-supplied flag. */
export function withPmAutomationOrigin<T>(executionId: string, operation: () => Promise<T>): Promise<T> { return origin.run(executionId, operation); }
export function currentPmAutomationOrigin(): string | null { return origin.getStore() ?? null; }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const pmTaskSourceRefId = (id: string, revision: string): string => `task:${id}:${revision}`;
/** Exact source fields only. An oversized/unsupported source is a missing boundary, never a truncated complete version. */
export function pmAutomationTaskFromFile(file: FileRecord, configuration?: ProtocolConfiguration): PmAutomationTask | null {
  const e = file.entity;
  if (e.entity !== 'work_item' || file.stale || !e.project || !e.status) return null;
  const criteria = e.checklist.map(item => item.text);
  const value = pmAutomationTaskSchema.safeParse({
    id: file.id, sourceRefId: pmTaskSourceRefId(file.id, file.revision), revision: file.revision, projectId: e.project,
    title: e.title, description: descriptionOf(file), status: e.status, statusCategory: configuration ? statusCategory(e, configuration) ?? null : null,
    archived: e.archived === true, acceptanceCriteria: criteria, labels: e.labels,
    assigneeIds: e.assignee ? [e.assignee] : [], dependsOn: e.blocked_by, relatedTaskIds: e.related_to,
    goalIds: [...new Set([...(e.goals ?? []), ...(e.goal ? [e.goal] : [])])], allowedPaths: Array.isArray(e['x-pm-allowed-paths']) ? e['x-pm-allowed-paths'].filter((item): item is string => typeof item === 'string') : [],
    milestoneId: e.milestone ?? null, createdAt: at(e.createdAt), updatedAt: at(e.updatedAt),
    lastActivityAt: at(e['x-pm-last-activity-at']), progressNote: typeof e['x-pm-progress-note'] === 'string' ? e['x-pm-progress-note'] : '',
  });
  return value.success ? value.data : null;
}
function sourceRef(identity: { actorId: string; workspaceId: string; projectId: string }, file: FileRecord, time: string): PmAutomationSourceRef {
  const kind = file.entity.entity === 'work_item' ? 'task' : file.entity.entity === 'milestone' ? 'milestone' : 'project';
  return { ...identity, refId: `${kind}:${file.id}:${file.revision}`, kind, id: file.id, revision: file.revision,
    label: file.entity.title.slice(0, 1000), url: kind === 'project' ? `/pm/${identity.workspaceId}/projects/${identity.projectId}` : `/pm/${identity.workspaceId}/entities/${file.id}`, updatedAt: time };
}
/** Called while the native mutation is prepared, then persisted in its existing crash-recovery journal. */
export function capturePmAutomationEvents(input: { eventId: string; actorId: string; workspaceId: string; before?: FileRecord | undefined; after?: FileRecord | undefined; configuration?: ProtocolConfiguration | undefined }): PmAutomationEvent[] {
  const { before, after } = input;
  if (!after || before?.revision === after.revision || after.stale || before?.stale) return [];
  const projectId = after.entity.entity === 'project' ? after.id : after.entity.project;
  if (!projectId || before && (before.entity.entity === 'project' ? before.id : before.entity.project) !== projectId) return [];
  const keys: PmAutomationEvent['key'][] = [];
  if (after.entity.entity === 'work_item') {
    keys.push(before ? 'task.updated' : 'task.created');
    if (before && before.entity.status !== after.entity.status) keys.push('task.state_changed');
    if (before && digest(before.entity.blocked_by) !== digest(after.entity.blocked_by)) keys.push('task.dependencies_changed');
    if ((after.entity.milestone || before?.entity.milestone) && (!before || before.entity.milestone !== after.entity.milestone || before.entity.status !== after.entity.status)) keys.push('milestone.changed');
  } else if (after.entity.entity === 'milestone') keys.push('milestone.changed');
  if (!keys.length) return [];
  const time = new Date().toISOString(), identity = { actorId: input.actorId, workspaceId: input.workspaceId, projectId };
  const previousTask = before ? pmAutomationTaskFromFile(before, input.configuration) : null;
  const nextTask = pmAutomationTaskFromFile(after, input.configuration);
  const boundary = (task: PmAutomationTask | null) => task ? { sourceRefId: task.sourceRefId, task, capturedAt: time, provenance: 'durable-event' as const } : null;
  return keys.map(key => {
    const event = pmAutomationEventSchema.parse({ ...identity, eventId: `${input.eventId}:${key}`, source: 'pm', key, at: time,
      sourceRef: sourceRef(identity, after, time), originExecutionId: currentPmAutomationOrigin(),
      before: boundary(previousTask), after: boundary(nextTask), lastVisitAt: null, visitedAt: null });
    if (Buffer.byteLength(JSON.stringify(event)) > 512 * 1024) { event.before = null; event.after = null; }
    return event;
  });
}

function assertEventScope(event: PmAutomationEvent): void {
  if (event.actorId !== event.sourceRef.actorId || event.workspaceId !== event.sourceRef.workspaceId || event.projectId !== event.sourceRef.projectId)
    throw new DomainError('automation_signal_scope_mismatch', 'Signal and source identities must agree', 403);
  for (const boundary of [event.before, event.after]) {
    if (boundary && (boundary.task.projectId !== event.projectId || boundary.sourceRefId !== boundary.task.sourceRefId))
      throw new DomainError('automation_signal_scope_mismatch', 'Version boundary belongs to a different source scope', 403);
  }
  if (event.before && event.after && event.before.task.id !== event.after.task.id)
    throw new DomainError('automation_signal_scope_mismatch', 'Version boundaries must describe the same task', 403);
}
/** Caller owns the existing workspace transaction lock. Source identity and immutable payload are one receipt. */
export async function insertPmAutomationSignal(sql: SqlExecutor, event: PmAutomationEvent): Promise<boolean> {
  const parsed = pmAutomationEventSchema.parse(event); assertEventScope(parsed);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 512 * 1024) throw new DomainError('automation_signal_too_large', 'Signal exceeds the bounded persistent payload size', 413);
  if (parsed.originExecutionId) return false;
  const privateActor = parsed.key === 'project.visited' || parsed.key.startsWith('agent.');
  const prior = (await sql.query<{ same: boolean }>('SELECT payload=$3::jsonb AS same FROM automation_pm_signals WHERE workspace_id=$1 AND source_key=$2', [parsed.workspaceId, parsed.eventId, JSON.stringify(parsed)])).rows[0];
  if (prior) { if (!prior.same) throw new DomainError('automation_signal_identity_conflict', 'Source event identity already has a different immutable payload', 409); return false; }
  await sql.query('INSERT INTO automation_pm_signals(workspace_id,project_id,actor_id,source_key,payload) VALUES($1,$2,$3,$4,$5::jsonb)', [parsed.workspaceId, parsed.projectId, privateActor ? parsed.actorId : null, parsed.eventId, JSON.stringify(parsed)]);
  return true;
}

/** External core observations are durable hashes, not body history or a human attribution. */
export async function insertPmAutomationObservationSignals(sql: SqlExecutor, workspaceId: string, observation: CoreFactObservation): Promise<void> {
  const next = observation.after, before = observation.before;
  if (!next?.projectId || before && before.projectId !== next.projectId || !observation.changeKinds.length) return;
  const keys: PmAutomationEvent['key'][] = [];
  if (next.kind === 'work_item') {
    keys.push(before ? 'task.updated' : 'task.created');
    if (before && observation.changeKinds.includes('lifecycle_changed')) keys.push('task.state_changed');
    if (before?.dependencies && next.dependencies && before.dependencies !== next.dependencies) keys.push('task.dependencies_changed');
  } else if (next.kind === 'milestone') keys.push('milestone.changed');
  if (!keys.length) return;
  // This actor is an authorized-definition audience, never an asserted author of an external edit.
  // Fanout independently reauthorizes and binds every immutable execution to its own actor.
  const owner = (await sql.query<{ actor_id: string }>(`SELECT actor_id FROM automation_studio_definitions WHERE workspace_id=$1 AND project_id=$2
    AND status='enabled' AND deleted_at IS NULL AND config->'trigger'->>'source'='pm' AND config->'trigger'->>'kind'='event'
    ORDER BY id LIMIT 1`, [workspaceId, next.projectId])).rows[0];
  if (!owner) return;
  for (const key of keys) {
    if ((await sql.query('SELECT 1 FROM automation_pm_signals WHERE workspace_id=$1 AND source_key=$2', [workspaceId, `observation:${observation.factId}:${key}`])).rowCount) continue;
    const kind = next.kind === 'work_item' ? 'task' : 'milestone';
    await insertPmAutomationSignal(sql, { eventId: `observation:${observation.factId}:${key}`, source: 'pm', key,
      actorId: owner.actor_id, workspaceId, projectId: next.projectId, at: observation.observedAt,
      sourceRef: { actorId: owner.actor_id, workspaceId, projectId: next.projectId, kind, id: next.id, revision: next.revision,
        refId: `${kind}:${next.id}:${next.revision}`, label: `Observed ${kind} change`, url: null, updatedAt: observation.observedAt },
      originExecutionId: null, before: null, after: null, lastVisitAt: null, visitedAt: null });
  }
}

type Context = { database: () => Pool; core: NotificationCorePort };
/** Only the signed Agent producer route calls this; it is not an automation service bearer write capability. */
export async function receivePmAutomationSignal(options: Context, input: { workspaceId: string; event: PmAutomationEvent }): Promise<{ eventId: string; accepted: boolean }> {
  const event = pmAutomationEventSchema.parse(input.event); assertEventScope(event);
  if (input.workspaceId !== event.workspaceId || !['agent.run.terminal', 'agent.session.idle'].includes(event.key)
    || event.sourceRef.kind !== (event.key === 'agent.run.terminal' ? 'execution' : 'session') || event.before || event.after || event.lastVisitAt || event.visitedAt)
    throw new DomainError('automation_signal_source_forbidden', 'Agent ingress only accepts exact terminal generation or idle session boundaries', 403);
  const sql = await options.database().connect();
  try {
    await sql.query('BEGIN'); await lockWorkspace(sql, event.workspaceId);
    await studioAuthorize(sql, options.core, { id: event.actorId, email: '', name: '' }, event.workspaceId, event.projectId);
    const accepted = await insertPmAutomationSignal(sql, event);
    await sql.query('COMMIT'); return { eventId: event.eventId, accepted };
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
}

/** Server clock and actor/project state define22. Retries return the original window without moving the watermark twice. */
export async function recordPmAutomationVisit(options: Context, actor: Actor, workspaceId: string, input: { requestId: string; projectId: string }): Promise<PmAutomationEvent> {
  const sql = await options.database().connect();
  try {
    await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId);
    await studioAuthorize(sql, options.core, actor, workspaceId, input.projectId);
    const eventId = `visit:${actor.id}:${input.requestId}`;
    const prior = (await sql.query<{ payload: PmAutomationEvent }>('SELECT payload FROM automation_pm_signals WHERE workspace_id=$1 AND source_key=$2', [workspaceId, eventId])).rows[0];
    if (prior) {
      if (prior.payload.projectId !== input.projectId) throw new DomainError('automation_signal_identity_conflict', 'Visit request belongs to a different project', 409);
      await sql.query('COMMIT'); return pmAutomationEventSchema.parse(prior.payload);
    }
    const clock = (await sql.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
    const previous = (await sql.query<{ last_visit_at: Date }>('SELECT last_visit_at FROM automation_pm_visits WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 FOR UPDATE', [workspaceId, actor.id, input.projectId])).rows[0];
    const event: PmAutomationEvent = { eventId, source: 'pm', key: 'project.visited', actorId: actor.id, workspaceId, projectId: input.projectId, at: clock,
      sourceRef: { actorId: actor.id, workspaceId, projectId: input.projectId, refId: eventId, kind: 'visit', id: input.requestId, revision: clock,
        label: 'Authorized project visit', url: `/pm/${workspaceId}/projects/${input.projectId}`, updatedAt: clock },
      originExecutionId: null, before: null, after: null, lastVisitAt: previous?.last_visit_at.toISOString() ?? null, visitedAt: clock };
    await insertPmAutomationSignal(sql, event);
    await sql.query(`INSERT INTO automation_pm_visits(workspace_id,actor_id,project_id,last_visit_at,request_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,actor_id,project_id) DO UPDATE SET last_visit_at=excluded.last_visit_at,request_id=excluded.request_id`, [workspaceId, actor.id, input.projectId, clock, input.requestId]);
    await sql.query('COMMIT'); return event;
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
}

type OutboxRow = { id: string; event_id: string; workspace_id: string; project_id: string | null; actor_id: string; aggregate_id: string; aggregate_kind: string; aggregate_version: number; event_type: string; created_at: Date; audience_actor_id: string | null; payload: Record<string, unknown> };
/** Existing outbox metadata is a trigger, not invented content history. Native version boundaries use the journal hook above. */
export function pmAutomationEventFromOutbox(row: OutboxRow): PmAutomationEvent | null {
  if (!row.project_id || row.audience_actor_id) return null;
  let key: PmAutomationEvent['key'];
  if (row.aggregate_kind === 'work_item') {
    key = /Created$/.test(row.event_type) ? 'task.created' : /Dependency|Blockers/.test(row.event_type) ? 'task.dependencies_changed' : /Started|Completed|Cancelled|Reopened|Ready/.test(row.event_type) ? 'task.state_changed' : 'task.updated';
  } else if (row.aggregate_kind === 'milestone') key = 'milestone.changed';
  else return null;
  const revision = String(row.aggregate_version), time = row.created_at.toISOString();
  const kind = row.aggregate_kind === 'work_item' ? 'task' : 'milestone';
  const parsed = pmAutomationEventSchema.safeParse({ eventId: `outbox:${row.event_id}`, source: 'pm', key, actorId: row.actor_id,
    workspaceId: row.workspace_id, projectId: row.project_id, at: time,
    sourceRef: { actorId: row.actor_id, workspaceId: row.workspace_id, projectId: row.project_id, refId: `${kind}:${row.aggregate_id}:${revision}`, kind, id: row.aggregate_id,
      revision, label: row.event_type, url: null, updatedAt: time }, originExecutionId: row.payload.originExecutionId ?? null,
    before: null, after: null, lastVisitAt: null, visitedAt: null });
  return parsed.success ? parsed.data : null;
}

type SignalRow = { id: string; actor_id: string | null; project_id: string; payload: PmAutomationEvent; definition_after: string };
/** Bounded durable cursors; queue insertion, definition fanout and cursor advancement share the workspace lock and transaction. */
export async function runPmAutomationSignalBatch(pool: Pool, core: NotificationCorePort, options: { workspaceLimit?: number; outboxLimit?: number; signalLimit?: number; definitionLimit?: number } = {}): Promise<{ imported: number; enqueued: number; dispatched: number }> {
  const bound = (value: number | undefined, fallback: number, maximum: number): number => Math.max(1, Math.min(maximum, Number.isFinite(value) ? Math.floor(value!) : fallback));
  const workspaceLimit = bound(options.workspaceLimit, 4, 20), outboxLimit = bound(options.outboxLimit, 100, 500);
  const signalLimit = bound(options.signalLimit, 4, 20), definitionLimit = bound(options.definitionLimit, 10, 50);
  const workspaces = await pool.query<{ workspace_id: string }>(`SELECT workspace_id FROM (
    SELECT s.workspace_id,min(s.recorded_at) AS pending_at FROM automation_pm_signals s WHERE s.dispatched_at IS NULL GROUP BY s.workspace_id
    UNION ALL SELECT o.workspace_id,min(o.created_at) FROM outbox o LEFT JOIN automation_pm_signal_cursors c USING(workspace_id) WHERE o.id>coalesce(c.outbox_id,0) GROUP BY o.workspace_id
    ) pending GROUP BY workspace_id ORDER BY min(pending_at),workspace_id LIMIT $1`, [workspaceLimit]);
  let imported = 0, enqueued = 0, dispatched = 0;
  for (const { workspace_id: workspaceId } of workspaces.rows) {
    const sql = await pool.connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId);
      await sql.query('INSERT INTO automation_pm_signal_cursors(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [workspaceId]);
      const cursor = (await sql.query<{ outbox_id: string }>('SELECT outbox_id::text FROM automation_pm_signal_cursors WHERE workspace_id=$1', [workspaceId])).rows[0]!;
      const changes = await sql.query<OutboxRow>('SELECT * FROM outbox WHERE workspace_id=$1 AND id>$2::bigint ORDER BY id LIMIT $3', [workspaceId, cursor.outbox_id, outboxLimit]);
      for (const row of changes.rows) { const event = pmAutomationEventFromOutbox(row); if (event && await insertPmAutomationSignal(sql, event)) imported++; }
      if (changes.rows.length) await sql.query('UPDATE automation_pm_signal_cursors SET outbox_id=$2::bigint WHERE workspace_id=$1', [workspaceId, String(changes.rows.at(-1)!.id)]);
      const signals = await sql.query<SignalRow>('SELECT id::text,actor_id,project_id,payload,definition_after FROM automation_pm_signals WHERE workspace_id=$1 AND dispatched_at IS NULL ORDER BY id LIMIT $2 FOR UPDATE', [workspaceId, signalLimit]);
      for (const signal of signals.rows) {
        const event = pmAutomationEventSchema.parse(signal.payload);
        if (event.originExecutionId) { await sql.query('UPDATE automation_pm_signals SET dispatched_at=clock_timestamp() WHERE id=$1', [signal.id]); dispatched++; continue; }
        const definitions = await sql.query<StudioDefinitionRow>(`SELECT * FROM automation_studio_definitions WHERE workspace_id=$1 AND project_id=$2 AND deleted_at IS NULL AND status='enabled'
          AND ($3::uuid IS NULL OR actor_id=$3) AND config->'trigger'->>'kind'='event' AND config->'trigger'->>'source'='pm' AND config->'trigger'->>'key'=$4
          AND id::text>$5 AND date_trunc('milliseconds',updated_at)<=$6::timestamptz ORDER BY id::text LIMIT $7`, [workspaceId, signal.project_id, signal.actor_id, event.key, signal.definition_after, event.at, definitionLimit]);
        for (const definition of definitions.rows) {
          if (definition.config.action.kind !== 'template' || !isPmAutomationTemplateId(definition.config.action.templateId) || definition.config.trigger.kind !== 'event') continue;
          const payload: PmAutomationEvent = { ...event, actorId: definition.actor_id, sourceRef: { ...event.sourceRef, actorId: definition.actor_id } };
          await sql.query('SAVEPOINT pm_signal_enqueue');
          try {
            if (await matchesAutomationEventFilter(payload, definition.config.trigger.filter)) {
              await enqueueAutomationStudioEvent(sql, core, { workspaceId, actorId: definition.actor_id, definitionId: definition.id,
                eventId: event.eventId, payload, source: 'pm', key: event.key });
              enqueued++;
            }
          } catch (error) {
            await sql.query('ROLLBACK TO SAVEPOINT pm_signal_enqueue');
            if (!(error instanceof DomainError) || ![401, 403, 404, 409].includes(error.status) && !error.code.startsWith('event_filter_')) throw error;
          }
          await sql.query('RELEASE SAVEPOINT pm_signal_enqueue');
        }
        if (definitions.rows.length < definitionLimit) { await sql.query('UPDATE automation_pm_signals SET dispatched_at=clock_timestamp() WHERE id=$1', [signal.id]); dispatched++; }
        else await sql.query('UPDATE automation_pm_signals SET definition_after=$2 WHERE id=$1', [signal.id, definitions.rows.at(-1)!.id]);
      }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  return { imported, enqueued, dispatched };
}
