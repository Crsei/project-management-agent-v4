import { randomUUID } from 'node:crypto';
import type { StudioActionKind, StudioConfig, StudioDefinition, StudioExecution, StudioExecutionEvent, StudioExecutionRequest } from '../../contracts/src/automation-studio.ts';
import { automationIntegrationSupportsMcp, automationIntegrationSupportsNativeApi, type AutomationIntegrationConfig, type AutomationIntegrationVerification } from '../../contracts/src/automation-integrations.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import type { SqlExecutor } from './ports.ts';
import { automationSnapshot, authorizeAutomationProject } from './automation-report.ts';
import { nextStudioDue } from './automation-studio-schedule.ts';

export type StudioDefinitionRow = { id: string; workspace_id: string; actor_id: string; project_id: string; revision: number; config: StudioConfig; status: StudioDefinition['status']; created_at: Date; updated_at: Date; last_run_at: Date | null; next_due_at: Date | null; deleted_at: Date | null };
export type StudioExecutionRow = { id: string; workspace_id: string; actor_id: string; definition_id: string; project_id: string; definition_revision: number; config_snapshot: StudioConfig; trigger: StudioExecution['trigger']; request_id: string; payload: Record<string, unknown> | null; source_key: string | null; status: StudioExecution['status']; created_at: Date; started_at: Date | null; finished_at: Date | null; dispatched_at: Date | null; budget_consumed: boolean; external_execution_id: string | null; thread_id: string | null; error: string | null; summary: string; lease_token: string | null; lease_until: Date | null };
export function studioDefinitionDto(row: StudioDefinitionRow): StudioDefinition { return { id: row.id, revision: row.revision, config: row.config, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), lastRunAt: row.last_run_at?.toISOString() ?? null, nextDueAt: row.next_due_at?.toISOString() ?? null }; }
export function studioExecutionDto(row: StudioExecutionRow): StudioExecution { return { id: row.id, definitionId: row.definition_id, definitionRevision: row.definition_revision, configSnapshot: row.config_snapshot, trigger: row.trigger, requestId: row.request_id, status: row.status, createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null, externalExecutionId: row.external_execution_id, threadId: row.thread_id, error: row.error, summary: row.summary }; }
export function studioExecutionRequest(row: StudioExecutionRow): StudioExecutionRequest { return { executionId: row.id, requestId: row.request_id, actorId: row.actor_id, workspaceId: row.workspace_id, projectId: row.project_id, definitionId: row.definition_id, definitionRevision: row.definition_revision, config: row.config_snapshot, trigger: row.trigger, payload: row.payload, issuedAt: row.created_at.toISOString() }; }
export async function studioClock(sql: SqlExecutor): Promise<Date> { return (await sql.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now; }
export async function studioAuthorize(sql: SqlExecutor, core: NotificationCorePort, actor: Actor, workspaceId: string, projectId: string, write = false, active = write): Promise<void> { await authorizeAutomationProject(sql, actor, workspaceId, projectId, await automationSnapshot(core, workspaceId), write, active); }
export async function appendStudioEvent(sql: SqlExecutor, id: string, kind: StudioExecutionEvent['kind'], message: string, stream: StudioExecutionEvent['stream'] = null, externalId: string | null = null, at?: string): Promise<void> { await sql.query('INSERT INTO automation_studio_execution_events(execution_id,kind,message,stream,external_id,at) VALUES($1,$2,$3,$4,$5,coalesce($6::timestamptz,clock_timestamp())) ON CONFLICT(execution_id,external_id) DO NOTHING', [id, kind, message, stream, externalId, at ?? null]); }
/** Configuration support and durable verification are distinct; neither implies the other. */
export function studioIntegrationSupportsAction(config: AutomationIntegrationConfig, verification: AutomationIntegrationVerification, kind?: StudioActionKind): boolean {
  const mcp = automationIntegrationSupportsMcp(config) && verification.mcp === true;
  const nativeApi = automationIntegrationSupportsNativeApi(config) && verification.nativeApi === true;
  if (kind === undefined) return mcp || nativeApi;
  if (kind === 'template' && (config.provider === 'github' || config.provider === 'gitlab')) return nativeApi;
  return mcp;
}
export function assertStudioConfig(config: StudioConfig, now: Date): void {
  nextStudioDue(config, now);
  const action = config.action;
  if (action.kind !== 'script') return;
  const safePath = (value: string) => value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(p => p !== '..' && p !== '.' && p !== '');
  if (!safePath(action.entrypoint)) throw new DomainError('invalid_script_path', 'Script entrypoint must be a relative bundle path', 400);
  const seen = new Set<string>(); let bytes = Buffer.byteLength(action.content) + Buffer.byteLength(action.setup);
  for (const file of action.files) { if (!safePath(file.path) || seen.has(file.path)) throw new DomainError('invalid_script_path', 'Bundle paths must be unique safe relative paths', 400); seen.add(file.path); bytes += Buffer.byteLength(file.content); }
  if (bytes > 8 * 1024 * 1024) throw new DomainError('script_bundle_too_large', 'Script snapshot exceeds 8 MiB', 400);
  if (action.files.length && !seen.has(action.entrypoint)) throw new DomainError('script_entrypoint_missing', 'Entrypoint must exist in frozen bundle files', 400);
  if (!action.files.length && !action.content.trim()) throw new DomainError('script_content_missing', 'Script bytes must be included; a bundle reference alone is not executable', 400);
}
export async function enqueueStudioExecution(sql: SqlExecutor, row: StudioDefinitionRow, input: { requestId: string; trigger: StudioExecution['trigger']; payload?: Record<string, unknown>; sourceKey?: string; dueAt?: Date }): Promise<StudioExecution> {
  const result = await sql.query<StudioExecutionRow>('INSERT INTO automation_studio_executions(id,workspace_id,actor_id,definition_id,project_id,definition_revision,config_snapshot,request_id,trigger,payload,source_key,due_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12) ON CONFLICT(definition_id,source_key) DO NOTHING RETURNING *', [randomUUID(), row.workspace_id, row.actor_id, row.id, row.project_id, row.revision, JSON.stringify(row.config), input.requestId, input.trigger, input.payload === undefined ? null : JSON.stringify(input.payload), input.sourceKey ?? null, input.dueAt ?? null]);
  const execution = result.rows[0] ?? (await sql.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE definition_id=$1 AND source_key=$2', [row.id, input.sourceKey])).rows[0]!;
  if (result.rows[0]) await appendStudioEvent(sql, execution.id, 'queued', `${input.trigger} execution queued; configuration revision ${row.revision} frozen`);
  return studioExecutionDto(execution);
}
/** Caller holds the workspace lock. Event receipt and queue intent commit atomically. */
export async function enqueueAutomationStudioEvent(sql: SqlExecutor, core: NotificationCorePort, input: { workspaceId: string; actorId: string; definitionId: string; eventId: string; payload: Record<string, unknown>; source: string; key: string }): Promise<StudioExecution> {
  const actor: Actor = { id: input.actorId, name: '', email: '' };
  const row = (await sql.query<StudioDefinitionRow>('SELECT * FROM automation_studio_definitions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND deleted_at IS NULL FOR UPDATE', [input.definitionId, input.workspaceId, input.actorId])).rows[0];
  if (!row || row.status !== 'enabled' || row.config.trigger.kind !== 'event' || row.config.trigger.source !== input.source || row.config.trigger.key !== input.key) throw new DomainError('automation_event_not_available', 'Enabled automation does not accept this event source and key', 409);
  await studioAuthorize(sql, core, actor, input.workspaceId, row.project_id, true);
  return enqueueStudioExecution(sql, row, { requestId: randomUUID(), trigger: 'event', payload: input.payload, sourceKey: 'event:' + input.eventId });
}
