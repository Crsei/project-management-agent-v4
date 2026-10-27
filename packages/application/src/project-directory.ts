import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Entity } from '../../domain/src/core.ts';
import type { DashboardRecord } from '../../domain/src/dashboard.ts';
import type { ProjectDirectory, ProjectDirectoryProject, ProjectIdentity, ProjectTeam, ProjectTeamAssignment } from '../../domain/src/project-directory.ts';
import { assertProjectWritable, assertRule } from '../../domain/src/planning.ts';
import { getMembership, requireCapability } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, listDashboardRecords, readDashboardRecord, updateDashboardRecord } from './dashboard-store.ts';
import type { CommandContext, CommandRegistry } from './ports.ts';

const uuid = z.uuid().toLowerCase();
const name = z.string().trim().min(1).max(160);
const memberIds = z.array(uuid).max(1000).refine(ids => new Set(ids).size === ids.length, 'Duplicate member IDs');
const teamIds = z.array(uuid).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate team IDs');
const details = {
  name,
  identifier: z.string().trim().min(1).max(64).nullable(),
  description: z.string().trim().max(5000),
  focus: z.string().trim().min(1).max(500).nullable(),
  responseTargetHours: z.number().finite().min(0).max(8760).nullable(),
};
const createTeamPayload = z.strictObject({
  name, memberIds: memberIds.default([]), maintainerIds: memberIds.default([]),
  identifier: details.identifier.default(null), description: details.description.default(''),
  focus: details.focus.default(null), responseTargetHours: details.responseTargetHours.default(null),
});
const teamDetailsPayload = z.strictObject(details);
const teamMaintainersPayload = z.strictObject({ maintainerIds: memberIds });
const renameTeamPayload = z.strictObject({ name });
const teamMembersPayload = z.strictObject({ memberIds });
const projectTeamsPayload = z.strictObject({ teamIds });

async function workspaceManager(ctx: CommandContext): Promise<void> {
  await ctx.require('access.manage');
  if (ctx.command.projectId) throw new DomainError('scope_mismatch', 'Team maintenance targets the workspace');
}
async function currentMembers(ctx: CommandContext, ids: string[]): Promise<void> {
  const result = await ctx.sql.query<{ id: string }>(`SELECT m.user_id AS id FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.workspaceId, ids]);
  if (result.rows.length !== ids.length) throw new DomainError('not_found_or_forbidden', 'Team members must be existing active workspace members', 404);
}
function maintainersBelongToTeam(ids: string[], members: string[]): void {
  const allowed = new Set(members);
  assertRule(ids.every(id => allowed.has(id)), 'invalid_team_maintainers', 'Maintainers must be current team members');
}
function checkRecordVersion(ctx: CommandContext, record: DashboardRecord<unknown>): void {
  if (ctx.command.expectedVersions?.[record.id] !== record.version) throw new DomainError('version_conflict', 'Team or assignment version changed or expected version is missing', 409, { id: record.id, currentVersion: record.version });
}
async function teamForWrite(ctx: CommandContext): Promise<DashboardRecord<ProjectTeam>> {
  await workspaceManager(ctx);
  assertRule(ctx.command.targetId, 'target_required');
  const team = await readDashboardRecord<ProjectTeam>(ctx, ctx.command.targetId, 'project_team');
  checkRecordVersion(ctx, team);
  assertRule(team.data.archivedAt === null, 'team_archived');
  if (team.data.maintainerIds.length) {
    const active = await ctx.sql.query<{ id: string }>(`SELECT m.user_id AS id FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.workspaceId, team.data.maintainerIds]);
    const ids = new Set(active.rows.map(row => row.id));
    team.data = { ...team.data, maintainerIds: team.data.maintainerIds.filter(id => ids.has(id) && team.data.memberIds.includes(id)) };
  }
  return team;
}
async function projectForAssignment(ctx: CommandContext): Promise<Entity> {
  await ctx.require('access.manage');
  assertRule(ctx.command.targetId, 'target_required');
  assertRule(!ctx.command.projectId || ctx.command.projectId === ctx.command.targetId, 'project_mismatch');
  const project = await ctx.get(ctx.command.targetId, 'project');
  assertRule(project.data.archived !== true && !project.data.archivedAt, 'object_archived');
  assertProjectWritable(project);
  ctx.checkVersion(project);
  return project;
}

export const projectDirectoryCommands: CommandRegistry = {
  CreateProjectTeam: {
    payload: createTeamPayload,
    async handler(ctx): Promise<DashboardRecord<ProjectTeam>> {
      await workspaceManager(ctx);
      if (ctx.command.targetId) throw new DomainError('scope_mismatch', 'New teams do not target an existing record');
      const payload = createTeamPayload.parse(ctx.command.payload);
      maintainersBelongToTeam(payload.maintainerIds, payload.memberIds);
      await currentMembers(ctx, payload.memberIds);
      const team = await insertDashboardRecord<ProjectTeam>(ctx, { kind: 'project_team', data: { ...payload, archivedAt: null } });
      await emitDashboardEvent(ctx, 'ProjectTeamCreated', team);
      return team;
    },
  },
  RenameProjectTeam: {
    payload: renameTeamPayload,
    async handler(ctx): Promise<DashboardRecord<ProjectTeam>> {
      const team = await teamForWrite(ctx);
      const payload = renameTeamPayload.parse(ctx.command.payload);
      const updated = await updateDashboardRecord(ctx, team, { ...team.data, name: payload.name });
      await emitDashboardEvent(ctx, 'ProjectTeamRenamed', updated);
      return updated;
    },
  },
  UpdateProjectTeamDetails: {
    payload: teamDetailsPayload,
    async handler(ctx): Promise<DashboardRecord<ProjectTeam>> {
      const team = await teamForWrite(ctx);
      const payload = teamDetailsPayload.parse(ctx.command.payload);
      const updated = await updateDashboardRecord(ctx, team, { ...team.data, ...payload });
      await emitDashboardEvent(ctx, 'ProjectTeamDetailsUpdated', updated);
      return updated;
    },
  },
  SetProjectTeamMaintainers: {
    payload: teamMaintainersPayload,
    async handler(ctx): Promise<DashboardRecord<ProjectTeam>> {
      const team = await teamForWrite(ctx);
      const payload = teamMaintainersPayload.parse(ctx.command.payload);
      maintainersBelongToTeam(payload.maintainerIds, team.data.memberIds);
      await currentMembers(ctx, payload.maintainerIds);
      const updated = await updateDashboardRecord(ctx, team, { ...team.data, maintainerIds: payload.maintainerIds });
      await emitDashboardEvent(ctx, 'ProjectTeamMaintainersSet', updated);
      return updated;
    },
  },
  SetProjectTeamMembers: {
    payload: teamMembersPayload,
    async handler(ctx): Promise<DashboardRecord<ProjectTeam>> {
      const team = await teamForWrite(ctx);
      const payload = teamMembersPayload.parse(ctx.command.payload);
      await currentMembers(ctx, payload.memberIds);
      const members = new Set(payload.memberIds);
      const updated = await updateDashboardRecord(ctx, team, { ...team.data, memberIds: payload.memberIds, maintainerIds: team.data.maintainerIds.filter(id => members.has(id)) });
      await emitDashboardEvent(ctx, 'ProjectTeamMembersSet', updated);
      return updated;
    },
  },
  ArchiveProjectTeam: {
    payload: z.strictObject({}),
    async handler(ctx): Promise<DashboardRecord<ProjectTeam>> {
      const team = await teamForWrite(ctx);
      const updated = await updateDashboardRecord(ctx, team, { ...team.data, archivedAt: new Date().toISOString() });
      await emitDashboardEvent(ctx, 'ProjectTeamArchived', updated);
      return updated;
    },
  },
  SetProjectTeams: {
    payload: projectTeamsPayload,
    async handler(ctx): Promise<DashboardRecord<ProjectTeamAssignment>> {
      const project = await projectForAssignment(ctx);
      const payload = projectTeamsPayload.parse(ctx.command.payload);
      for (const id of payload.teamIds) {
        const team = await readDashboardRecord<ProjectTeam>(ctx, id, 'project_team');
        assertRule(team.data.archivedAt === null, 'team_archived');
        checkRecordVersion(ctx, team);
      }
      const previous = await ctx.sql.query<{ id: string }>("SELECT id FROM dashboard_records WHERE workspace_id=$1 AND project_id=$2 AND kind='project_team_assignment'", [ctx.workspaceId, project.id]);
      const id = previous.rows[0]?.id;
      const assignment = id
        ? await updateDashboardRecord(ctx, await readDashboardRecord<ProjectTeamAssignment>(ctx, id, 'project_team_assignment'), payload)
        : await insertDashboardRecord(ctx, { kind: 'project_team_assignment', projectId: project.id, data: payload });
      await emitDashboardEvent(ctx, 'ProjectTeamsSet', assignment);
      return assignment;
    },
  },
};

type TeamReadRow = { id: string; data: ProjectTeam };
type AssignmentReadRow = { id: string; project_id: string; version: number; data: ProjectTeamAssignment };
function addIdentity(ids: Set<string>, value: unknown): void {
  const parsed = uuid.safeParse(value);
  if (parsed.success) ids.add(parsed.data);
}

export async function readProjectDirectory(ctx: DashboardReadContext): Promise<ProjectDirectory> {
  // Refresh authority instead of trusting the route's earlier membership snapshot.
  const membership = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  const canRead = membership.capabilities.includes('domain.read');
  const canManage = membership.projectIds === null && membership.capabilities.includes('access.manage');
  if (!canRead && !canManage) throw new DomainError('permission_denied', 'Capability domain.read or workspace access.manage is required', 403);
  const projects = canRead ? (await ctx.core.list('project')).filter(project => project.workspaceId === ctx.workspaceId && (membership.projectIds === null || membership.projectIds.includes(project.id))) : [];
  for (const project of projects) await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', project.id);
  const visible = new Set(projects.map(project => project.id));
  const [tasks, milestones]: [Entity[], Entity[]] = canRead ? await Promise.all([ctx.core.list('work_item'), ctx.core.list('milestone')]) : [[], []];
  const candidates = new Map<string, Set<string>>();
  for (const project of projects) {
    const ids = new Set<string>();
    addIdentity(ids, project.data.ownerId);
    candidates.set(project.id, ids);
  }
  for (const entity of [...tasks, ...milestones]) {
    if (!entity.projectId || !visible.has(entity.projectId)) continue;
    const ids = candidates.get(entity.projectId)!;
    addIdentity(ids, entity.data.assigneeId);
    addIdentity(ids, entity.data.ownerId);
  }
  const assignments = await ctx.sql.query<AssignmentReadRow>(`SELECT id,project_id,version,data FROM dashboard_records
    WHERE workspace_id=$1 AND project_id=ANY($2::text[]) AND kind='project_team_assignment' AND owner_id IS NULL`, [ctx.workspaceId, [...visible]]);
  const associatedIds = [...new Set(assignments.rows.flatMap(row => row.data.teamIds))];
  // Never use listDashboardRecords for workspace teams on a project-scoped read.
  const teams = await ctx.sql.query<TeamReadRow>(`SELECT id,data FROM dashboard_records WHERE workspace_id=$1 AND id=ANY($2::uuid[])
    AND kind='project_team' AND project_id IS NULL AND owner_id IS NULL AND data->>'archivedAt' IS NULL ORDER BY created_at,id`, [ctx.workspaceId, associatedIds]);
  const teamMap = new Map(teams.rows.map(team => [team.id, team]));
  const result: ProjectDirectory = { projects: [], management: null };
  for (const project of projects) {
    const assignment = assignments.rows.find(row => row.project_id === project.id);
    const associated = (assignment?.data.teamIds ?? []).flatMap(id => { const team = teamMap.get(id); return team ? [team] : []; });
    const ids = candidates.get(project.id)!;
    for (const team of associated) for (const id of team.data.memberIds) ids.add(id);
    const identities = await ctx.sql.query<ProjectIdentity>(`SELECT m.user_id AS id,u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids)) ORDER BY u.name,m.user_id`, [ctx.workspaceId, [...ids], project.id]);
    const byId = new Map(identities.rows.map(identity => [identity.id, identity]));
    const view: ProjectDirectoryProject = {
      projectId: project.id,
      identities: identities.rows,
      teams: associated.map(team => ({ id: team.id, name: team.data.name, members: team.data.memberIds.flatMap(id => { const identity = byId.get(id); return identity ? [identity] : []; }) })),
      assignment: assignment ? { id: assignment.id, version: assignment.version } : null,
    };
    result.projects.push(view);
  }
  if (canManage) {
    await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'access.manage');
    const members = await ctx.sql.query<ProjectIdentity>(`SELECT m.user_id AS id,u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.revoked_at IS NULL AND u.disabled_at IS NULL ORDER BY u.name,m.user_id`, [ctx.workspaceId]);
    const activeIds = new Set(members.rows.map(member => member.id));
    result.management = {
      members: members.rows,
      teams: (await listDashboardRecords<ProjectTeam>(ctx, 'project_team')).map(team => ({ ...team, data: { ...team.data,
        memberIds: team.data.memberIds.filter(id => activeIds.has(id)),
        maintainerIds: team.data.maintainerIds.filter(id => activeIds.has(id) && team.data.memberIds.includes(id)),
      } })),
    };
  }
  return result;
}
