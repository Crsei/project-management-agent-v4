import type { Pool } from 'pg';
import { lockWorkspace } from '../../infrastructure/src/database.ts';

export async function publishOutboxBatch(pool: Pool, limit = 100) {
  const workspaces = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM outbox WHERE published_at IS NULL GROUP BY workspace_id HAVING max(attempts)<10 ORDER BY min(id) LIMIT 20');
  let published = 0;
  for (const { workspace_id: workspaceId } of workspaces.rows) {
    const client = await pool.connect();
    let failedIds: string[] = [];
    try {
      await client.query('BEGIN');
      await lockWorkspace(client, workspaceId);
      const selected = await client.query(
        'SELECT * FROM outbox WHERE workspace_id=$1 AND published_at IS NULL ORDER BY id LIMIT $2 FOR UPDATE', [workspaceId, limit]);
      failedIds = selected.rows.map((row) => String(row.id));
      let count = 0;
      for (const row of selected.rows) {
        const existing = await client.query('SELECT cursor FROM events WHERE event_id=$1', [row.event_id]);
        if (!existing.rowCount) {
          const head = await client.query<{ cursor: string }>('UPDATE workspaces SET stream_cursor=stream_cursor+1 WHERE id=$1 RETURNING stream_cursor::text AS cursor', [workspaceId]);
          const envelope = {
            eventId: row.event_id, eventType: row.event_type, schemaVersion: 1, workspaceId,
            projectId: row.project_id, aggregateId: row.aggregate_id, aggregateKind: row.aggregate_kind,
            aggregateVersion: row.aggregate_version, eventSequence: String(row.aggregate_sequence),
            occurredAt: new Date(row.created_at).toISOString(), actorRef: { principalId: row.actor_id, principalType: 'human' },
            causationId: row.command_id, payload: row.payload,
          };
          await client.query('INSERT INTO events(workspace_id,cursor,event_id,envelope,audience_actor_id) VALUES($1,$2,$3,$4,$5)', [workspaceId, head.rows[0]!.cursor, row.event_id, envelope, row.audience_actor_id]);
        }
        await client.query('UPDATE outbox SET published_at=now(),last_error=NULL WHERE id=$1', [row.id]);
        count++;
      }
      await client.query('COMMIT');
      published += count;
    } catch (error) {
      await client.query('ROLLBACK');
      if (failedIds.length) await pool.query('UPDATE outbox SET attempts=attempts+1,last_error=$2 WHERE id=ANY($1::bigint[]) AND published_at IS NULL', [failedIds, 'publish_failed']);
      throw error;
    } finally { client.release(); }
  }
  return published;
}

export async function recordHeartbeat(pool: Pool, id: string, details: Record<string, unknown> = {}) {
  await pool.query("INSERT INTO service_heartbeats(id,role,heartbeat_at,details) VALUES($1,'worker',now(),$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,details=excluded.details", [id, details]);
}

export async function pruneEventHistory(pool: Pool, days: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workspaces = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
    // Acquire in the same deterministic order to avoid conflicting maintenance cycles.
    for (const workspace of workspaces.rows) {
      await lockWorkspace(client, workspace.id);
      await client.query("DELETE FROM events WHERE workspace_id=$1 AND created_at < now()-($2::int * interval '1 day')", [workspace.id, days]);
    }
    await client.query('DELETE FROM sessions WHERE expires_at<now()');
    await client.query("DELETE FROM service_heartbeats WHERE heartbeat_at<now()-interval '1 day'");
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
