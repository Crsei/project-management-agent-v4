import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../domain/src/core.ts';
import { DomainError } from '../../domain/src/core.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import type { SqlExecutor } from './ports.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { authorizeAutomationProject, automationSnapshot } from './automation-report.ts';
import { getMembership } from './access.ts';
import { requestHash } from './kernel.ts';
import type { AutomationIntegrationReceipt } from '../../contracts/src/automation-integrations.ts';
import { assertAutomationIntegrationsAvailable } from '../../infrastructure/src/automation-integrations.ts';
export type AutomationIntegrationContext = { database: () => Pool; core: NotificationCorePort };
export async function authorizeAutomationIntegration(sql: SqlExecutor, context: AutomationIntegrationContext, actor: Actor, workspaceId: string, projectId: string, write = false, active = write): Promise<void> {
  await authorizeAutomationProject(sql, actor, workspaceId, projectId, await automationSnapshot(context.core, workspaceId), write, active);
}
export async function readAutomationIntegration<T>(context: AutomationIntegrationContext, actor: Actor, workspaceId: string, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
  const sql = await context.database().connect();
  try {
    await sql.query('BEGIN READ ONLY'); await lockWorkspace(sql, workspaceId);
    const member = await getMembership(sql, actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    const result = await operation(sql); await sql.query('COMMIT'); return result;
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
}
type ReceiptRow = { request_hash: string; project_ids: string[]; http_status: number; result: unknown };
export async function readAutomationIntegrationReceipt(sql: SqlExecutor, context: AutomationIntegrationContext, actor: Actor, workspaceId: string, requestId: string): Promise<AutomationIntegrationReceipt | null> {
  const row = (await sql.query<ReceiptRow>('SELECT * FROM automation_integration_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
  if (!row) return null;
  for (const projectId of row.project_ids) await authorizeAutomationIntegration(sql, context, actor, workspaceId, projectId);
  return { requestId, result: row.result, httpStatus: row.http_status };
}
/** Mutations and their immutable receipt commit under the existing workspace authorization lock. */
export async function mutateAutomationIntegration<T>(context: AutomationIntegrationContext, actor: Actor, workspaceId: string, input: { requestId: string; [key: string]: unknown }, projects: string[], operation: (sql: PoolClient) => Promise<T>): Promise<T> {
  const sql = await context.database().connect(); let result: unknown; let status = 200;
  try {
    await sql.query('BEGIN'); await assertAutomationIntegrationsAvailable(sql); await lockWorkspace(sql, workspaceId); await getMembership(sql, actor, workspaceId);
    const prior = (await sql.query<ReceiptRow>('SELECT * FROM automation_integration_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, input.requestId])).rows[0];
    if (prior) {
      for (const projectId of prior.project_ids) await authorizeAutomationIntegration(sql, context, actor, workspaceId, projectId);
      if (prior.request_hash !== requestHash(input)) throw new DomainError('idempotency_conflict', 'Request ID already represents a different integration operation', 409);
      result = prior.result; status = prior.http_status;
    } else {
      await sql.query('SAVEPOINT integration_mutation');
      try { result = await operation(sql); }
      catch (error) { if (!(error instanceof DomainError)) throw error; await sql.query('ROLLBACK TO SAVEPOINT integration_mutation'); status = error.status; result = { error: { code: error.code, message: error.message } }; }
      await sql.query('RELEASE SAVEPOINT integration_mutation');
      await sql.query('INSERT INTO automation_integration_receipts(workspace_id,actor_id,request_id,request_hash,project_ids,http_status,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [workspaceId, actor.id, input.requestId, requestHash(input), projects, status, JSON.stringify(result)]);
    }
    await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  if (status !== 200) { const rejected = result as { error: { code: string; message: string } }; throw new DomainError(rejected.error.code, rejected.error.message, status); }
  return result as T;
}
