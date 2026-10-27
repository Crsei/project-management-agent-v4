import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { intervalDuration, PRESENCE_TTL_MS, presenceStatus, sumTimeIntervals } from '../../domain/src/dashboard-time.ts';
import type { PresenceHeartbeatData, PresenceMember, PresencePreferenceData, TimeDashboard, TimeTaskReference, TimeTimer, TimeWorklog, TimerData, WorklogData } from '../../domain/src/dashboard-time.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, listDashboardRecords, readDashboardRecord, requireDashboardSelf, updateDashboardRecord } from './dashboard-store.ts';
import type { CommandContext, CommandRegistry } from './ports.ts';

const taskId = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
const note = z.string().trim().max(4000).default('');
const empty = z.strictObject({});

function selfScope(ctx: CommandContext, allowTarget: boolean): void {
  if (ctx.command.projectId || !allowTarget && ctx.command.targetId) throw new DomainError('invalid_scope', 'This command uses the current user scope');
}

async function clock(ctx: CommandContext): Promise<Date> {
  const result = await ctx.sql.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return result.rows[0]!.now;
}

async function referencedTask(ctx: CommandContext, id: string): Promise<TimeTaskReference & { taskId: string; projectId: string }> {
  const task = await ctx.get(id, 'work_item');
  if (!task.projectId) throw new DomainError('project_required');
  await ctx.require('domain.read', task.projectId);
  return { taskId: task.id, projectId: task.projectId, title: String(task.data.title ?? task.id), unavailable: false };
}

async function currentTask(ctx: DashboardReadContext, data: { taskId: string; projectId: string }): Promise<TimeTaskReference> {
  const unavailable: TimeTaskReference = { taskId: null, projectId: null, title: null, unavailable: true };
  if (ctx.membership.projectIds !== null && !ctx.membership.projectIds.includes(data.projectId)) return unavailable;
  try {
    const task = await ctx.core.get(data.taskId, 'work_item');
    if (task.projectId !== data.projectId) return unavailable;
    return { taskId: task.id, projectId: task.projectId, title: String(task.data.title ?? task.id), unavailable: false };
  } catch (error) {
    if (error instanceof DomainError && (error.status === 404 || error.code === 'permission_denied')) return unavailable;
    throw error;
  }
}

export const dashboardTimeCommands: CommandRegistry = {
  StartTimer: {
    payload: z.strictObject({ taskId, note }),
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      selfScope(ctx, false);
      const active = (await listDashboardRecords<TimerData>(ctx, 'time_timer')).find(record => record.data.stoppedAt === null);
      if (active) throw new DomainError('active_timer_exists', 'Stop the active timer before starting another', 409, { timerId: active.id });
      const task = await referencedTask(ctx, ctx.command.payload.taskId as string);
      const startedAt = (await clock(ctx)).toISOString();
      const record = await insertDashboardRecord<TimerData>(ctx, { kind: 'time_timer', ownerId: ctx.actor.id, data: { taskId: task.taskId, projectId: task.projectId, note: ctx.command.payload.note as string, startedAt, stoppedAt: null, worklogId: null } });
      await emitDashboardEvent(ctx, 'TimerStarted', record);
      return { id: record.id, version: record.version, startedAt, stoppedAt: null, worklogId: null, task } satisfies TimeTimer;
    },
  },
  StopTimer: {
    payload: empty,
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      selfScope(ctx, true);
      if (!ctx.command.targetId) throw new DomainError('target_required');
      // This private record deliberately has no project scope: revoking its task
      // must not trap the owner in a running timer or leak the revoked reference.
      const record = await readDashboardRecord<TimerData>(ctx, ctx.command.targetId, 'time_timer');
      if (record.ownerId !== ctx.actor.id) throw new DomainError('not_found_or_forbidden', 'Timer is not accessible', 404);
      if (ctx.command.expectedVersions?.[record.id] !== record.version) throw new DomainError('version_conflict', 'Timer version changed', 409, { id: record.id, currentVersion: record.version });
      if (record.data.stoppedAt !== null) return { timerId: record.id, worklogId: record.data.worklogId, stoppedAt: record.data.stoppedAt, durationMs: Date.parse(record.data.stoppedAt) - Date.parse(record.data.startedAt) };
      const stoppedAt = (await clock(ctx)).toISOString();
      const durationMs = Date.parse(stoppedAt) - Date.parse(record.data.startedAt);
      if (durationMs < 0) throw new DomainError('server_clock_before_timer_start', 'The server clock precedes the persisted timer start', 409);
      const log = await insertDashboardRecord<WorklogData>(ctx, { kind: 'time_worklog', ownerId: ctx.actor.id, data: { source: 'timer', timerId: record.id, taskId: record.data.taskId, projectId: record.data.projectId, startedAt: record.data.startedAt, endedAt: stoppedAt, durationMs, note: record.data.note } });
      const stopped = await updateDashboardRecord(ctx, record, { ...record.data, stoppedAt, worklogId: log.id });
      await emitDashboardEvent(ctx, 'TimerStopped', stopped);
      await emitDashboardEvent(ctx, 'WorklogRecorded', log);
      return { timerId: record.id, worklogId: log.id, stoppedAt, durationMs };
    },
  },
  RecordManualWorklog: {
    payload: z.strictObject({ taskId, startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }), note }),
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      selfScope(ctx, false);
      const task = await referencedTask(ctx, ctx.command.payload.taskId as string);
      const startedAt = new Date(ctx.command.payload.startedAt as string).toISOString(), endedAt = new Date(ctx.command.payload.endedAt as string).toISOString();
      const durationMs = intervalDuration(startedAt, endedAt, await clock(ctx));
      const record = await insertDashboardRecord<WorklogData>(ctx, { kind: 'time_worklog', ownerId: ctx.actor.id, data: { source: 'manual', timerId: null, taskId: task.taskId, projectId: task.projectId, startedAt, endedAt, durationMs, note: ctx.command.payload.note as string } });
      await emitDashboardEvent(ctx, 'WorklogRecorded', record);
      return { id: record.id, source: 'manual', timerId: null, startedAt, endedAt, durationMs, note: record.data.note, task } satisfies TimeWorklog;
    },
  },
  SetPresencePreference: {
    payload: z.strictObject({ preference: z.enum(['online', 'away']) }),
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      selfScope(ctx, true);
      const existing = (await listDashboardRecords<PresencePreferenceData>(ctx, 'presence_preference'))[0];
      if (ctx.command.targetId && ctx.command.targetId !== existing?.id) throw new DomainError('not_found_or_forbidden', 'Presence preference is not accessible', 404);
      const data: PresencePreferenceData = { preference: ctx.command.payload.preference as PresencePreferenceData['preference'] };
      const record = existing ? await updateDashboardRecord(ctx, existing, data) : await insertDashboardRecord(ctx, { kind: 'presence_preference', ownerId: ctx.actor.id, data });
      await emitDashboardEvent(ctx, 'PresencePreferenceSet', record);
      return { id: record.id, version: record.version, preference: record.data.preference };
    },
  },
  HeartbeatPresence: {
    payload: empty,
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      selfScope(ctx, true);
      const existing = (await listDashboardRecords<PresenceHeartbeatData>(ctx, 'presence_heartbeat'))[0];
      if (ctx.command.targetId && ctx.command.targetId !== existing?.id) throw new DomainError('not_found_or_forbidden', 'Presence heartbeat is not accessible', 404);
      const data: PresenceHeartbeatData = { heartbeatAt: (await clock(ctx)).toISOString() };
      const record = existing ? await updateDashboardRecord(ctx, existing, data) : await insertDashboardRecord(ctx, { kind: 'presence_heartbeat', ownerId: ctx.actor.id, data });
      // Heartbeat and preference are independent CAS aggregates, so a stale tab
      // cannot change the user's away intent while reporting that it is alive.
      await emitDashboardEvent(ctx, 'PresenceHeartbeatRecorded', record);
      return { id: record.id, version: record.version, heartbeatAt: record.data.heartbeatAt };
    },
  },
};

export async function readTimeDashboard(ctx: DashboardReadContext): Promise<TimeDashboard> {
  if (!ctx.membership.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  const timers = await listDashboardRecords<TimerData>(ctx, 'time_timer');
  const logs = await listDashboardRecords<WorklogData>(ctx, 'time_worklog');
  const preferences = await listDashboardRecords<PresencePreferenceData>(ctx, 'presence_preference');
  const heartbeats = await listDashboardRecords<PresenceHeartbeatData>(ctx, 'presence_heartbeat');
  const user = await ctx.sql.query<{ time_zone: string; name: string }>('SELECT time_zone,name FROM users WHERE id=$1', [ctx.actor.id]);
  const profile = user.rows[0]!;
  const active = timers.find(record => record.data.stoppedAt === null);
  const activeTimer: TimeTimer | null = active ? { id: active.id, version: active.version, startedAt: active.data.startedAt, stoppedAt: null, worklogId: null, task: await currentTask(ctx, active.data) } : null;
  const taskReferences = new Map<string, TimeTaskReference>();
  const worklogs: TimeWorklog[] = [];
  for (const record of logs) {
    const data = record.data;
    const key = `${data.projectId}:${data.taskId}`;
    let task = taskReferences.get(key);
    if (!task) { task = await currentTask(ctx, data); taskReferences.set(key, task); }
    worklogs.push({ id: record.id, source: data.source, timerId: data.timerId, startedAt: data.startedAt, endedAt: data.endedAt, durationMs: data.durationMs, note: task.unavailable ? '' : data.note, task });
  }
  worklogs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  const preference = preferences[0], heartbeat = heartbeats[0];
  const intent = preference?.data.preference ?? 'online';
  const lastHeartbeatAt = heartbeat?.data.heartbeatAt ?? null;
  const self = { userId: ctx.actor.id, name: profile.name, preference: intent, status: presenceStatus(intent, lastHeartbeatAt, ctx.now), lastHeartbeatAt, preferenceId: preference?.id ?? null, preferenceVersion: preference?.version ?? null, heartbeatId: heartbeat?.id ?? null, heartbeatVersion: heartbeat?.version ?? null };
  const directoryVisible = ctx.membership.projectIds === null && ctx.membership.capabilities.includes('access.manage');
  let members: PresenceMember[] = [self];
  if (directoryVisible) {
    const directory = await ctx.sql.query<{ user_id: string; name: string; preference: PresencePreferenceData['preference'] | null; heartbeat_at: string | null }>(`SELECT m.user_id,u.name,p.data->>'preference' AS preference,h.data->>'heartbeatAt' AS heartbeat_at
      FROM memberships m JOIN users u ON u.id=m.user_id
      LEFT JOIN dashboard_records p ON p.workspace_id=m.workspace_id AND p.owner_id=m.user_id AND p.kind='presence_preference'
      LEFT JOIN dashboard_records h ON h.workspace_id=m.workspace_id AND h.owner_id=m.user_id AND h.kind='presence_heartbeat'
      WHERE m.workspace_id=$1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL ORDER BY m.created_at,m.user_id`, [ctx.workspaceId]);
    members = directory.rows.map(row => ({ userId: row.user_id, name: row.name, preference: row.preference ?? 'online', status: presenceStatus(row.preference ?? 'online', row.heartbeat_at, ctx.now), lastHeartbeatAt: row.heartbeat_at }));
  }
  return { serverNow: ctx.now.toISOString(), timeZone: profile.time_zone, activeTimer, worklogs, totals: sumTimeIntervals(logs.map(record => record.data), ctx.now, profile.time_zone), presence: { self, members, directoryVisible, ttlMs: PRESENCE_TTL_MS } };
}
