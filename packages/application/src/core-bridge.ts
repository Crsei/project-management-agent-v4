import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor, type Command, type CommandReceipt } from '../../domain/src/core.ts';
import { getMembership } from './access.ts';
import { assertReceiptReadable, requestHash } from './kernel.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { appendProjectAudit, type ProjectAuditWrite } from './project-audit.ts';
import { insertServiceFact, type CapturedServiceFact } from './service-facts.ts';

export { requestHash };

const uuid = z.uuid().toLowerCase();

type StoredExternalReceipt = {
  receipt: CommandReceipt;
  request_hash: string;
  command_type: string;
  scope_project_ids: string[];
  workspace_scope: number;
  actor_scope: number;
};


// A project or work-item result carries its project scope; lifecycle commands
// without a result fall back to the command envelope. Unknown scope is treated
// as workspace scope so a project-scoped member cannot read another project's
// receipt by guessing an object ID.
function externalReceiptScope(command: Command, receipt: CommandReceipt): { projectIds: string[]; workspaceScope: boolean } {
  if (command.commandType === 'CreateProject') return { projectIds: [], workspaceScope: true };
  const result = receipt.status === 'committed' ? receipt.result : undefined;
  if (result && typeof result === 'object' && !Array.isArray(result) && 'id' in result) {
    if (typeof result.id === 'string' && 'kind' in result && ['project', 'work_item', 'milestone'].includes(String(result.kind))) {
      if (result.kind === 'project') return { projectIds: [result.id], workspaceScope: false };
      if ('projectId' in result && typeof result.projectId === 'string' && result.projectId) return { projectIds: [result.projectId], workspaceScope: false };
    }
  }
  if (typeof command.projectId === 'string' && command.projectId) return { projectIds: [command.projectId], workspaceScope: false };
  // A rejected project lifecycle command still touches exactly its project target.
  if (typeof command.targetId === 'string' && command.targetId) {
    if (['UpdateProject', 'ActivateProject', 'CompleteProject', 'CancelProject', 'ReopenProject'].includes(command.commandType)) return { projectIds: [command.targetId], workspaceScope: false };
    if (['ArchiveObject', 'RestoreArchivedObject'].includes(command.commandType) && command.payload.kind === 'project') return { projectIds: [command.targetId], workspaceScope: false };
  }
  return { projectIds: [], workspaceScope: true };
}

/** Return a previously committed/rejected external receipt, or null when none exists. */
export async function readExternalReceipt(pool: Pool, actor: Actor, workspaceId: string, commandId: string, hash: string): Promise<CommandReceipt | null> {
  if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(commandId).success) throw new DomainError('validation_failed', 'Invalid identifier');
  workspaceId = workspaceId.toLowerCase();
  commandId = commandId.toLowerCase();
  await getMembership(pool, actor, workspaceId);
  const result = await pool.query<StoredExternalReceipt>('SELECT receipt,request_hash,command_type,scope_project_ids,workspace_scope,actor_scope FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [workspaceId, actor.id, commandId]);
  const row = result.rows[0];
  if (!row) return null;
  await assertReceiptReadable(pool, actor, workspaceId, row);
  if (row.request_hash !== hash) throw new DomainError('command_id_conflict', 'Command ID already represents a different request', 409);
  return row.receipt;
}

/** Persist an external command receipt with the same request hash algorithm as the kernel. */
export async function recordExternalReceipt(pool: Pool, actor: Actor, workspaceId: string, command: Command, receipt: CommandReceipt, affectedProjectIds: readonly string[] = [], audit: readonly ProjectAuditWrite[] = [], facts: readonly CapturedServiceFact[] = []): Promise<void> {
  if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(command.commandId).success) throw new DomainError('validation_failed', 'Workspace and command IDs must be UUIDs');
  workspaceId = workspaceId.toLowerCase();
  const hash = requestHash(command as unknown as Record<string, unknown>);
  const scope = externalReceiptScope(command, receipt);
  if (affectedProjectIds.length > 0 && command.commandType !== 'CreateProject') {
    scope.projectIds = [...new Set([...scope.projectIds, ...affectedProjectIds])];
    scope.workspaceScope = false;
  }
  if (audit.some(entry => entry.source !== 'command' || entry.commandId !== command.commandId || entry.action !== command.commandType)
    || receipt.status !== 'committed' && audit.length > 0) throw new DomainError('audit_receipt_mismatch', 'Audit facts must describe the committed command', 500);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWorkspace(client, workspaceId);
    await getMembership(client, actor, workspaceId);
    const prior = await client.query<StoredExternalReceipt>('SELECT receipt,request_hash,command_type,scope_project_ids,workspace_scope,actor_scope FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [workspaceId, actor.id, command.commandId.toLowerCase()]);
    if (prior.rows[0]) {
      await assertReceiptReadable(client, actor, workspaceId, prior.rows[0]);
      if (prior.rows[0].request_hash !== hash) throw new DomainError('command_id_conflict', 'Command ID already represents a different request', 409);
      if (requestHash({ receipt: prior.rows[0].receipt }) !== requestHash({ receipt })) throw new DomainError('command_receipt_conflict', 'A different durable result already exists for this command', 409);
    } else {
      await client.query(`INSERT INTO command_receipts(workspace_id,actor_id,command_id,command_type,request_hash,project_id,scope_project_ids,workspace_scope,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [workspaceId, actor.id, command.commandId.toLowerCase(), command.commandType || 'invalid', hash,
        typeof command.projectId === 'string' && command.projectId ? command.projectId : null,
        scope.projectIds, scope.workspaceScope ? 1 : 0, JSON.stringify(receipt)]);
    }
    await appendProjectAudit(client, workspaceId, actor, audit);
    for (const fact of facts) await insertServiceFact(client, workspaceId, fact);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
