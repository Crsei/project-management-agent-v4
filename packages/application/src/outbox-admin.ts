import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { SqlExecutor } from './ports.ts';

export type OutboxFailure = { eventId: string; type: string; attempts: number; safeError: 'publish_failed' };
export type OutboxRetry = { workspace: string; count: number };
export type RecordOutboxRetry = (operation: OutboxRetry) => Promise<void>;

function workspaceId(input: string): string {
  const parsed = z.uuid().toLowerCase().safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed', 'Workspace ID must be a UUID');
  return parsed.data;
}

async function assertWorkspace(sql: SqlExecutor, id: string): Promise<void> {
  const result = await sql.query('SELECT id FROM workspaces WHERE id=$1', [id]);
  if (!result.rowCount) throw new DomainError('workspace_not_found', 'Workspace does not exist', 404);
}

/** Local operator access uses the configured database authority, never an HTTP principal. */
export async function listOutboxFailures(pool: Pool, input: string): Promise<OutboxFailure[]> {
  const id = workspaceId(input);
  await assertWorkspace(pool, id);
  // Raw errors and payloads are deliberately never fetched into the diagnostic result.
  const result = await pool.query<{ event_id: string; event_type: string; attempts: number }>(
    'SELECT event_id,event_type,attempts FROM outbox WHERE workspace_id=$1 AND published_at IS NULL AND attempts>0 ORDER BY id', [id]);
  return result.rows.map(row => ({ eventId: row.event_id, type: row.event_type, attempts: row.attempts, safeError: 'publish_failed' }));
}

/**
 * A retry only makes existing rows eligible again. Publication retains their
 * IDs, ordering and original business receipts. The operator must durably
 * record the prepared operation before the transaction is allowed to commit.
 */
export async function retryFailedOutbox(pool: Pool, input: string, record: RecordOutboxRetry): Promise<OutboxRetry> {
  const id = workspaceId(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWorkspace(client, id);
    await assertWorkspace(client, id);
    const result = await client.query('UPDATE outbox SET attempts=0 WHERE workspace_id=$1 AND published_at IS NULL AND attempts>0', [id]);
    const operation = { workspace: id, count: result.rowCount ?? 0 };
    await record(operation);
    await client.query('COMMIT');
    return operation;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
