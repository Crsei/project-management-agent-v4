import { z } from 'zod';
import { CAPABILITIES, type Capability } from '../../domain/src/core.ts';
import { updateWorkspaceIdentityPayloadSchema } from '../../contracts/src/workspace-identity.ts';

const uuid = z.uuid().toLowerCase();
const project = z.string().regex(/^PRJ-\d+$/);
const ids = z.array(uuid).max(1000).refine(values => new Set(values).size === values.length, 'Duplicate member IDs');
const projects = z.array(project).max(1000).refine(values => new Set(values).size === values.length, 'Duplicate project IDs');
const role = z.enum(['admin', 'member', 'guest']);
const name = z.string().trim().min(1).max(160);
const details = { name, identifier: z.string().trim().min(1).max(64).nullable(), description: z.string().trim().max(5000), focus: z.string().trim().min(1).max(500).nullable(), responseTargetHours: z.number().finite().min(0).max(8760).nullable() };
const teamIds = z.array(uuid).max(100).refine(values => new Set(values).size === values.length, 'Duplicate team IDs');
/** Closed native payloads shared by the operator CLI and the business adapters. */
export const administrationCommandPayloadSchemas = {
  UpdateWorkspaceIdentity: updateWorkspaceIdentityPayloadSchema,
  SetWorkspaceMember: z.strictObject({ userId: uuid, capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).refine(values => new Set(values).size === values.length, 'Duplicate capabilities'), projectIds: projects.nullable() }),
  SetMemberRole: z.strictObject({ userId: uuid, role, projectIds: projects.nullable() }),
  RevokeWorkspaceMember: z.strictObject({ userId: uuid }),
  CreateMemberInvitation: z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)), role, projectIds: projects.nullable() }),
  RevokeMemberInvitation: z.strictObject({}), ResendMemberInvitation: z.strictObject({}),
  CreateProjectTeam: z.strictObject({ ...details, memberIds: ids, maintainerIds: ids }),
  RenameProjectTeam: z.strictObject({ name }), UpdateProjectTeamDetails: z.strictObject(details),
  SetProjectTeamMembers: z.strictObject({ memberIds: ids }), SetProjectTeamMaintainers: z.strictObject({ maintainerIds: ids }),
  ArchiveProjectTeam: z.strictObject({}), SetProjectTeams: z.strictObject({ teamIds }),
  SetMemberCapacity: z.strictObject({ userId: uuid, capacityPoints: z.number().finite().nonnegative().max(1_000_000).nullable() }),
  SetProjectFavorite: z.strictObject({ favorite: z.boolean() }), SetProjectSidebarOrder: z.strictObject({ projectIds: projects }),
  SetProjectCover: z.strictObject({ artifactVersionId: uuid.nullable() }),
  SetProjectScope: z.strictObject({ items: z.array(z.strictObject({ id: uuid, text: z.string().trim().min(1).max(2000), completed: z.boolean() })).max(200).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate scope IDs') }),
} as const;
export type AdministrationCommandName = keyof typeof administrationCommandPayloadSchemas;
const versions = z.record(z.string().min(1).max(80), z.number().int().positive());
const workspace = { workspaceId: uuid };
const page = { after: z.string().min(1).max(512).nullable(), limit: z.number().int().min(1).max(50) };
const write = { ...workspace, expectedVersions: versions };
const target = { ...write, targetId: uuid };
const projectWrite = { ...write, projectId: project };
export const AdministrationToolInputSchemas = {
  pm_read_workspace_identity: z.strictObject(workspace),
  pm_update_workspace_identity: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.UpdateWorkspaceIdentity }),
  pm_read_account_profile: z.strictObject(workspace),
  pm_read_members: z.strictObject({ ...workspace, ...page }),
  pm_set_member: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.SetWorkspaceMember }),
  pm_set_member_role: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.SetMemberRole }),
  pm_revoke_member: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.RevokeWorkspaceMember }),
  pm_read_invitations: z.strictObject({ ...workspace, ...page }),
  pm_create_invitation: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.CreateMemberInvitation }),
  pm_revoke_invitation: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.RevokeMemberInvitation }),
  pm_resend_invitation: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.ResendMemberInvitation }),
  pm_read_teams: z.strictObject({ ...workspace, ...page }),
  pm_create_team: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.CreateProjectTeam }),
  pm_rename_team: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.RenameProjectTeam }),
  pm_update_team_details: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.UpdateProjectTeamDetails }),
  pm_set_team_members: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.SetProjectTeamMembers }),
  pm_set_team_maintainers: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.SetProjectTeamMaintainers }),
  pm_archive_team: z.strictObject({ ...target, payload: administrationCommandPayloadSchemas.ArchiveProjectTeam }),
  pm_set_project_teams: z.strictObject({ ...projectWrite, payload: administrationCommandPayloadSchemas.SetProjectTeams }),
  pm_read_workload: z.strictObject({ ...workspace, ...page, section: z.enum(['members', 'tasks', 'teams']) }),
  pm_set_member_capacity: z.strictObject({ ...write, targetId: uuid.nullable(), payload: administrationCommandPayloadSchemas.SetMemberCapacity }),
  pm_read_project_extras: z.strictObject({ ...workspace, ...page }),
  pm_set_project_favorite: z.strictObject({ ...projectWrite, payload: administrationCommandPayloadSchemas.SetProjectFavorite }),
  pm_set_project_order: z.strictObject({ ...write, payload: administrationCommandPayloadSchemas.SetProjectSidebarOrder }),
  pm_set_project_cover: z.strictObject({ ...projectWrite, payload: administrationCommandPayloadSchemas.SetProjectCover }),
  pm_set_project_scope: z.strictObject({ ...projectWrite, payload: administrationCommandPayloadSchemas.SetProjectScope }),
  pm_duplicate_project: z.strictObject({ ...write, projectId: project, name: z.string().trim().min(1).max(500), includeTasks: z.boolean() }),
  pm_read_project_directory: z.strictObject({ ...workspace, ...page }),
  pm_read_project_directory_reference: z.strictObject({ ...workspace, projectId: project }),
} as const;
export type AdministrationToolName = keyof typeof AdministrationToolInputSchemas;
export const administrationToolCommands = {
  pm_update_workspace_identity: 'UpdateWorkspaceIdentity', pm_set_member: 'SetWorkspaceMember', pm_set_member_role: 'SetMemberRole', pm_revoke_member: 'RevokeWorkspaceMember',
  pm_create_invitation: 'CreateMemberInvitation', pm_revoke_invitation: 'RevokeMemberInvitation', pm_resend_invitation: 'ResendMemberInvitation',
  pm_create_team: 'CreateProjectTeam', pm_rename_team: 'RenameProjectTeam', pm_update_team_details: 'UpdateProjectTeamDetails', pm_set_team_members: 'SetProjectTeamMembers', pm_set_team_maintainers: 'SetProjectTeamMaintainers', pm_archive_team: 'ArchiveProjectTeam', pm_set_project_teams: 'SetProjectTeams', pm_set_member_capacity: 'SetMemberCapacity',
  pm_set_project_favorite: 'SetProjectFavorite', pm_set_project_order: 'SetProjectSidebarOrder', pm_set_project_cover: 'SetProjectCover', pm_set_project_scope: 'SetProjectScope', pm_duplicate_project: 'DuplicateProject',
} as const;
const reads: readonly string[] = ['pm_read_workspace_identity', 'pm_read_account_profile', 'pm_read_members', 'pm_read_invitations', 'pm_read_teams', 'pm_read_workload', 'pm_read_project_extras', 'pm_read_project_directory', 'pm_read_project_directory_reference'];
const admins: readonly string[] = ['pm_update_workspace_identity', 'pm_set_member', 'pm_set_member_role', 'pm_revoke_member', 'pm_read_invitations', 'pm_create_invitation', 'pm_revoke_invitation', 'pm_resend_invitation', 'pm_create_team', 'pm_rename_team', 'pm_update_team_details', 'pm_set_team_members', 'pm_set_team_maintainers', 'pm_archive_team', 'pm_set_project_teams', 'pm_set_member_capacity'];
const descriptions: Record<AdministrationToolName, string> = {
  pm_read_workspace_identity: 'Read current authorized workspace name, icon, color and identity version.',
  pm_update_workspace_identity: 'Update workspace presentation identity with native access.manage and exact identity version.',
  pm_read_account_profile: 'Read the current actor’s nonsecret identity/profile metadata; no passwords, recovery email or sessions.',
  pm_read_members: 'Read the current authorization-trimmed member directory, role grants and presence. Null access means redacted. Team membership never grants project access.',
  pm_set_member: 'Set explicit existing native capabilities and project grants, preserving CAS and final-administrator protection.',
  pm_set_member_role: 'Apply the existing admin/member/guest template and explicit project scope. Roles are not permission ranks.',
  pm_revoke_member: 'Revoke an existing membership at its current version; subsequent calls use current authorization.',
  pm_read_invitations: 'Read current invitation and actual SMTP queue status; SMTP acceptance does not prove inbox delivery.',
  pm_create_invitation: 'Create one native invitation and queue configured mail. Uses the original tool operation identity.',
  pm_revoke_invitation: 'Revoke the exact existing invitation version.', pm_resend_invitation: 'Explicitly resend the existing invitation under native delivery/version guards; not an automatic retry.',
  pm_read_teams: 'Read currently authorized teams, membership/maintainer relationships, project links and actual versions.',
  pm_create_team: 'Create an organization team from existing active members; grants no project permissions.',
  pm_rename_team: 'Rename the current team at its exact version.', pm_update_team_details: 'Update actual team details at its exact version.',
  pm_set_team_members: 'Set current active team members; does not grant project access.', pm_set_team_maintainers: 'Set maintainers who are current active members of this team.',
  pm_archive_team: 'Archive the existing team at its exact version. There is no native restore/delete team action.',
  pm_set_project_teams: 'Link existing teams to a project with project, assignment and team versions. Organization does not grant permissions.',
  pm_read_workload: 'Read one bounded section of the native concurrent-open-points workload with authoritative summary/scope. Unknown estimates and capacity remain null/unknown, not zero.',
  pm_set_member_capacity: 'Set explicit concurrent unfinished-work point capacity for an active member. Null capacity means unspecified.',
  pm_read_project_extras: 'Read personal favorites/order and authorized immutable cover/scope references.',
  pm_set_project_favorite: 'Set only the current actor’s project favorite with current project/record versions.',
  pm_set_project_order: 'Persist only the current actor’s sidebar order over explicitly authorized projects.',
  pm_set_project_cover: 'Set/remove a same-project immutable raster artifact version; native byte/hash/signature checks remain mandatory.',
  pm_set_project_scope: 'Save the native project scope checklist; does not replace Markdown or completion policy.',
  pm_duplicate_project: 'Duplicate an authorized project through its original native command, allocating new IDs and trusted default storage. Copies no history, permissions, attachments or code. Unknown outcomes are inspected, never replayed.',
  pm_read_project_directory: 'Read authorization-trimmed project identities and team assignments.',
  pm_read_project_directory_reference: 'Read an authorized opaque storage identity/status; never expose host absolute paths or select arbitrary directories.',
};
export const AdministrationToolMetadata = Object.fromEntries((Object.keys(AdministrationToolInputSchemas) as AdministrationToolName[]).map(key => [key, {
  description: descriptions[key], write: !reads.includes(key),
  capabilities: (admins.includes(key) ? ['access.manage', ...(key === 'pm_set_project_teams' ? ['domain.read'] : [])] : ['pm_read_workspace_identity', 'pm_read_account_profile', 'pm_read_members', 'pm_read_teams', 'pm_read_project_directory'].includes(key) ? [] : ['domain.read', ...(['pm_set_project_cover', 'pm_set_project_scope', 'pm_duplicate_project'].includes(key) ? ['planning.edit'] : [])]) as Capability[],
  scope: admins.includes(key) ? 'workspace-admin' : key === 'pm_duplicate_project' || key === 'pm_set_project_order' ? 'workspace' : 'project',
}])) as Record<AdministrationToolName, { description: string; write: boolean; capabilities: Capability[]; scope: 'project' | 'workspace' | 'workspace-admin' }>;
