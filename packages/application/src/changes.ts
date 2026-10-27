import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { requireCapability } from './access.ts';
import { requireDashboardReadSelf } from './dashboard-read.ts';

export type ChangeNotification = {
  eventId: string; eventType: string; workspaceId: string; projectId: string | null;
  aggregateId: string; aggregateKind: string; aggregateVersion: number; occurredAt: string;
};
export async function readChanges(pool: Pool, actor: Actor, workspaceId: string, after: string, projectId?: string) {
  if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) throw new DomainError('invalid_cursor');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWorkspace(client, workspaceId);
    const membership = await requireDashboardReadSelf({ sql: client, actor, workspaceId });
    if (projectId) await requireCapability(client, actor, workspaceId, 'domain.read', projectId);
    const result = await client.query<{ head: string; oldest: string | null }>(
      'SELECT stream_cursor::text AS head,(SELECT min(cursor)::text FROM events WHERE workspace_id=$1) AS oldest FROM workspaces WHERE id=$1', [workspaceId]);
    const row = result.rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', undefined, 404);
    if (BigInt(after) > BigInt(row.head)) throw new DomainError('invalid_cursor', 'Cursor is ahead of this workspace stream', 409);
    const oldest = row.oldest === null ? BigInt(row.head) + 1n : BigInt(row.oldest);
    if (BigInt(after) + 1n < oldest) throw new DomainError('cursor_expired', 'Reload an authorized entity snapshot before subscribing again', 410, { head: row.head });
    const events = await client.query<{ cursor: string; envelope: ChangeNotification; audience_actor_id: string | null }>(
      'SELECT cursor::text,envelope,audience_actor_id FROM events WHERE workspace_id=$1 AND cursor>$2::bigint ORDER BY events.cursor LIMIT 200', [workspaceId, after]);
    await client.query('COMMIT');
    const notifications = events.rows.filter((event) => {
      if (event.audience_actor_id !== null && event.audience_actor_id !== actor.id) return false;
      if (projectId && event.envelope.projectId !== projectId) return false;
      if (event.envelope.eventType === 'WorkspaceIdentityUpdated' && event.envelope.aggregateKind === 'workspace_identity' && event.envelope.aggregateId === workspaceId && event.envelope.workspaceId === workspaceId && event.envelope.projectId === null) return true;
      if (membership.projectIds === null) return true;
      if (event.envelope.projectId) return membership.projectIds.includes(event.envelope.projectId);
      return event.audience_actor_id === actor.id;
    }).map((event) => {
      // SSE is an invalidation channel, not an unrestricted audit/event payload API.
      const source = event.envelope;
      return { cursor: event.cursor, event: {
        eventId: source.eventId, eventType: source.eventType, workspaceId: source.workspaceId,
        projectId: source.projectId, aggregateId: source.aggregateId, aggregateKind: source.aggregateKind,
        aggregateVersion: source.aggregateVersion, occurredAt: source.occurredAt,
      } };
    });
    return { events: notifications, cursor: events.rows.at(-1)?.cursor ?? after, head: row.head };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
