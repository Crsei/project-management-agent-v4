import type { DashboardRecord } from '../../domain/src/dashboard.ts';
import type { ProjectTeam, ProjectTeamAssignment } from '../../domain/src/project-directory.ts';
import type { TeamDirectory, TeamDirectoryTeam } from '../../domain/src/team-directory.ts';
import { assertProjectWritable } from '../../domain/src/planning.ts';
import { statusCategory, type FileRecord } from '../../pm-schema/index.ts';
import { getMembership } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { readProjectDirectory } from './project-directory.ts';

type TeamRow = {
  id: string; workspace_id: string; project_id: null; kind: string; owner_id: null; version: number;
  data: ProjectTeam; created_at: Date; updated_at: Date; created_by: string;
};
type AssignmentRow = { project_id: string; data: ProjectTeamAssignment; updated_at: Date };
function unreadable(record: FileRecord): boolean {
  return record.stale === true || record.diagnostics?.some(issue => issue.severity === 'error') === true;
}

/** Reuses the project directory's current authority and identity intersections, not a second team store. */
export async function readTeamDirectory(ctx: DashboardReadContext): Promise<TeamDirectory> {
  const directory = await readProjectDirectory(ctx);
  const membership = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  const canRead = membership.capabilities.includes('domain.read');
  const canManage = directory.management !== null && membership.projectIds === null && membership.capabilities.includes('access.manage');
  const visible = new Set(canRead ? directory.projects.filter(project => membership.projectIds === null || membership.projectIds.includes(project.projectId)).map(project => project.projectId) : []);
  const projectViews = directory.projects.filter(project => visible.has(project.projectId));
  const associatedIds = [...new Set(projectViews.flatMap(project => project.teams.map(team => team.id)))];
  const [projects, records, assignments] = await Promise.all([
    canRead ? ctx.core.list('project') : [],
    canRead ? ctx.core.records() : [],
    ctx.sql.query<AssignmentRow>(`SELECT project_id,data,updated_at FROM dashboard_records WHERE workspace_id=$1
      AND project_id=ANY($2::text[]) AND kind='project_team_assignment' AND owner_id IS NULL`, [ctx.workspaceId, [...visible]]),
  ]);
  const teams = canManage ? directory.management!.teams : (await ctx.sql.query<TeamRow>(`SELECT * FROM dashboard_records
    WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='project_team' AND project_id IS NULL AND owner_id IS NULL
    AND data->>'archivedAt' IS NULL ORDER BY created_at,id`, [ctx.workspaceId, associatedIds])).rows.map((row): DashboardRecord<ProjectTeam> => ({
      id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, kind: row.kind, ownerId: row.owner_id,
      version: row.version, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), createdBy: row.created_by,
    }));
  const identities = new Set(canManage ? directory.management!.members.map(member => member.id) : projectViews.flatMap(project => project.identities.map(identity => identity.id)));
  const membersByTeam = new Map<string, Set<string>>();
  for (const project of projectViews) for (const team of project.teams) {
    let members = membersByTeam.get(team.id);
    if (!members) { members = new Set(); membersByTeam.set(team.id, members); }
    for (const member of team.members) members.add(member.id);
  }
  const configuration = canRead ? ctx.core.configuration() : undefined;
  const openByProject = new Map<string, Set<string>>();
  const uncertain = new Set<string>();
  const projectRecords = new Map<string, FileRecord>();
  for (const record of records) {
    if (record.entity.entity === 'project' && visible.has(record.id)) {
      projectRecords.set(record.id, record);
      if (unreadable(record)) uncertain.add(record.id);
    }
    if (record.entity.entity !== 'work_item' || !record.entity.project || !visible.has(record.entity.project) || record.entity.archived) continue;
    const projectId = record.entity.project;
    const category = statusCategory(record.entity, configuration);
    if (unreadable(record) || category === undefined) { uncertain.add(projectId); continue; }
    if (category === 'completed' || category === 'canceled') continue;
    let ids = openByProject.get(projectId);
    if (!ids) { ids = new Set(); openByProject.set(projectId, ids); }
    ids.add(record.id);
  }
  const views: TeamDirectoryTeam[] = teams.map(team => {
    const links = assignments.rows.filter(assignment => assignment.data.teamIds.includes(team.id));
    const projectIds = [...new Set(links.map(assignment => assignment.project_id))];
    const allowed = canManage ? identities : membersByTeam.get(team.id) ?? new Set<string>();
    const memberIds = team.data.memberIds.filter(id => allowed.has(id));
    const members = new Set(memberIds);
    const taskIds = new Set<string>();
    for (const projectId of projectIds) for (const id of openByProject.get(projectId) ?? []) taskIds.add(id);
    const known = canRead && projectIds.every(id => !uncertain.has(id));
    let activityAt = team.updatedAt;
    for (const assignment of links) {
      const updatedAt = assignment.updated_at.toISOString();
      if (updatedAt > activityAt) activityAt = updatedAt;
    }
    return { ...team, createdBy: identities.has(team.createdBy) ? team.createdBy : null,
      data: { ...team.data, memberIds, maintainerIds: team.data.maintainerIds.filter(id => members.has(id)) },
      projectIds, activityAt, openWorkCount: known ? taskIds.size : null,
      scopeComplete: known && membership.projectIds === null };
  });
  const byProject = new Map(projectViews.map(project => [project.projectId, project]));
  return { canManage, teams: views, projects: projects.filter(project => project.workspaceId === ctx.workspaceId && visible.has(project.id)).map(project => {
    let writable = canManage;
    const source = projectRecords.get(project.id);
    if (!source || unreadable(source) || source.entity.archived) writable = false;
    if (writable) {
      try { assertProjectWritable(project); } catch { writable = false; }
    }
    return { id: project.id, name: String(project.data.name ?? project.data.title ?? project.id), version: project.version,
      canManage: writable, assignment: byProject.get(project.id)!.assignment };
  }) };
}
