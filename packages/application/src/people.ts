import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { DashboardRecord } from '../../domain/src/dashboard.ts';
import type { PeopleAccountLookup, PeopleCandidatePage, PeopleCandidateQuery, PeopleIdentity, ProjectParticipation, ProjectPeople } from '../../domain/src/people.ts';
import type { ProjectIdentity, ProjectTeam, ProjectTeamAssignment } from '../../domain/src/project-directory.ts';
import { assertProjectWritable, assertRule } from '../../domain/src/planning.ts';
import { getMembership, requireCapability } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, readDashboardRecord, updateDashboardRecord } from './dashboard-store.ts';
import type { CommandRegistry } from './ports.ts';

const uuid = z.uuid().toLowerCase();
const projectId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const peopleCandidateQuerySchema = z.strictObject({
  purpose: z.enum(['assignee', 'participant', 'team', 'project_owner']),
  projectId: projectId.optional(), q: z.string().trim().max(200).optional(),
  after: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine((input, ctx) => {
  const scoped = input.purpose === 'assignee' || input.purpose === 'participant';
  if (scoped !== (input.projectId !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only assignee and participant candidates require projectId', path: ['projectId'] });
});
export const peopleAccountQuerySchema = z.strictObject({ email: z.email().trim().toLowerCase().max(320) });
export const projectParticipantsPayloadSchema = z.strictObject({ memberIds: z.array(uuid).max(1000).refine(ids => new Set(ids).size === ids.length, 'Duplicate member IDs') });
const cursorSchema = z.strictObject({ workspaceId: uuid, actorId: uuid, purpose: z.string(), projectId: z.string().nullable(), q: z.string(), userId: uuid });
const identityColumns = 'u.id AS "userId",u.name,u.avatar_data_url AS "avatarDataUrl",u.job_title AS "jobTitle"';

export async function readPeopleCandidates(ctx: DashboardReadContext, raw: PeopleCandidateQuery): Promise<PeopleCandidatePage> {
  const input = peopleCandidateQuerySchema.parse(raw);
  if (input.purpose === 'team') await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'access.manage');
  else if (input.purpose === 'project_owner') {
    await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'planning.edit');
    await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read');
  } else {
    await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', input.projectId);
    const project = await ctx.core.get(input.projectId!, 'project');
    if (project.workspaceId !== ctx.workspaceId) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  }
  const scope = { workspaceId: ctx.workspaceId, actorId: ctx.actor.id, purpose: input.purpose, projectId: input.projectId ?? null, q: input.q ?? '' };
  let after: string | null = null;
  if (input.after) {
    try {
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')));
      if (cursor.workspaceId !== scope.workspaceId || cursor.actorId !== scope.actorId || cursor.purpose !== scope.purpose || cursor.projectId !== scope.projectId || cursor.q !== scope.q) throw new Error('Scope changed');
      after = cursor.userId;
    } catch { throw new DomainError('validation_failed', 'Candidate cursor does not match this query', 400); }
  }
  const result = await ctx.sql.query<PeopleIdentity>(`SELECT ${identityColumns} FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND ($2::text='team' OR ('domain.read'=ANY(m.capabilities) AND
        (($2='project_owner' AND m.project_ids IS NULL) OR ($2 IN ('assignee','participant') AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))))))
      AND ($4::uuid IS NULL OR u.id>$4::uuid) AND ($5::text='' OR strpos(lower(u.name),lower($5))>0)
    ORDER BY u.id LIMIT $6`, [ctx.workspaceId, input.purpose, input.projectId ?? null, after, input.q ?? '', input.limit + 1]);
  const items = result.rows.slice(0, input.limit);
  return { items, nextCursor: result.rows.length > input.limit ? Buffer.from(JSON.stringify({ ...scope, userId: items[items.length - 1]!.userId })).toString('base64url') : null };
}

/** The only cross-workspace account lookup is an exact-email, unrestricted administrator operation. */
export async function lookupPeopleAccount(ctx: DashboardReadContext, email: string): Promise<PeopleAccountLookup> {
  await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'access.manage');
  const input = peopleAccountQuerySchema.parse({ email });
  const result = await ctx.sql.query<PeopleIdentity>(`SELECT ${identityColumns} FROM users u WHERE lower(u.email)=$1 AND u.disabled_at IS NULL LIMIT 1`, [input.email]);
  return { account: result.rows[0] ?? null };
}

export async function readProjectPeople(ctx: DashboardReadContext, id: string): Promise<ProjectPeople> {
  projectId.parse(id);
  await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', id);
  const project = await ctx.core.get(id, 'project');
  if (project.workspaceId !== ctx.workspaceId) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  const membership = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  const manager = membership.projectIds === null && membership.capabilities.includes('access.manage');
  let canManage = manager && project.data.archived !== true && !project.data.archivedAt;
  try { assertProjectWritable(project); } catch { canManage = false; }
  const saved = await ctx.sql.query<{ id: string; version: number; data: ProjectParticipation }>(`SELECT id,version,data FROM dashboard_records
    WHERE workspace_id=$1 AND project_id=$2 AND kind='project_participation' AND owner_id IS NULL`, [ctx.workspaceId, id]);
  const record = saved.rows[0];
  const identities = await ctx.sql.query<PeopleIdentity>(`SELECT ${identityColumns} FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids)) ORDER BY u.name,u.id`, [ctx.workspaceId, record?.data.memberIds ?? [], id]);
  const assignments = await ctx.sql.query<{ data: ProjectTeamAssignment }>(`SELECT data FROM dashboard_records
    WHERE workspace_id=$1 AND project_id=$2 AND kind='project_team_assignment' AND owner_id IS NULL`, [ctx.workspaceId, id]);
  const teams = await ctx.sql.query<{ id: string; data: ProjectTeam }>(`SELECT id,data FROM dashboard_records
    WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='project_team' AND project_id IS NULL AND owner_id IS NULL
      AND data->>'archivedAt' IS NULL ORDER BY created_at,id`, [ctx.workspaceId, assignments.rows[0]?.data.teamIds ?? []]);
  const teamMembers = await ctx.sql.query<ProjectIdentity>(`SELECT m.user_id AS id,u.name FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))`, [ctx.workspaceId, [...new Set(teams.rows.flatMap(team => team.data.memberIds))], id]);
  const teamIdentities = new Map(teamMembers.rows.map(person => [person.id, person]));
  return { projectId: id, projectVersion: project.version,
    participation: record ? { id: record.id, version: record.version, memberIds: manager ? record.data.memberIds : identities.rows.map(person => person.userId) } : null,
    participants: identities.rows, teams: teams.rows.map(team => ({ id: team.id, name: team.data.name,
      members: team.data.memberIds.flatMap(userId => { const person = teamIdentities.get(userId); return person ? [person] : []; }) })),
    canManage: Boolean(canManage), scope: { projectIds: membership.projectIds } };
}

export const peopleCommands: CommandRegistry = {
  SetProjectParticipants: {
    payload: projectParticipantsPayloadSchema,
    async handler(ctx): Promise<DashboardRecord<ProjectParticipation>> {
      // Matching team management: a project label never grants access.manage.
      await ctx.require('access.manage');
      assertRule(ctx.command.targetId, 'target_required');
      assertRule(!ctx.command.projectId || ctx.command.projectId === ctx.command.targetId, 'project_mismatch');
      const id = projectId.parse(ctx.command.targetId);
      await ctx.require('domain.read', id);
      const project = await ctx.get(id, 'project');
      assertRule(project.workspaceId === ctx.workspaceId, 'project_mismatch');
      assertRule(project.data.archived !== true && !project.data.archivedAt, 'object_archived');
      assertProjectWritable(project);
      ctx.checkVersion(project);
      const payload = projectParticipantsPayloadSchema.parse(ctx.command.payload);
      const eligible = await ctx.sql.query<{ id: string }>(`SELECT m.user_id AS id FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL
          AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))`, [ctx.workspaceId, payload.memberIds, id]);
      if (eligible.rows.length !== payload.memberIds.length) throw new DomainError('not_found_or_forbidden', 'Participants require active readable project membership', 404);
      const previous = await ctx.sql.query<{ id: string }>(`SELECT id FROM dashboard_records WHERE workspace_id=$1 AND project_id=$2 AND kind='project_participation'`, [ctx.workspaceId, id]);
      const saved = previous.rows[0];
      const participation = saved
        ? await updateDashboardRecord(ctx, await readDashboardRecord<ProjectParticipation>(ctx, saved.id, 'project_participation'), payload)
        : await insertDashboardRecord(ctx, { kind: 'project_participation', projectId: id, data: payload });
      await emitDashboardEvent(ctx, 'ProjectParticipantsSet', participation);
      return participation;
    },
  },
};
