import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { studioExecutionResultSchema, studioRequiredProviderToolFeature, type StudioExecutionPort, type StudioExecutionResult } from '../../contracts/src/automation-studio.ts';
import type { AutomationIntegrationConfig, AutomationIntegrationVerification } from '../../contracts/src/automation-integrations.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { nextStudioDue, studioMissed, studioTimezone } from './automation-studio-schedule.ts';
import { appendStudioEvent, enqueueStudioExecution, studioAuthorize, studioClock, studioExecutionRequest, studioIntegrationSupportsAction, type StudioDefinitionRow, type StudioExecutionRow } from './automation-studio-store.ts';

/** Persist dispatch intent before transport; a lost reply can only be queried, never dispatched again. */
export async function reconcileStudioExecution(pool: Pool, core: NotificationCorePort, runtime: StudioExecutionPort, id: string, allowDispatch = false): Promise<boolean> {
  const candidate = (await pool.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE id=$1 AND finished_at IS NULL', [id])).rows[0];
  if (!candidate) return false;
  let providerRejection: string | null = null;
  const requiredFeature = !candidate.dispatched_at && allowDispatch ? studioRequiredProviderToolFeature(candidate.config_snapshot) : null;
  if (requiredFeature) {
    try {
      await studioAuthorize(pool, core, { id: candidate.actor_id, email: '', name: '' }, candidate.workspace_id, candidate.project_id, true);
      const capabilities = await runtime.capabilities({ actorId: candidate.actor_id, workspaceId: candidate.workspace_id, projectId: candidate.project_id });
      if (!capabilities.features?.some(feature => feature.id === requiredFeature && feature.available)) providerRejection = 'provider_tool_protocol_unavailable';
    } catch (error) { providerRejection = error instanceof DomainError ? error.code : 'provider_tool_capabilities_unavailable'; }
  }
  const sql = await pool.connect(); let claimed: StudioExecutionRow | undefined; let operation: 'dispatch' | 'query' | 'cancel' = 'query'; const lease = randomUUID();
  try {
    await sql.query('BEGIN'); await lockWorkspace(sql, candidate.workspace_id);
    const row = (await sql.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE id=$1 AND finished_at IS NULL AND (lease_until IS NULL OR lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED', [id])).rows[0];
    if (!row || !allowDispatch && !row.dispatched_at) { await sql.query('COMMIT'); return false; }
    const actor: Actor = { id: row.actor_id, name: '', email: '' }; const now = await studioClock(sql);
    let rejection: string | null = row.dispatched_at ? null : providerRejection;
    try {
      await studioAuthorize(sql, core, actor, row.workspace_id, row.project_id, true, !row.dispatched_at);
      if (!row.dispatched_at) {
        const definition = (await sql.query<StudioDefinitionRow>('SELECT * FROM automation_studio_definitions WHERE id=$1 FOR UPDATE', [row.definition_id])).rows[0];
        if (!definition || definition.deleted_at || (row.trigger === 'scheduled' || row.trigger === 'event') && (definition.revision !== row.definition_revision || definition.status !== 'enabled')) rejection = 'definition_changed_or_inactive';
        for (const plugin of row.config_snapshot.action.plugins) {
          if (!plugin.id.startsWith('integration:')) continue;
          const connectionId = plugin.id.slice('integration:'.length);
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) { rejection ??= 'integration_reference_invalid'; continue; }
          const connection = (await sql.query<{ revision: number; status: string; config: AutomationIntegrationConfig; verification: AutomationIntegrationVerification }>('SELECT revision,status,config,verification FROM automation_integration_connections WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND project_id=$4', [connectionId, row.workspace_id, row.actor_id, row.project_id])).rows[0];
          if (!connection || connection.status !== 'verified' || plugin.version !== String(connection.revision)) rejection ??= 'integration_connection_changed_or_unavailable';
          else if (!studioIntegrationSupportsAction(connection.config, connection.verification, row.config_snapshot.action.kind)) rejection ??= 'integration_mechanism_unavailable_for_action';
        }
        const budgetConfig = definition?.config ?? row.config_snapshot;
        const budget = (await sql.query<{ consumed: string; last_at: Date | null }>('SELECT count(*) FILTER(WHERE (started_at AT TIME ZONE $2)::date=($3::timestamptz AT TIME ZONE $2)::date)::text AS consumed,max(started_at) AS last_at FROM automation_studio_executions WHERE definition_id=$1 AND budget_consumed', [row.definition_id, studioTimezone(budgetConfig), now])).rows[0]!;
        if (Number(budget.consumed) >= budgetConfig.dailyLimit) rejection ??= 'daily_limit';
        if (budget.last_at && now.getTime() < budget.last_at.getTime() + budgetConfig.cooldownMinutes * 60000) rejection ??= 'cooldown';
      }
    } catch (error) { if (!(error instanceof DomainError)) throw error; rejection = error.code; }
    if (rejection) {
      const status = row.dispatched_at ? 'outcome_unknown' : 'skipped';
      await appendStudioEvent(sql, row.id, 'error', `${rejection}; ${row.dispatched_at ? 'original external outcome remains unknown; no redispatch' : 'no external dispatch'}`);
      await sql.query('UPDATE automation_studio_executions SET status=$2,error=$3,summary=$4,finished_at=CASE WHEN $2=\'skipped\' THEN $5::timestamptz ELSE NULL END,next_query_at=$5::timestamptz+interval \'30 seconds\',lease_until=NULL,lease_token=NULL WHERE id=$1', [row.id, status, rejection, `Execution ${status}: ${rejection}`, now]);
      await sql.query('COMMIT'); return true;
    }
    operation = row.status === 'cancel_requested' ? 'cancel' : row.dispatched_at ? 'query' : 'dispatch';
    if (operation === 'dispatch') {
      await appendStudioEvent(sql, row.id, 'dispatch', 'Dispatch intent committed; an uncertain outcome is reconciled by execution identity only');
      await sql.query('UPDATE automation_studio_definitions SET last_run_at=$2 WHERE id=$1', [row.definition_id, now]);
    }
    claimed = (await sql.query<StudioExecutionRow>('UPDATE automation_studio_executions SET status=CASE WHEN $2=\'dispatch\' THEN \'running\' ELSE status END,dispatched_at=CASE WHEN $2=\'dispatch\' THEN $3 ELSE dispatched_at END,started_at=CASE WHEN $2=\'dispatch\' THEN $3 ELSE started_at END,budget_consumed=budget_consumed OR $2=\'dispatch\',lease_token=$4,lease_until=$3+interval \'45 seconds\' WHERE id=$1 RETURNING *', [row.id, operation, now, lease])).rows[0]!;
    await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  if (!claimed) return false;
  let result: StudioExecutionResult;
  try { result = studioExecutionResultSchema.parse(await runtime[operation](studioExecutionRequest(claimed))); }
  catch { result = { status: 'outcome_unknown', externalExecutionId: claimed.external_execution_id, threadId: claimed.thread_id, error: 'runtime_transport_unknown', summary: 'Runtime outcome is unknown. The original execution is queried, never redispatched.', logs: [] }; }
  // Transport has settled before acquiring a connection or lock again.
  const finish = await pool.connect();
  try {
    await finish.query('BEGIN'); await lockWorkspace(finish, claimed.workspace_id);
    const current = (await finish.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE id=$1 AND lease_token=$2 AND finished_at IS NULL FOR UPDATE', [id, lease])).rows[0];
    if (current) {
      for (const log of result.logs) await appendStudioEvent(finish, id, 'log', log.message, log.stream, log.id, log.at);
      const status = current.status === 'cancel_requested' && (result.status === 'running' || result.status === 'outcome_unknown') ? 'cancel_requested' : result.status;
      await appendStudioEvent(finish, id, 'status', `${status}: ${result.summary}`);
      const terminal = ['completed','failed','cancelled'].includes(status);
      await finish.query('UPDATE automation_studio_executions SET status=$3,external_execution_id=coalesce($4,external_execution_id),thread_id=coalesce($5,thread_id),summary=$6,error=$7,finished_at=CASE WHEN $8 THEN clock_timestamp() ELSE NULL END,lease_token=NULL,lease_until=NULL,next_query_at=clock_timestamp()+interval \'5 seconds\' WHERE id=$1 AND lease_token=$2', [id, lease, status, result.externalExecutionId, result.threadId, result.summary, result.error, terminal]);
    }
    await finish.query('COMMIT');
  } catch (error) { await finish.query('ROLLBACK'); throw error; } finally { finish.release(); }
  return true;
}
export async function runAutomationStudioBatch(pool: Pool, core: NotificationCorePort, runtime: StudioExecutionPort, workerId: string, options: { limit?: number; now?: Date } = {}): Promise<{ scheduled: number; processed: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 10)); let scheduled = 0, processed = 0;
  const due = (await pool.query<{ id: string; workspace_id: string }>("SELECT id,workspace_id FROM automation_studio_definitions WHERE status='enabled' AND deleted_at IS NULL AND next_due_at<=coalesce($2::timestamptz,clock_timestamp()) ORDER BY next_due_at,id LIMIT $1", [limit, options.now ?? null])).rows;
  for (const candidate of due) {
    const sql = await pool.connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, candidate.workspace_id); const now = options.now ?? await studioClock(sql);
      const row = (await sql.query<StudioDefinitionRow>("SELECT * FROM automation_studio_definitions WHERE id=$1 AND status='enabled' AND deleted_at IS NULL AND next_due_at<=$2 FOR UPDATE SKIP LOCKED", [candidate.id, now])).rows[0];
      if (row?.next_due_at) {
        const execution = await enqueueStudioExecution(sql, row, { requestId: randomUUID(), trigger: 'scheduled', sourceKey: 'scheduled:' + row.next_due_at.toISOString(), dueAt: row.next_due_at });
        if (studioMissed(row.config, row.next_due_at, now)) { await appendStudioEvent(sql, execution.id, 'status', 'Elapsed local date coalesced into one skipped execution; no backlog dispatch'); await sql.query("UPDATE automation_studio_executions SET status='skipped',finished_at=$2,error='schedule_missed',summary='Missed schedule; no backlog dispatch' WHERE id=$1 AND finished_at IS NULL", [execution.id, now]); }
        await sql.query('UPDATE automation_studio_definitions SET next_due_at=$2 WHERE id=$1', [row.id, nextStudioDue(row.config, now)]); scheduled++;
      }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  const queue = (await pool.query<{ id: string }>('SELECT id FROM automation_studio_executions WHERE finished_at IS NULL AND next_query_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_query_at,id LIMIT $1', [limit])).rows;
  for (const row of queue) if (await reconcileStudioExecution(pool, core, runtime, row.id, true)) processed++;
  await pool.query('INSERT INTO automation_studio_heartbeats(worker_id) VALUES($1) ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=clock_timestamp()', [workerId]);
  return { scheduled, processed };
}
