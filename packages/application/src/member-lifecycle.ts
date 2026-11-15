import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor, type Command, type CommandReceipt, type Entity } from '../../domain/src/core.ts';
import { handoverStatus, type HandoverItem, type MemberDuty, type MemberHandover, type MemberImpact } from '../../domain/src/member-lifecycle.ts';
import type { ProjectTeam } from '../../domain/src/project-directory.ts';
import { statusCategory } from '../../pm-schema/index.ts';
import { getMembership, requireCapability } from './access.ts';
import type { CoreAccess, CommandRegistry, SqlExecutor } from './ports.ts';
import { emitDashboardEvent, readDashboardRecord, updateDashboardRecord } from './dashboard-store.ts';

export type LifecycleReadContext = { sql: SqlExecutor; actor: Actor; workspaceId: string; core?: Pick<CoreAccess, 'records' | 'list' | 'configuration'> };

/** Incomplete scope and invalid Markdown are unknown, never an empty duty list. */
export async function readMemberImpact(ctx: LifecycleReadContext, userId: string): Promise<MemberImpact> {
  const member = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  const manager = member.projectIds === null && member.capabilities.includes('access.manage');
  if (ctx.actor.id !== userId && !manager) throw new DomainError('permission_denied', 'Only the member or a workspace manager can read departure impact', 403);
  const target = (await ctx.sql.query<{ version: number; revoked_at: Date | null }>('SELECT version,revoked_at FROM memberships WHERE workspace_id=$1 AND user_id=$2', [ctx.workspaceId, userId])).rows[0];
  if (!target) throw new DomainError('not_found_or_forbidden', 'Member is not accessible', 404);
  const readable = member.capabilities.includes('domain.read') && !!ctx.core;
  const blockers: string[] = [];
  if (!readable) blockers.push('Business responsibility sources are not readable');
  if (member.projectIds !== null) blockers.push('Project-limited scope cannot prove workspace-wide responsibilities');
  const duties: MemberDuty[] = [];
  const executionProjects: string[] = [];
  if (readable && ctx.core) {
    const records = await ctx.core.records();
    const entities = new Map<string, Entity>();
    for (const kind of ['project', 'work_item', 'milestone'] as const) {
      for (const entity of await ctx.core.list(kind)) entities.set(entity.id, entity);
    }
    for (const record of records) {
      const source = record.entity;
      if (!['project', 'work_item', 'milestone'].includes(source.entity)) continue;
      if (record.stale || record.error || record.diagnostics?.some(issue => issue.severity === 'error')) { blockers.push(`Unreadable responsibility source: ${record.id}`); continue; }
      if (source.entity === 'project' && (member.projectIds === null || member.projectIds.includes(record.id))) executionProjects.push(record.id);
      if (source.archived) continue;
      const category = statusCategory(source, ctx.core.configuration());
      if (category === 'completed' || category === 'canceled') continue;
      if (category === undefined) blockers.push(`Unknown workflow category: ${record.id}`);
      if ((source.entity === 'work_item' ? source.assignee : source.owner) !== userId) continue;
      const entity = entities.get(record.id);
      if (!entity) { blockers.push(`Responsibility version unavailable: ${record.id}`); continue; }
      duties.push({ id: record.id, kind: source.entity as MemberDuty['kind'], title: source.title,
        projectId: source.entity === 'project' ? record.id : typeof source.project === 'string' ? source.project : null,
        version: entity.version, parentId: typeof source.parent === 'string' ? source.parent : null,
        transferable: category !== undefined && member.capabilities.includes('planning.edit') });
    }
  }
  // A self read reveals only teams for which this member has the actual maintainer duty.
  const teams = await ctx.sql.query<{ id: string; version: number; data: ProjectTeam }>(`SELECT id,version,data FROM dashboard_records WHERE workspace_id=$1 AND kind='project_team'
    AND data->>'archivedAt' IS NULL AND data->'maintainerIds' ? $2`, [ctx.workspaceId, userId]);
  for (const team of teams.rows) duties.push({ id: team.id, kind: 'team', title: team.data.name, projectId: null, version: team.version, parentId: null, transferable: manager });
  const evidence: MemberImpact['evidence'] = [];
  if (readable && member.capabilities.includes('delivery.review')) {
    const rows = await ctx.sql.query<{ id: string; project_id: string; data: { verdict?: string } }>(`SELECT id,project_id,data FROM entities WHERE workspace_id=$1 AND kind='review'
      AND data->>'reviewerId'=$2 AND ($3::text[] IS NULL OR project_id=ANY($3::text[])) ORDER BY created_at DESC LIMIT 100`, [ctx.workspaceId, userId, member.projectIds]);
    for (const row of rows.rows) evidence.push({ source: 'pm_review', id: row.id, projectId: row.project_id, status: row.data.verdict ?? 'unknown' });
  }
  // Studio execution history is creator-private even for workspace managers.
  // Preserve its actual owner/project read intersection; never inspect Agent SQLite.
  if (readable && ctx.actor.id === userId) {
    const rows = await ctx.sql.query<{ id: string; project_id: string; status: string }>(`SELECT id,project_id,status FROM automation_studio_executions
      WHERE workspace_id=$1 AND actor_id=$2 AND project_id=ANY($3::text[]) ORDER BY created_at DESC,id DESC LIMIT 100`, [ctx.workspaceId, userId, executionProjects]);
    for (const row of rows.rows) evidence.push({ source: 'automation_execution', id: row.id, projectId: row.project_id, status: row.status });
  }
  const scopeComplete = blockers.length === 0;
  return { userId, membershipVersion: target.version, revokedAt: target.revoked_at?.toISOString() ?? null, duties, blockers, scopeComplete,
    canHandover: manager && scopeComplete, canRevoke: manager && target.revoked_at === null,
    canLeave: scopeComplete && duties.length === 0 && target.revoked_at === null,
    evidence, executionCoverage: readable && ctx.actor.id === userId ? 'partial' : 'unavailable' };
}

const uuid = z.uuid().toLowerCase();
const preparePayload = z.strictObject({ userId: uuid, recipientId: uuid, items: z.array(z.strictObject({ id: z.string().min(1).max(80), kind: z.enum(['work_item', 'project', 'milestone', 'team']), version: z.number().int().positive() })).min(1).max(1000) });
type HandoverRow = { id: string; user_id: string; recipient_id: string; actor_id: string; version: number; items: HandoverItem[] };
function fromRow(row: HandoverRow): MemberHandover { return { id: row.id, userId: row.user_id, recipientId: row.recipient_id, actorId: row.actor_id, version: row.version, items: row.items, status: handoverStatus(row.items) }; }
async function validRecipient(sql: SqlExecutor, workspaceId: string, recipientId: string, projectId: string | null): Promise<void> {
  const recipient = (await sql.query<{ project_ids: string[] | null; capabilities: string[] }>(`SELECT m.project_ids,m.capabilities FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [workspaceId, recipientId])).rows[0];
  if (!recipient || projectId && (!recipient.capabilities.includes('domain.read') || recipient.project_ids !== null && !recipient.project_ids.includes(projectId))) throw new DomainError('invalid_handover_recipient', 'Recipient must be active and authorized to read the responsibility project', 409);
}

export const memberLifecycleCommands: CommandRegistry = {
  PrepareMemberHandover: {
    payload: preparePayload,
    async handler(ctx) {
      await ctx.require('access.manage'); await ctx.require('domain.read');
      const input = preparePayload.parse(ctx.command.payload);
      if (ctx.command.projectId || ctx.command.targetId && ctx.command.targetId !== input.userId || input.userId === input.recipientId) throw new DomainError('scope_mismatch', 'Invalid departure or recipient scope');
      const impact = await readMemberImpact(ctx, input.userId);
      if (!impact.scopeComplete) throw new DomainError('impact_incomplete', 'Resolve incomplete responsibility sources before preparing a handover', 409);
      if (ctx.command.expectedVersions?.[input.userId] !== impact.membershipVersion) throw new DomainError('version_conflict', 'Membership changed', 409);
      const unresolved = await ctx.sql.query(`SELECT id FROM member_handovers WHERE workspace_id=$1 AND user_id=$2 AND items @> '[{"state":"unknown"}]'::jsonb LIMIT 1`, [ctx.workspaceId, input.userId]);
      if (unresolved.rowCount) throw new DomainError('handover_outcome_unknown', 'An original handover has unknown items; reconcile it before preparing another operation', 409);
      const seen = new Set<string>();
      const items: HandoverItem[] = [];
      for (const selected of input.items) {
        const duty = impact.duties.find(item => item.id === selected.id && item.kind === selected.kind);
        if (!duty || seen.has(duty.id) || duty.version !== selected.version) throw new DomainError('version_conflict', 'Responsibility changed or was selected twice', 409);
        if (!duty.transferable) throw new DomainError('permission_denied', 'Responsibility cannot be transferred with current permissions', 403);
        seen.add(duty.id); await validRecipient(ctx.sql, ctx.workspaceId, input.recipientId, duty.projectId);
        const project = duty.kind === 'project' ? await ctx.core!.get(duty.id, 'project') : null;
        const command: Command = { commandId: randomUUID(), targetId: duty.id, expectedVersions: { [duty.id]: duty.version },
          commandType: duty.kind === 'team' ? 'TransferTeamMaintainer' : duty.kind === 'work_item' ? 'UpdateWorkItemMetadata' : duty.kind === 'project' ? 'UpdateProject' : 'UpdateMilestone',
          payload: duty.kind === 'team' ? { userId: input.userId, recipientId: input.recipientId } : duty.kind === 'work_item' ? { assigneeId: input.recipientId }
            : project ? { name: project.data.name, goal: project.data.goal, completionCriteria: project.data.completionCriteria, ownerId: input.recipientId } : { ownerId: input.recipientId },
          ...(duty.projectId ? { projectId: duty.projectId } : {}) };
        items.push({ duty, command, state: 'pending', receipt: null });
      }
      const row = (await ctx.sql.query<HandoverRow>(`INSERT INTO member_handovers(workspace_id,id,actor_id,user_id,recipient_id,items) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
        [ctx.workspaceId, ctx.command.commandId, ctx.actor.id, input.userId, input.recipientId, JSON.stringify(items)])).rows[0]!;
      return fromRow(row);
    },
  },
  TransferTeamMaintainer: {
    payload: z.strictObject({ userId: uuid, recipientId: uuid }),
    async handler(ctx) {
      await ctx.require('access.manage');
      const { userId, recipientId } = ctx.command.payload as { userId: string; recipientId: string };
      if (!ctx.command.targetId || ctx.command.projectId || userId === recipientId) throw new DomainError('scope_mismatch', 'Team transfer requires one workspace team');
      const team = await readDashboardRecord<ProjectTeam>(ctx, ctx.command.targetId, 'project_team');
      if (ctx.command.expectedVersions?.[team.id] !== team.version) throw new DomainError('version_conflict', 'Team version changed', 409);
      if (team.data.archivedAt || !team.data.maintainerIds.includes(userId)) throw new DomainError('responsibility_changed', 'The active maintainer responsibility changed', 409);
      await validRecipient(ctx.sql, ctx.workspaceId, recipientId, null);
      const active = await ctx.sql.query<{ user_id: string }>(`SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.workspaceId, [...team.data.memberIds, recipientId]]);
      const activeIds = new Set(active.rows.map(row => row.user_id));
      const memberIds = [...new Set([...team.data.memberIds.filter(id => activeIds.has(id)), recipientId])];
      const memberSet = new Set(memberIds);
      const next = await updateDashboardRecord(ctx, team, { ...team.data,
        memberIds,
        maintainerIds: [...new Set(team.data.maintainerIds.map(id => id === userId ? recipientId : id).filter(id => memberSet.has(id)))] });
      await emitDashboardEvent(ctx, 'ProjectTeamMaintainersSet', next); return next;
    },
  },
};

export async function readMemberHandover(sql: SqlExecutor, actor: Actor, workspaceId: string, id: string): Promise<MemberHandover> {
  await requireCapability(sql, actor, workspaceId, 'access.manage');
  await requireCapability(sql, actor, workspaceId, 'domain.read');
  const row = (await sql.query<HandoverRow>('SELECT * FROM member_handovers WHERE workspace_id=$1 AND id=$2 AND actor_id=$3', [workspaceId, id, actor.id])).rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Handover is not accessible', 404);
  return fromRow(row);
}

export async function listMemberHandovers(sql: SqlExecutor, actor: Actor, workspaceId: string, userId: string): Promise<{ items: MemberHandover[] }> {
  await requireCapability(sql, actor, workspaceId, 'access.manage');
  await requireCapability(sql, actor, workspaceId, 'domain.read');
  const rows = await sql.query<HandoverRow>('SELECT * FROM member_handovers WHERE workspace_id=$1 AND user_id=$2 AND actor_id=$3 ORDER BY created_at DESC,id', [workspaceId, userId, actor.id]);
  return { items: rows.rows.map(fromRow) };
}
export type HandoverExecutor = {
  execute(actor: Actor, workspaceId: string, command: Command): Promise<CommandReceipt>;
  receipt(actor: Actor, workspaceId: string, command: Command): Promise<CommandReceipt | null>;
};

/** Claim as unknown BEFORE dispatch; a process crash cannot make an attempted item pending again. */
export async function continueMemberHandover(pool: Pool, actor: Actor, workspaceId: string, id: string, expectedVersion: number, executor: HandoverExecutor): Promise<MemberHandover> {
  let operation = await readMemberHandover(pool, actor, workspaceId, id);
  if (operation.version !== expectedVersion) throw new DomainError('version_conflict', 'Handover changed; read its original operation', 409);
  if (operation.items.some(item => item.state === 'unknown')) throw new DomainError('handover_outcome_unknown', 'Reconcile original commands before continuing', 409);
  for (let index = 0; index < operation.items.length; index++) {
    const item = operation.items[index]!;
    if (item.state !== 'pending') continue;
    await requireCapability(pool, actor, workspaceId, 'access.manage');
    await requireCapability(pool, actor, workspaceId, 'domain.read');
    await validRecipient(pool, workspaceId, operation.recipientId, item.duty.projectId);
    const claimed = operation.items.map((value, position) => position === index ? { ...value, state: 'unknown' as const } : value);
    const row = (await pool.query<HandoverRow>(`UPDATE member_handovers SET items=$1::jsonb,version=version+1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND actor_id=$4 AND version=$5 RETURNING *`,
      [JSON.stringify(claimed), workspaceId, id, actor.id, operation.version])).rows[0];
    if (!row) throw new DomainError('version_conflict', 'Another continuation claimed the operation', 409);
    operation = fromRow(row);
    let receipt: CommandReceipt;
    try { receipt = await executor.execute(actor, workspaceId, item.command); }
    catch { return readMemberHandover(pool, actor, workspaceId, id); }
    operation = await saveItemReceipt(pool, actor, workspaceId, operation, index, receipt);
  }
  return readMemberHandover(pool, actor, workspaceId, id);
}
async function saveItemReceipt(sql: SqlExecutor, actor: Actor, workspaceId: string, operation: MemberHandover, index: number, receipt: CommandReceipt): Promise<MemberHandover> {
  if (receipt.commandId !== operation.items[index]!.command.commandId) throw new DomainError('receipt_mismatch', 'Receipt is not the original item command', 409);
  const items = operation.items.map((item, position) => position === index ? { ...item, state: receipt.status, receipt } : item);
  const row = (await sql.query<HandoverRow>(`UPDATE member_handovers SET items=$1::jsonb,version=version+1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND actor_id=$4 AND version=$5 RETURNING *`,
    [JSON.stringify(items), workspaceId, operation.id, actor.id, operation.version])).rows[0];
  if (!row) throw new DomainError('version_conflict', 'Handover changed; reconcile its receipts', 409);
  return fromRow(row);
}
/** Receipt lookup is read-only with respect to business objects; not_found is still unknown. */
export async function reconcileMemberHandover(pool: Pool, actor: Actor, workspaceId: string, id: string, executor: HandoverExecutor): Promise<MemberHandover> {
  let operation = await readMemberHandover(pool, actor, workspaceId, id);
  for (let index = 0; index < operation.items.length; index++) {
    const item = operation.items[index]!;
    if (item.state !== 'unknown') continue;
    let receipt: CommandReceipt | null;
    try { receipt = await executor.receipt(actor, workspaceId, item.command); }
    catch (error) {
      if (error instanceof DomainError && error.code === 'not_found_or_forbidden') continue;
      throw error;
    }
    if (receipt) operation = await saveItemReceipt(pool, actor, workspaceId, operation, index, receipt);
  }
  return operation;
}

/** Narrow post-departure recovery: no membership, other receipt, or private content is disclosed. */
export async function readDepartureReceipt(sql: SqlExecutor, actor: Actor, workspaceId: string, userId: string, commandId: string): Promise<CommandReceipt> {
  if (actor.id !== userId) throw new DomainError('not_found_or_forbidden', 'Departure receipt is not accessible', 404);
  const row = (await sql.query<{ receipt: CommandReceipt }>(`SELECT receipt FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3 AND command_type='LeaveWorkspace'`, [workspaceId, actor.id, commandId])).rows[0];
  const result = row?.receipt.result as { userId?: unknown; version?: unknown; revokedAt?: unknown } | undefined;
  if (!row || row.receipt.status !== 'committed' || result?.userId !== actor.id) throw new DomainError('not_found_or_forbidden', 'Committed self-departure receipt is unavailable; outcome remains unknown', 404);
  return { commandId, status: 'committed', httpStatus: 200, result: { userId: actor.id, version: result.version, revokedAt: result.revokedAt } };
}
