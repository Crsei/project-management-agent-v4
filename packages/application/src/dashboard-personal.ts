import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { assertProjectWritable } from '../../domain/src/planning.ts';
import { assertMeetingInterval, isIanaTimeZone, MAX_PROFILE_AVATAR_BYTES } from '../../domain/src/dashboard-personal.ts';
import type { MeetingParticipant, PersonalDashboard, PrivateNote, PrivateNoteData, ProjectMeeting, ProjectMeetingData, SelfProfile, TaskWatchData } from '../../domain/src/dashboard-personal.ts';
import type { CommandContext, CommandRegistry } from './ports.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, listDashboardRecords, readDashboardRecord, requireDashboardSelf, updateDashboardRecord } from './dashboard-store.ts';

const reference = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
const content = z.string().trim().min(1).max(16000);
const empty = z.strictObject({});
const meetingPayload = z.strictObject({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(16000),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  participantIds: z.array(z.uuid().toLowerCase()).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate participant'),
});

type ProfileRow = { id: string; name: string; time_zone: string; job_title: string | null; phone: string | null; avatar_data_url: string | null; profile_version: number; profile_updated_at: Date; joined_at: Date };
type ProfileContext = Pick<DashboardReadContext, 'sql' | 'actor' | 'workspaceId'>;

export async function readSelfProfile(ctx: ProfileContext): Promise<SelfProfile> {
  const result = await ctx.sql.query<ProfileRow>(`SELECT u.id,u.name,u.time_zone,u.job_title,u.phone,u.avatar_data_url,u.profile_version,u.profile_updated_at,m.created_at AS joined_at
    FROM users u JOIN memberships m ON m.user_id=u.id
    WHERE u.id=$1 AND m.workspace_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.actor.id, ctx.workspaceId]);
  const row = result.rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Profile is not accessible', 404);
  return { userId: row.id, name: row.name, timeZone: row.time_zone, jobTitle: row.job_title, phone: row.phone, avatarDataUrl: row.avatar_data_url, version: row.profile_version, joinedAt: row.joined_at.toISOString(), updatedAt: row.profile_updated_at.toISOString() };
}

function isSafeProfileAvatar(value: string): boolean {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0 || match[2]!.length > 4 * Math.ceil(MAX_PROFILE_AVATAR_BYTES / 3)) return false;
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > MAX_PROFILE_AVATAR_BYTES || bytes.toString('base64') !== match[2]) return false;
  if (match[1] === 'png') {
    return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
      && bytes.toString('hex', bytes.length - 12) === '0000000049454e44ae426082';
  }
  if (match[1] === 'jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
}

const selfProfilePayload = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  timeZone: z.string().min(1).max(200).refine(isIanaTimeZone, 'Expected a valid IANA time zone').optional(),
  jobTitle: z.string().trim().min(1).max(200).nullable().optional(),
  phone: z.string().trim().min(1).max(80).nullable().optional(),
  avatarDataUrl: z.string().max(4 * Math.ceil(MAX_PROFILE_AVATAR_BYTES / 3) + 32).refine(isSafeProfileAvatar, 'Expected a PNG, JPEG or WebP data URL of at most 256 KiB with matching image signature').nullable().optional(),
}).refine(value => Object.values(value).some(field => field !== undefined), 'At least one profile field is required');

async function existingNote(ctx: CommandContext): Promise<PrivateNote> {
  await requireDashboardSelf(ctx);
  if (ctx.command.projectId || !ctx.command.targetId) throw new DomainError('invalid_scope');
  const note = await readDashboardRecord<PrivateNoteData>(ctx, ctx.command.targetId, 'private_note');
  if (note.data.deletedAt) throw new DomainError('not_found_or_forbidden', 'Note is not accessible', 404);
  return note;
}

async function changeNote(ctx: CommandContext, note: PrivateNote, patch: Partial<PrivateNoteData>, event: string): Promise<PrivateNote> {
  const updated = await updateDashboardRecord(ctx, note, { ...note.data, ...patch });
  await emitDashboardEvent(ctx, event, updated);
  return updated;
}

async function meetingProject(ctx: CommandContext, projectId: string): Promise<void> {
  if (ctx.command.projectId && ctx.command.projectId !== projectId) throw new DomainError('project_mismatch');
  await ctx.require('planning.edit', projectId);
  assertProjectWritable(await ctx.get(projectId, 'project'));
}

async function validateMeetingParticipants(ctx: CommandContext, projectId: string, participantIds: string[]): Promise<void> {
  const result = await ctx.sql.query<{ user_id: string }>(`SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))`, [ctx.workspaceId, participantIds, projectId]);
  if (result.rows.length !== participantIds.length) throw new DomainError('meeting_participant_not_active', 'Every participant must be an active member with access to this project');
}

async function existingMeeting(ctx: CommandContext): Promise<ProjectMeeting> {
  if (!ctx.command.targetId) throw new DomainError('target_required');
  const meeting = await readDashboardRecord<ProjectMeetingData>(ctx, ctx.command.targetId, 'project_meeting');
  if (!meeting.projectId) throw new DomainError('project_required');
  await meetingProject(ctx, meeting.projectId);
  if (meeting.data.cancelledAt) throw new DomainError('meeting_cancelled', 'Cancelled meetings cannot be edited', 409);
  return meeting;
}

export const dashboardPersonalCommands: CommandRegistry = {
  WatchTask: {
    payload: z.strictObject({ taskId: reference }),
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      if (ctx.command.targetId) throw new DomainError('invalid_scope');
      const task = await ctx.get(ctx.command.payload.taskId as string, 'work_item');
      if (!task.projectId) throw new DomainError('project_required');
      if (ctx.command.projectId && ctx.command.projectId !== task.projectId) throw new DomainError('project_mismatch');
      await ctx.require('domain.read', task.projectId);
      const existing = (await listDashboardRecords<TaskWatchData>(ctx, 'task_watch')).find(record => record.data.taskId === task.id && record.data.watching);
      if (existing) return existing;
      const watch = await insertDashboardRecord(ctx, { kind: 'task_watch', ownerId: ctx.actor.id, projectId: task.projectId, data: { taskId: task.id, watching: true } });
      await emitDashboardEvent(ctx, 'TaskWatched', watch);
      return watch;
    },
  },
  UnwatchTask: {
    payload: empty,
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      if (!ctx.command.targetId) throw new DomainError('target_required');
      const watch = await readDashboardRecord<TaskWatchData>(ctx, ctx.command.targetId, 'task_watch');
      if (ctx.command.projectId && ctx.command.projectId !== watch.projectId) throw new DomainError('project_mismatch');
      const updated = await updateDashboardRecord(ctx, watch, { ...watch.data, watching: false });
      await emitDashboardEvent(ctx, 'TaskUnwatched', updated);
      return updated;
    },
  },
  UpdateSelfProfile: {
    payload: selfProfilePayload,
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      if (ctx.command.projectId || ctx.command.targetId !== ctx.actor.id) throw new DomainError('invalid_scope');
      const expected = ctx.command.expectedVersions?.[ctx.actor.id];
      const payload = ctx.command.payload as z.infer<typeof selfProfilePayload>;
      const updated = await ctx.sql.query<{ profile_version: number }>(`UPDATE users SET name=coalesce($2,name),time_zone=coalesce($3,time_zone),
        job_title=CASE WHEN $5 THEN $6 ELSE job_title END,phone=CASE WHEN $7 THEN $8 ELSE phone END,
        avatar_data_url=CASE WHEN $9 THEN $10 ELSE avatar_data_url END,profile_version=profile_version+1,profile_updated_at=clock_timestamp()
        WHERE id=$1 AND profile_version=$4 AND disabled_at IS NULL RETURNING profile_version`,
      [ctx.actor.id, payload.name ?? null, payload.timeZone ?? null, expected ?? null,
        payload.jobTitle !== undefined, payload.jobTitle ?? null, payload.phone !== undefined, payload.phone ?? null, payload.avatarDataUrl !== undefined, payload.avatarDataUrl ?? null]);
      const row = updated.rows[0];
      if (!row) {
        const current = await readSelfProfile(ctx);
        throw new DomainError('version_conflict', 'Profile version changed or expected version is missing', 409, { id: ctx.actor.id, currentVersion: current.version });
      }
      const profile = await readSelfProfile(ctx);
      await ctx.sql.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id,audience_actor_id)
        SELECT $1,$2,NULL,$3,'self_profile',$4,coalesce(max(aggregate_sequence),0)+1,'SelfProfileUpdated',$5::jsonb,$3,$6,$3
        FROM outbox WHERE workspace_id=$2 AND aggregate_id=$3`,
      [randomUUID(), ctx.workspaceId, ctx.actor.id, row.profile_version, JSON.stringify({ id: ctx.actor.id, kind: 'self_profile', version: row.profile_version }), ctx.command.commandId]);
      return profile;
    },
  },
  CreatePrivateNote: {
    payload: z.strictObject({ content }),
    async handler(ctx) {
      await requireDashboardSelf(ctx);
      if (ctx.command.projectId || ctx.command.targetId) throw new DomainError('invalid_scope');
      const note = await insertDashboardRecord<PrivateNoteData>(ctx, { kind: 'private_note', ownerId: ctx.actor.id, data: { content: ctx.command.payload.content as string, completedAt: null, deletedAt: null } });
      await emitDashboardEvent(ctx, 'PrivateNoteCreated', note);
      return note;
    },
  },
  UpdatePrivateNote: {
    payload: z.strictObject({ content }),
    async handler(ctx) {
      const note = await existingNote(ctx);
      return changeNote(ctx, note, { content: ctx.command.payload.content as string }, 'PrivateNoteUpdated');
    },
  },
  CompletePrivateNote: {
    payload: empty,
    async handler(ctx) {
      const note = await existingNote(ctx);
      if (note.data.completedAt) throw new DomainError('note_already_completed', 'Note is already complete', 409);
      return changeNote(ctx, note, { completedAt: new Date().toISOString() }, 'PrivateNoteCompleted');
    },
  },
  ReopenPrivateNote: {
    payload: empty,
    async handler(ctx) {
      const note = await existingNote(ctx);
      if (!note.data.completedAt) throw new DomainError('note_not_completed', 'Note is not complete', 409);
      return changeNote(ctx, note, { completedAt: null }, 'PrivateNoteReopened');
    },
  },
  DeletePrivateNote: {
    payload: empty,
    async handler(ctx) {
      const note = await existingNote(ctx);
      return changeNote(ctx, note, { deletedAt: new Date().toISOString() }, 'PrivateNoteDeleted');
    },
  },
  CreateProjectMeeting: {
    payload: meetingPayload,
    async handler(ctx) {
      if (!ctx.command.projectId || ctx.command.targetId) throw new DomainError('invalid_scope');
      await meetingProject(ctx, ctx.command.projectId);
      const payload = ctx.command.payload as z.infer<typeof meetingPayload>;
      assertMeetingInterval(payload.startsAt, payload.endsAt);
      await validateMeetingParticipants(ctx, ctx.command.projectId, payload.participantIds);
      const meeting = await insertDashboardRecord<ProjectMeetingData>(ctx, { kind: 'project_meeting', projectId: ctx.command.projectId, data: { ...payload, startsAt: new Date(payload.startsAt).toISOString(), endsAt: new Date(payload.endsAt).toISOString(), cancelledAt: null, cancelledBy: null, cancellationReason: null } });
      await emitDashboardEvent(ctx, 'ProjectMeetingCreated', meeting);
      return meeting;
    },
  },
  UpdateProjectMeeting: {
    payload: meetingPayload,
    async handler(ctx) {
      const meeting = await existingMeeting(ctx);
      const payload = ctx.command.payload as z.infer<typeof meetingPayload>;
      assertMeetingInterval(payload.startsAt, payload.endsAt);
      await validateMeetingParticipants(ctx, meeting.projectId!, payload.participantIds);
      const updated = await updateDashboardRecord(ctx, meeting, { ...meeting.data, ...payload, startsAt: new Date(payload.startsAt).toISOString(), endsAt: new Date(payload.endsAt).toISOString() });
      await emitDashboardEvent(ctx, 'ProjectMeetingUpdated', updated);
      return updated;
    },
  },
  CancelProjectMeeting: {
    payload: z.strictObject({ reason: content }),
    async handler(ctx) {
      const meeting = await existingMeeting(ctx);
      const updated = await updateDashboardRecord(ctx, meeting, { ...meeting.data, cancelledAt: new Date().toISOString(), cancelledBy: ctx.actor.id, cancellationReason: ctx.command.payload.reason as string });
      await emitDashboardEvent(ctx, 'ProjectMeetingCancelled', updated);
      return updated;
    },
  },
};

export async function readPersonalDashboard(ctx: DashboardReadContext): Promise<PersonalDashboard> {
  if (!ctx.membership.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  const profile = await readSelfProfile(ctx);
  const visibleProjects = new Set((await ctx.core.list('project')).map(project => project.id));
  const tasks = new Map((await ctx.core.list('work_item')).map(task => [task.id, task]));
  const watches = (await listDashboardRecords<TaskWatchData>(ctx, 'task_watch')).filter(watch => {
    const task = tasks.get(watch.data.taskId);
    return watch.data.watching && !!task?.projectId && task.projectId === watch.projectId && visibleProjects.has(task.projectId);
  });
  const notes = (await listDashboardRecords<PrivateNoteData>(ctx, 'private_note')).filter(note => !note.data.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const meetings = (await listDashboardRecords<ProjectMeetingData>(ctx, 'project_meeting')).filter(meeting => meeting.projectId && visibleProjects.has(meeting.projectId)).sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt));
  const canListParticipants = ctx.membership.projectIds === null && ctx.membership.capabilities.includes('access.manage');
  const participants = await ctx.sql.query<{ user_id: string; name: string; project_ids: string[] | null }>(`SELECT m.user_id,u.name,m.project_ids FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND 'domain.read'=ANY(m.capabilities)
      AND ($2::boolean OR m.user_id=$3) ORDER BY u.name,m.user_id`, [ctx.workspaceId, canListParticipants, ctx.actor.id]);
  const meetingParticipants: MeetingParticipant[] = participants.rows.map(row => ({ userId: row.user_id, name: row.name, projectIds: row.project_ids }));
  return { profile, watches, notes, meetings, meetingParticipants, canListParticipants };
}
