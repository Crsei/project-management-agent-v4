import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { projectAuditEntrySchema, type ProjectAuditEntry, type ProjectAuditOptions, type ProjectAuditPage } from '../../domain/src/project-audit.ts';
import { requireCapability } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import type { SqlExecutor } from './ports.ts';

export const projectAuditOptionsSchema = z.object({ cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
const auditSequenceSchema = z.string().regex(/^(?:0|[1-9]\d{0,18})$/).refine(value => value.length < 19 || value.length === 19 && value <= '9223372036854775807', 'Audit sequence is outside the int64 range');
const cursorSchema = z.object({ workspaceId: z.uuid(), projectId: z.string().min(1).max(80), actorId: z.uuid(), through: auditSequenceSchema, before: auditSequenceSchema.refine(value => value !== '0') }).strict();
export const projectAuditWriteSchema = projectAuditEntrySchema.omit({ id: true, private: true }).extend({ audienceActorId: z.uuid().nullable() }).strict();
export type ProjectAuditWrite = Omit<ProjectAuditEntry, 'id' | 'private'> & { audienceActorId: string | null };
type AuditRow = {
  id: string; project_id: string; source: 'command' | 'core_http'; command_id: string; action: string; actor_id: string;
  occurred_at: Date; target_id: string; target_kind: string; before_version: string | null; after_version: string | null;
  changes: unknown; audience_actor_id: string | null;
};
function fromRow(row: AuditRow): ProjectAuditEntry {
  return projectAuditEntrySchema.parse({ id: row.id, projectId: row.project_id, source: row.source, commandId: row.command_id, action: row.action,
    actorId: row.actor_id, occurredAt: row.occurred_at.toISOString(), targetId: row.target_id, targetKind: row.target_kind,
    beforeVersion: row.before_version, afterVersion: row.after_version, changes: row.changes, private: row.audience_actor_id !== null });
}

/** Caller holds the workspace transaction lock. Recovery must use the journal's exact safe snapshot, never today's files. */
export async function appendProjectAudit(sql: SqlExecutor, workspaceId: string, actor: Actor, entries: readonly ProjectAuditWrite[]): Promise<void> {
  for (const input of entries) {
    const entry = projectAuditWriteSchema.parse(input);
    if (entry.actorId !== actor.id || entry.audienceActorId !== null && entry.audienceActorId !== actor.id) throw new DomainError('audit_actor_mismatch', 'Audit actor must match the authenticated actor', 500);
    const key = JSON.stringify([entry.projectId, entry.targetId, entry.beforeVersion, entry.afterVersion]);
    const prior = await sql.query<AuditRow>(`SELECT id::text,project_id,source,command_id,action,actor_id,occurred_at,target_id,target_kind,before_version,after_version,changes,audience_actor_id
      FROM project_audit WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3 AND source=$4 AND dedupe_key=$5`, [workspaceId, actor.id, entry.commandId, entry.source, key]);
    if (prior.rows[0]) {
      const previous = fromRow(prior.rows[0]);
      const expected = { ...entry, occurredAt: new Date(entry.occurredAt).toISOString() };
      const actual: ProjectAuditWrite = { projectId: previous.projectId, source: previous.source, commandId: previous.commandId, action: previous.action, actorId: previous.actorId,
        occurredAt: previous.occurredAt, targetId: previous.targetId, targetKind: previous.targetKind, beforeVersion: previous.beforeVersion, afterVersion: previous.afterVersion,
        changes: previous.changes, audienceActorId: prior.rows[0].audience_actor_id };
      if (JSON.stringify(projectAuditWriteSchema.parse(actual)) !== JSON.stringify(projectAuditWriteSchema.parse(expected))) throw new DomainError('audit_idempotency_conflict', 'A different audit fact already exists for this command', 409);
      continue;
    }
    await sql.query(`INSERT INTO project_audit(workspace_id,project_id,source,command_id,action,actor_id,occurred_at,target_id,target_kind,before_version,after_version,changes,audience_actor_id,dedupe_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
    [workspaceId, entry.projectId, entry.source, entry.commandId, entry.action, entry.actorId, entry.occurredAt, entry.targetId, entry.targetKind,
      entry.beforeVersion, entry.afterVersion, JSON.stringify(entry.changes), entry.audienceActorId, key]);
  }
}

/** Current authorization and actor visibility are checked again on every page, independent of the cursor. */
export async function readProjectAudit(ctx: DashboardReadContext, projectId: string, options: ProjectAuditOptions = {}): Promise<ProjectAuditPage> {
  if (!z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).safeParse(projectId).success) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  const parsed = projectAuditOptionsSchema.safeParse(options);
  if (!parsed.success) throw new DomainError('validation_failed', 'Invalid audit pagination options', 400, parsed.error.flatten());
  await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', projectId);
  await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'audit.read', projectId);
  await ctx.core.get(projectId, 'project');
  let through: string, before: string | null = null;
  if (parsed.data.cursor) {
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString('utf8')); }
    catch { throw new DomainError('validation_failed', 'Invalid audit cursor', 400); }
    const cursor = cursorSchema.safeParse(decoded);
    if (!cursor.success || cursor.data.workspaceId !== ctx.workspaceId || cursor.data.projectId !== projectId || cursor.data.actorId !== ctx.actor.id
      || BigInt(cursor.data.before) > BigInt(cursor.data.through)) throw new DomainError('validation_failed', 'Invalid audit cursor', 400);
    through = cursor.data.through; before = cursor.data.before;
  } else {
    const snapshot = await ctx.sql.query<{ through: string }>('SELECT coalesce(max(id),0)::text AS through FROM project_audit WHERE workspace_id=$1 AND project_id=$2 AND (audience_actor_id IS NULL OR audience_actor_id=$3)', [ctx.workspaceId, projectId, ctx.actor.id]);
    through = snapshot.rows[0]!.through;
  }
  const result = await ctx.sql.query<AuditRow>(`SELECT id::text,project_id,source,command_id,action,actor_id,occurred_at,target_id,target_kind,before_version,after_version,changes,audience_actor_id
    FROM project_audit WHERE workspace_id=$1 AND project_id=$2 AND (audience_actor_id IS NULL OR audience_actor_id=$3)
    AND id<=$4::bigint AND ($5::bigint IS NULL OR id<$5::bigint) ORDER BY project_audit.id DESC LIMIT $6`, [ctx.workspaceId, projectId, ctx.actor.id, through, before, parsed.data.limit + 1]);
  const entries = result.rows.slice(0, parsed.data.limit).map(fromRow);
  const last = entries.at(-1);
  const nextCursor = result.rows.length > parsed.data.limit && last ? Buffer.from(JSON.stringify({ workspaceId: ctx.workspaceId, projectId, actorId: ctx.actor.id, through, before: last.id })).toString('base64url') : null;
  return { projectId, entries, nextCursor };
}
