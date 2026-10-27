import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { MemberCapacity, MemberCapacityData, TeamWorkload, TeamWorkloadMember, TeamWorkloadTask } from '../../domain/src/team-workload.ts';
import { MAX_MEMBER_CAPACITY_POINTS, memberOverloaded } from '../../domain/src/team-workload.ts';
import { MAX_WORK_ITEM_ESTIMATE_POINTS, statusCategory } from '../../pm-schema/index.ts';
import { getMembership, requireCapability } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, readDashboardRecord, updateDashboardRecord } from './dashboard-store.ts';
import { readMemberDirectory } from './member-directory.ts';
import type { CommandRegistry } from './ports.ts';
import { readTeamDirectory } from './team-directory.ts';

const capacityPayload = z.strictObject({
  userId: z.uuid().toLowerCase(),
  capacityPoints: z.number().finite().nonnegative().max(MAX_MEMBER_CAPACITY_POINTS).nullable(),
});

export const teamWorkloadCommands: CommandRegistry = {
  SetMemberCapacity: {
    payload: capacityPayload,
    async handler(ctx): Promise<MemberCapacity> {
      await ctx.require('access.manage');
      if (ctx.command.projectId) throw new DomainError('scope_mismatch', 'Member capacity targets the workspace');
      const payload = capacityPayload.parse(ctx.command.payload);
      const member = await ctx.sql.query(`SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.workspaceId, payload.userId]);
      if (!member.rows[0]) throw new DomainError('not_found_or_forbidden', 'Capacity requires an active workspace member', 404);
      const previous = await ctx.sql.query<{ id: string; version: number }>(`SELECT id,version FROM dashboard_records
        WHERE workspace_id=$1 AND kind='member_capacity' AND project_id IS NULL AND owner_id IS NULL AND data->>'userId'=$2`, [ctx.workspaceId, payload.userId]);
      const head = previous.rows[0];
      let capacity: MemberCapacity;
      if (head) {
        if (ctx.command.targetId !== head.id || ctx.command.expectedVersions?.[head.id] !== head.version) {
          throw new DomainError('version_conflict', 'Capacity record or version changed or expected version is missing', 409, { id: head.id, currentVersion: head.version });
        }
        const current = await readDashboardRecord<MemberCapacityData>(ctx, head.id, 'member_capacity');
        capacity = await updateDashboardRecord(ctx, current, payload);
      } else {
        if (ctx.command.targetId) throw new DomainError('not_found_or_forbidden', 'Capacity record is not accessible', 404);
        capacity = await insertDashboardRecord<MemberCapacityData>(ctx, { kind: 'member_capacity', data: payload });
      }
      await emitDashboardEvent(ctx, 'MemberCapacitySet', capacity);
      return capacity;
    },
  },
};

type ActiveMemberRow = { user_id: string; project_ids: string[] | null; can_read: boolean };
type CapacityRow = { id: string; version: number; data: MemberCapacityData };

/** People and team relations reuse the established, authorization-trimmed directories. */
export async function readTeamWorkload(ctx: DashboardReadContext): Promise<TeamWorkload> {
  const membership = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  if (!membership.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required for workload', 403);
  const directory = await readMemberDirectory(ctx);
  const [organization, projects, source, entities] = await Promise.all([
    readTeamDirectory(ctx), ctx.core.list('project'), ctx.core.records(), ctx.core.list('work_item'),
  ]);
  const visibleProjects = projects.filter(project => project.workspaceId === ctx.workspaceId && (membership.projectIds === null || membership.projectIds.includes(project.id)));
  for (const project of visibleProjects) await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', project.id);
  const projectIds = new Set(visibleProjects.map(project => project.id));
  const liveProjects = new Set(visibleProjects.filter(project => project.data.archived !== true && !project.data.archivedAt).map(project => project.id));
  const records = new Map(source.filter(record => record.entity.entity === 'work_item' || record.entity.entity === 'project').map(record => [record.id, record]));
  // Invalid sources are explicitly unavailable, never an empty workload or a false non-overload.
  if (source.some(record => (record.entity.entity === 'work_item' && projectIds.has(String(record.entity.project)) || record.entity.entity === 'project' && projectIds.has(record.id))
    && (record.stale || record.diagnostics?.some(diagnostic => diagnostic.severity === 'error')))) {
    throw new DomainError('workload_inputs_unavailable', 'Authoritative workload inputs are stale or invalid', 409);
  }
  const active = await ctx.sql.query<ActiveMemberRow>(`SELECT m.user_id,m.project_ids,'domain.read'=ANY(m.capabilities) AS can_read
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[])
      AND m.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.workspaceId, directory.members.map(member => member.userId)]);
  const accessByUser = new Map(active.rows.map(row => [row.user_id, row]));
  const capacities = await ctx.sql.query<CapacityRow>(`SELECT id,version,data FROM dashboard_records WHERE workspace_id=$1
    AND kind='member_capacity' AND project_id IS NULL AND owner_id IS NULL AND data->>'userId'=ANY($2::text[])`, [ctx.workspaceId, [...accessByUser.keys()]]);
  const capacityByUser = new Map(capacities.rows.map(row => [row.data.userId, { id: row.id, version: row.version, capacityPoints: row.data.capacityPoints }]));
  const teams = organization.teams.filter(team => team.data.archivedAt === null).map(team => ({
    id: team.id, name: team.data.name, memberIds: team.data.memberIds.filter(id => accessByUser.has(id)), taskIds: [] as string[],
  }));
  const teamById = new Map(teams.map(team => [team.id, team]));
  const teamsByProject = new Map<string, string[]>();
  for (const team of organization.teams) {
    if (!teamById.has(team.id)) continue;
    for (const projectId of team.projectIds) {
      if (!projectIds.has(projectId)) continue;
      const ids = teamsByProject.get(projectId) ?? [];
      ids.push(team.id);
      teamsByProject.set(projectId, ids);
    }
  }
  const members: TeamWorkloadMember[] = directory.members.filter(member => accessByUser.has(member.userId)).map(member => {
    // Current grants cannot prove that no historical assignment survives in a hidden project.
    const complete = membership.projectIds === null;
    const capacity = capacityByUser.get(member.userId) ?? null;
    return {
      userId: member.userId, teamIds: member.teams.map(team => team.id).filter(id => teamById.has(id)), taskIds: [],
      openCount: 0, doneCount: 0, knownOpenPoints: 0, unknownEstimateCount: 0,
      capacity, capacityPoints: capacity?.capacityPoints ?? null, overloaded: null,
      scope: { complete, reason: complete ? 'workspace' : 'partial' },
    };
  });
  const memberById = new Map(members.map(member => [member.userId, member]));
  const tasks: TeamWorkloadTask[] = [];
  const configuration = ctx.core.configuration();
  for (const entity of entities) {
    if (entity.workspaceId !== ctx.workspaceId || !entity.projectId || !liveProjects.has(entity.projectId) || entity.data.archived === true || entity.data.archivedAt) continue;
    const record = records.get(entity.id);
    const category = record ? statusCategory(record.entity, configuration) : undefined;
    if (!record || !category) throw new DomainError('workload_inputs_unavailable', 'Authoritative task workflow evidence is unavailable', 409);
    const rawAssignee = entity.data.assigneeId;
    const candidateId = typeof rawAssignee === 'string' && rawAssignee ? rawAssignee.toLowerCase() : null;
    const candidate = candidateId ? memberById.get(candidateId) : undefined;
    const access = candidateId ? accessByUser.get(candidateId) : undefined;
    const attributable = !!candidate && !!access?.can_read && (access.project_ids === null || access.project_ids.includes(entity.projectId));
    if (candidate && !attributable && category !== 'completed' && category !== 'canceled') candidate.scope = { complete: false, reason: 'partial' };
    const member = attributable ? candidate : undefined;
    const assigneeId = member?.userId ?? null;
    const assigneeStatus = candidateId === null ? 'unassigned' : member ? 'assigned' : 'unavailable';
    // Preserve the authorized work itself, while redacting inaccessible identity evidence.
    const estimate = entity.data.estimatePoints;
    const estimatePoints = typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0 && estimate <= MAX_WORK_ITEM_ESTIMATE_POINTS ? estimate : null;
    const task: TeamWorkloadTask = {
      id: entity.id, title: String(entity.data.title ?? ''), projectId: entity.projectId, assigneeId, assigneeStatus,
      teamIds: member ? [...member.teamIds] : [...(teamsByProject.get(entity.projectId) ?? [])],
      status: String(record.entity.status), statusCategory: category,
      open: category !== 'completed' && category !== 'canceled', done: category === 'completed', estimatePoints,
    };
    tasks.push(task);
    for (const teamId of task.teamIds) teamById.get(teamId)!.taskIds.push(task.id);
    if (member) {
      member.taskIds.push(task.id);
      if (task.open) {
        member.openCount++;
        if (estimatePoints === null) member.unknownEstimateCount++;
        else member.knownOpenPoints += estimatePoints;
      }
      if (task.done) member.doneCount++;
    }
  }
  for (const member of members) member.overloaded = memberOverloaded(member.knownOpenPoints, member.unknownEstimateCount, member.capacityPoints, member.scope.complete);
  const open = tasks.filter(task => task.open);
  return {
    serverNow: ctx.now.toISOString(), unit: 'concurrent_open_points', members, tasks, teams,
    unassignedTaskIds: tasks.filter(task => task.assigneeId === null && task.open).map(task => task.id),
    summary: {
      openCount: open.length, doneCount: tasks.filter(task => task.done).length,
      knownOpenPoints: open.reduce((sum, task) => sum + (task.estimatePoints ?? 0), 0),
      unknownEstimateCount: open.filter(task => task.estimatePoints === null).length,
      unknownAssigneeCount: open.filter(task => task.assigneeStatus === 'unavailable').length,
      overloadedMemberCount: members.filter(member => member.overloaded === true).length,
      unknownOverloadMemberCount: members.filter(member => member.overloaded === null).length,
    },
    scope: { complete: membership.projectIds === null, projectIds: [...projectIds], reason: membership.projectIds === null ? 'workspace' : 'projects' },
  };
}
