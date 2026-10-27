import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { DashboardRecord } from '../../domain/src/dashboard.ts';
import { getMembership, requireCapability } from './access.ts';
import { requireDashboardReadSelf, type DashboardReadContext } from './dashboard-read.ts';
import type { CommandContext } from './ports.ts';

type Context = CommandContext | DashboardReadContext;
type DashboardRow<T> = {
  id: string; workspace_id: string; project_id: string | null; kind: string; owner_id: string | null;
  version: number; data: T; created_at: Date; updated_at: Date; created_by: string;
};
type VersionState = { initial: number | null; current: number };
const versions = new WeakMap<CommandContext, Map<string, VersionState>>();
const uuid = z.uuid().toLowerCase();
function fromRow<T>(row: DashboardRow<T>): DashboardRecord<T> {
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, kind: row.kind, ownerId: row.owner_id,
    version: row.version, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), createdBy: row.created_by };
}
function versionMap(ctx: CommandContext): Map<string, VersionState> {
  let state = versions.get(ctx);
  if (!state) { state = new Map(); versions.set(ctx, state); }
  return state;
}
export async function requireDashboardSelf(ctx: CommandContext): Promise<void> { await ctx.requireSelf(); }
async function self(ctx: Context): Promise<void> {
  if ('command' in ctx) await requireDashboardSelf(ctx);
  else await requireDashboardReadSelf(ctx);
}
async function authorize(ctx: Context, record: Pick<DashboardRecord<unknown>, 'kind' | 'ownerId' | 'projectId'>): Promise<void> {
  if (record.kind === 'project_team' || record.kind === 'member_capacity') {
    if (record.projectId !== null || record.ownerId !== null) throw new DomainError('validation_failed', 'Team organization records require workspace scope');
    if ('command' in ctx) await ctx.require('access.manage');
    else await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'access.manage');
    return;
  }
  if (record.ownerId !== null) {
    if (record.ownerId !== ctx.actor.id) throw new DomainError('not_found_or_forbidden', 'Record is not accessible', 404);
    await self(ctx);
  }
  if (record.projectId !== null || record.ownerId === null) {
    if ('command' in ctx) await ctx.require('domain.read', record.projectId);
    else await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', record.projectId);
  }
}
export async function insertDashboardRecord<T>(ctx: CommandContext, input: { kind: string; data: T; projectId?: string | null; ownerId?: string | null; id?: string }): Promise<DashboardRecord<T>> {
  const id = input.id ?? randomUUID();
  const projectId = input.projectId ?? null, ownerId = input.ownerId ?? null;
  if (!uuid.safeParse(id).success || !/^[a-z][a-z0-9_]{0,79}$/.test(input.kind) || !input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new DomainError('validation_failed', 'Invalid dashboard record');
  await authorize(ctx, { kind: input.kind, projectId, ownerId });
  const result = await ctx.sql.query<DashboardRow<T>>('INSERT INTO dashboard_records(id,workspace_id,project_id,kind,owner_id,data,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *', [id, ctx.workspaceId, projectId, input.kind, ownerId, JSON.stringify(input.data), ctx.actor.id]);
  const record = fromRow(result.rows[0]!);
  versionMap(ctx).set(record.id, { initial: null, current: record.version });
  return record;
}
export async function readDashboardRecord<T>(ctx: Context, id: string, kind: string): Promise<DashboardRecord<T>> {
  if (!uuid.safeParse(id).success) throw new DomainError('not_found_or_forbidden', 'Record is not accessible', 404);
  const result = await ctx.sql.query<DashboardRow<T>>('SELECT * FROM dashboard_records WHERE workspace_id=$1 AND id=$2 AND kind=$3', [ctx.workspaceId, id, kind]);
  const row = result.rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Record is not accessible', 404);
  const record = fromRow(row);
  await authorize(ctx, record);
  return record;
}
export async function updateDashboardRecord<T>(ctx: CommandContext, record: DashboardRecord<T>, data: T): Promise<DashboardRecord<T>> {
  const current = await readDashboardRecord<T>(ctx, record.id, record.kind);
  const state = versionMap(ctx).get(record.id) ?? { initial: current.version, current: current.version };
  if (record.workspaceId !== ctx.workspaceId || current.version !== record.version || state.current !== record.version || state.initial !== null && ctx.command.expectedVersions?.[record.id] !== state.initial) {
    throw new DomainError('version_conflict', 'Dashboard record version changed or expected version is missing', 409, { id: record.id, currentVersion: current.version });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DomainError('validation_failed', 'Invalid dashboard data');
  const result = await ctx.sql.query<DashboardRow<T>>('UPDATE dashboard_records SET data=$1::jsonb,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING *', [JSON.stringify(data), ctx.workspaceId, record.id, record.version]);
  if (!result.rows[0]) throw new DomainError('version_conflict', 'Dashboard record version changed', 409, { id: record.id });
  const updated = fromRow(result.rows[0]);
  versionMap(ctx).set(record.id, { initial: state.initial, current: updated.version });
  return updated;
}
export async function listDashboardRecords<T>(ctx: Context, kind: string): Promise<DashboardRecord<T>[]> {
  const workspaceManaged = kind === 'project_team' || kind === 'member_capacity';
  if (workspaceManaged) await authorize(ctx, { kind, projectId: null, ownerId: null });
  else await self(ctx);
  const membership = workspaceManaged ? await getMembership(ctx.sql, ctx.actor, ctx.workspaceId) : 'membership' in ctx ? ctx.membership : await requireDashboardReadSelf(ctx);
  const result = await ctx.sql.query<DashboardRow<T>>(`SELECT * FROM dashboard_records WHERE workspace_id=$1 AND kind=$2 AND (owner_id IS NULL OR owner_id=$3)
    AND ($4::text[] IS NULL OR project_id=ANY($4::text[]) OR (project_id IS NULL AND owner_id=$3)) ORDER BY created_at,id`, [ctx.workspaceId, kind, ctx.actor.id, membership.projectIds]);
  const records = result.rows.map(fromRow<T>);
  for (const record of records) await authorize(ctx, record);
  return records;
}
export async function emitDashboardEvent(ctx: CommandContext, eventType: string, record: DashboardRecord<unknown>): Promise<void> {
  if (!/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(eventType)) throw new DomainError('validation_failed', 'Invalid event type');
  const current = await readDashboardRecord(ctx, record.id, record.kind);
  if (current.version !== record.version) throw new DomainError('version_conflict', 'Dashboard event version changed', 409);
  await ctx.sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id,audience_actor_id)
    SELECT $1,$2,$3,$4,$5,$6,coalesce(max(aggregate_sequence),0)+1,$7,$8::jsonb,$9,$10,$11 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$4`,
  [randomUUID(), ctx.workspaceId, current.projectId, current.id, current.kind, current.version, eventType, JSON.stringify({ id: current.id, kind: current.kind, version: current.version }), ctx.actor.id, ctx.command.commandId, current.ownerId]);
}
