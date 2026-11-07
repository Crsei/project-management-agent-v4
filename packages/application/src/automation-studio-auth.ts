import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { isPmAutomationTemplateId } from '../../contracts/src/automation-pm.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { studioAuthorize, type StudioExecutionRow } from './automation-studio-store.ts';

export type StudioServiceIdentity = { actorId: string; workspaceId: string; projectId: string; executionId: string; requestId: string; definitionId: string; definitionRevision: number };
/** A dedicated service bearer is not a PM user session; PM analysis may only freeze/read sources and publish its bound result. */
export async function authorizeAutomationStudioService(pool: Pool, core: NotificationCorePort, identity: StudioServiceIdentity, request: { method: string; url: string; body: unknown }): Promise<Actor> {
  const url = new URL(request.url, 'http://pm.invalid');
  const base = `/api/v1/workspaces/${identity.workspaceId}/agent-tools`;
  const pmBase = `/api/v1/workspaces/${identity.workspaceId}/automations/pm/executions/${identity.executionId}`;
  const pmAnalysisEndpoint = !url.search && (url.pathname === pmBase + '/snapshot' || url.pathname === pmBase + '/result') && (request.method === 'GET' || request.method === 'POST');
  let allowed = pmAnalysisEndpoint;
  if (request.method === 'POST' && !url.search && url.pathname === '/api/v1/agent-contexts/authorize') {
    const body = request.body as { workspaceId?: unknown; projectId?: unknown } | null;
    allowed = body?.workspaceId === identity.workspaceId && body.projectId === identity.projectId;
  } else if (request.method === 'GET' && (url.pathname === base || url.pathname === '/api/v1/agent-tools') && !url.search) allowed = true;
  else if (request.method === 'GET' && url.pathname === base + '/core-files') allowed = url.searchParams.get('projectId') === identity.projectId && [...url.searchParams.keys()].every(key => key === 'projectId');
  else if (request.method === 'POST' && (url.pathname === base + '/call' || url.pathname === base + '/result') && !url.search) {
    const body = request.body as { target?: { workspaceId?: unknown; projectId?: unknown } } | null;
    allowed = body?.target?.workspaceId === identity.workspaceId && body.target.projectId === identity.projectId;
  }
  if (!allowed) throw new DomainError('automation_service_scope_forbidden', 'Automation service identity cannot authorize this PM endpoint or scope', 403);
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN'); await lockWorkspace(sql, identity.workspaceId);
    const execution = (await sql.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [identity.executionId, identity.workspaceId, identity.actorId])).rows[0];
    if (!execution || execution.project_id !== identity.projectId || execution.request_id !== identity.requestId || execution.definition_id !== identity.definitionId || execution.definition_revision !== identity.definitionRevision || !execution.dispatched_at || execution.finished_at || execution.status === 'cancel_requested') throw new DomainError('automation_execution_not_authorized', 'Original automation execution is not currently authorized for new PM operations', 403);
    const action = execution.config_snapshot.action;
    const pmAnalysis = action.kind === 'template' && isPmAutomationTemplateId(action.templateId);
    if (pmAnalysisEndpoint !== pmAnalysis && (pmAnalysisEndpoint || url.pathname !== '/api/v1/agent-contexts/authorize')) throw new DomainError('automation_service_scope_forbidden', 'PM analysis service grants cannot authorize PM tools or another template result', 403);
    const actor = (await sql.query<Actor>('SELECT id,email,name FROM users WHERE id=$1 AND disabled_at IS NULL', [identity.actorId])).rows[0];
    if (!actor) throw new DomainError('unauthenticated', 'Automation actor is no longer active', 401);
    await studioAuthorize(sql, core, actor, identity.workspaceId, identity.projectId, true);
    await sql.query('COMMIT'); return actor;
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
}
