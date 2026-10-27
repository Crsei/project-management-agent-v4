import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor, Entity, EntityKind } from '../../domain/src/core.ts';
import { assertProjectScope, getMembership, requireCapability } from './access.ts';
import { entityFromRow, entityProject } from './kernel.ts';
import type { EntityRow } from './kernel.ts';
import type { SqlExecutor } from './ports.ts';
import type { WorkspaceIcon, WorkspaceColor } from '../../domain/src/workspace-identity.ts';

async function readSnapshot<T>(pool: Pool, read: (sql: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function listWorkspaces(pool: Pool, actor: Actor): Promise<{ id: string; name: string; icon: WorkspaceIcon; color: WorkspaceColor; identityVersion: number; ownerId: string; capabilities: string[]; projectIds: string[] | null; version: number; cursor: string }[]> {
  const result = await pool.query<{ id: string; name: string; icon: WorkspaceIcon; color: WorkspaceColor; identity_version: number; owner_id: string; capabilities: string[]; project_ids: string[] | null; version: number; stream_cursor: string }>('SELECT w.id,w.name,w.icon,w.color,w.identity_version,w.owner_id,w.stream_cursor,m.capabilities,m.project_ids,m.version FROM workspaces w JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL ORDER BY w.created_at,w.id', [actor.id]);
  return result.rows.map((row) => ({ id: row.id, name: row.name, icon: row.icon, color: row.color, identityVersion: row.identity_version, ownerId: row.owner_id, capabilities: row.capabilities, projectIds: row.project_ids, version: row.version, cursor: row.stream_cursor }));
}

export async function readEntity(pool: Pool, actor: Actor, workspaceId: string, id: string): Promise<Entity> {
  if (!z.uuid().safeParse(workspaceId).success || !z.uuid().safeParse(id).success) throw new DomainError('validation_failed', 'Invalid entity ID');
  workspaceId = workspaceId.toLowerCase();
  id = id.toLowerCase();
  return readSnapshot(pool, async (sql) => {
    await getMembership(sql, actor, workspaceId);
    const result = await sql.query<EntityRow>('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2', [workspaceId, id]);
    if (!result.rows[0]) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
    const entity = entityFromRow(result.rows[0]);
    await requireCapability(sql, actor, workspaceId, 'domain.read', entityProject(entity));
    return entity;
  });
}

export async function listEntities(pool: Pool, actor: Actor, workspaceId: string, options: { kind: EntityKind; projectId?: string; limit?: number; after?: string; visibility?: 'visible' | 'hidden' | 'all' }): Promise<{ items: Entity[]; nextCursor: string | null; cursor: string }> {
  const parsed = z.object({ kind: z.enum(['project','work_item','milestone','conversation','intent','decision','upload','artifact','artifact_version','evidence','submission','review']), projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(), limit: z.number().int().min(1).max(200).optional(), after: z.string().max(1024).optional(), visibility: z.enum(['visible','hidden','all']).optional() }).strict().safeParse(options);
  if (!z.uuid().safeParse(workspaceId).success || !parsed.success) throw new DomainError('validation_failed', 'Invalid list query');
  workspaceId = workspaceId.toLowerCase();
  options = { ...options, ...(options.projectId ? { projectId: options.projectId } : {}) };
  const visibility = options.visibility ?? 'visible';
  if (visibility !== 'visible' && options.kind !== 'artifact' && options.kind !== 'artifact_version') throw new DomainError('validation_failed', 'Visibility is only supported for artifacts and artifact versions');
  let afterId: string | null = null;
  if (options.after) {
    try {
      const value = JSON.parse(Buffer.from(options.after, 'base64url').toString('utf8')) as { id: string; kind: string; projectId: string | null; visibility?: string };
      if (!z.uuid().safeParse(value.id).success || value.kind !== options.kind || value.projectId !== (options.projectId ?? null) || value.visibility !== visibility) throw new Error('cursor mismatch');
      afterId = value.id;
    } catch { throw new DomainError('validation_failed', 'Pagination cursor does not match this query'); }
  }
  const limit = options.limit ?? 50;
  return readSnapshot(pool, async (sql) => {
    const member = await getMembership(sql, actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    if (options.projectId) assertProjectScope(member, options.projectId);
    const result = await sql.query<EntityRow>(`SELECT e.* FROM entities e WHERE e.workspace_id=$1 AND e.kind=$2
      AND ($3::text IS NULL OR e.project_id=$3 OR (e.kind='project' AND e.id::text=$3))
      AND ($4::text[] IS NULL OR e.project_id=ANY($4) OR (e.kind='project' AND e.id::text=ANY($4)))
      AND ($5::uuid IS NULL OR e.id>$5)
      AND (e.kind NOT IN ('artifact','artifact_version') OR
        e.kind='artifact' AND ($7='all' OR ($7='visible' AND e.data->'hiddenAt'='null'::jsonb) OR ($7='hidden' AND e.data->'hiddenAt'<>'null'::jsonb)) OR
        e.kind='artifact_version' AND EXISTS (
          SELECT 1 FROM entities parent WHERE parent.workspace_id=e.workspace_id AND parent.kind='artifact'
            AND parent.project_id=e.project_id AND parent.id::text=e.data->>'artifactId'
            AND ($7='all' OR ($7='visible' AND parent.data->'hiddenAt'='null'::jsonb) OR ($7='hidden' AND parent.data->'hiddenAt'<>'null'::jsonb))))
      ORDER BY e.id LIMIT $6`, [workspaceId, options.kind, options.projectId ?? null, member.projectIds, afterId, limit + 1, visibility]);
    const more = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const stream = await sql.query<{ stream_cursor: string }>('SELECT stream_cursor FROM workspaces WHERE id=$1', [workspaceId]);
    return { items: rows.map(entityFromRow), nextCursor: more && last ? Buffer.from(JSON.stringify({ id: last.id, kind: options.kind, projectId: options.projectId ?? null, visibility })).toString('base64url') : null, cursor: stream.rows[0]!.stream_cursor };
  });
}
