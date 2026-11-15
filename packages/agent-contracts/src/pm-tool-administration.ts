import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';

const uuid = z.uuid();
const project = z.string().regex(/^PRJ-\d+$/);
const task = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().positive();
const count = z.number().int().nonnegative();
// Finite wire vocabulary only. Native PM services remain the authorization and
// identity validation authority; this package builds without PM/domain sources.
const capability = z.enum(['domain.read', 'directory.read', 'audit.read', 'intent.propose', 'intent.decide', 'planning.edit', 'planning.lifecycle', 'workitem.cancel_reopen', 'delivery.write', 'delivery.submit', 'delivery.review', 'workitem.complete', 'access.manage']);
const workspaceIdentity = z.strictObject({
  workspaceId: uuid, name: z.string().min(1).max(200),
  icon: z.enum(['building', 'grid', 'briefcase', 'layers', 'rocket', 'globe']),
  color: z.enum(['#2F2E2A', '#5A67D8', '#3B82C4', '#23918A', '#C54B78', '#C48A1E']),
  version, updatedAt: timestamp,
});
const points = z.number().finite().nonnegative();
const identity = z.strictObject({ id: uuid, name: z.string().max(200) });
const access = z.strictObject({ capabilities: z.array(capability).max(capability.options.length), projectIds: z.array(project).nullable(), version, revokedAt: timestamp.nullable() });
export const administrationMemberSchema = z.strictObject({
  userId: uuid, name: z.string().max(200), jobTitle: z.string().max(200).nullable(), joinedAt: timestamp, isSelf: z.boolean(),
  role: z.enum(['admin', 'member', 'guest', 'custom', 'unknown']), teams: z.array(identity),
  presence: z.strictObject({ status: z.enum(['online', 'away', 'offline']), lastHeartbeatAt: timestamp.nullable() }), access: access.nullable(),
});
export const administrationProfileSchema = z.strictObject({ userId: uuid, name: z.string().max(200), timeZone: z.string().max(200), jobTitle: z.string().max(200).nullable(), version, joinedAt: timestamp, updatedAt: timestamp });
const record = { id: uuid, workspaceId: uuid, projectId: project.nullable(), kind: z.string().min(1).max(80), ownerId: uuid.nullable(), version, createdAt: timestamp, updatedAt: timestamp, createdBy: uuid.nullable() };
const teamData = z.strictObject({ name: z.string().max(160), identifier: z.string().max(64).nullable(), description: z.string().max(5000), focus: z.string().max(500).nullable(), responseTargetHours: z.number().finite().min(0).max(8760).nullable(), memberIds: z.array(uuid), maintainerIds: z.array(uuid), archivedAt: timestamp.nullable() });
export const administrationTeamSchema = z.strictObject({ ...record, kind: z.literal('project_team'), data: teamData, projectIds: z.array(project), activityAt: timestamp, openWorkCount: count.nullable(), scopeComplete: z.boolean() });
const invitation = z.strictObject({ id: uuid, workspaceId: uuid, email: z.email().max(254), role: z.enum(['admin', 'member', 'guest']), projectIds: z.array(project).nullable(), status: z.enum(['pending', 'accepted', 'revoked', 'expired']), version, expiresAt: timestamp, createdAt: timestamp, updatedAt: timestamp, invitedBy: uuid, acceptedAt: timestamp.nullable(), delivery: z.strictObject({ status: z.enum(['queued', 'sending', 'smtp_accepted', 'failed', 'unknown', 'cancelled']), failureCode: z.enum(['smtp_rejected', 'smtp_unavailable', 'smtp_configuration', 'send_outcome_unknown', 'send_lease_expired', 'token_unavailable']).nullable(), updatedAt: timestamp }).nullable() });
const workloadScope = z.strictObject({ complete: z.boolean(), projectIds: z.array(project), reason: z.enum(['workspace', 'projects']) });
const workloadSummary = z.strictObject({ openCount: count, doneCount: count, knownOpenPoints: points, unknownEstimateCount: count, unknownAssigneeCount: count, overloadedMemberCount: count, unknownOverloadMemberCount: count });
const workloadFields = { serverNow: timestamp, unit: z.literal('concurrent_open_points'), scope: workloadScope, summary: workloadSummary };
export const administrationWorkloadMemberSchema = z.strictObject({ userId: uuid, teamIds: z.array(uuid), taskIds: z.array(task), openCount: count, doneCount: count, knownOpenPoints: points, unknownEstimateCount: count, capacity: z.strictObject({ id: uuid, version, capacityPoints: points.nullable() }).nullable(), capacityPoints: points.nullable(), overloaded: z.boolean().nullable(), scope: z.strictObject({ complete: z.boolean(), reason: z.enum(['workspace', 'partial']) }) });
export const administrationWorkloadTaskSchema = z.strictObject({ id: task, title: z.string().max(500), projectId: project, assigneeId: uuid.nullable(), assigneeStatus: z.enum(['assigned', 'unassigned', 'unavailable']), teamIds: z.array(uuid), status: z.string().max(200), statusCategory: z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']), open: z.boolean(), done: z.boolean(), estimatePoints: points.nullable() });
export const administrationWorkloadTeamSchema = z.strictObject({ id: uuid, name: z.string().max(160), memberIds: z.array(uuid), taskIds: z.array(task) });
const favorite = z.strictObject({ ...record, kind: z.literal('project_favorite'), data: z.strictObject({ favorite: z.boolean() }) });
const cover = z.strictObject({ ...record, kind: z.literal('project_cover'), data: z.strictObject({ artifactVersionId: uuid.nullable(), mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).nullable() }) });
const scope = z.strictObject({ ...record, kind: z.literal('project_scope'), data: z.strictObject({ items: z.array(z.strictObject({ id: uuid, text: z.string().max(2000), completed: z.boolean() })).max(200) }) });
const sidebarOrder = z.strictObject({ ...record, kind: z.literal('project_sidebar_order'), data: z.strictObject({ projectIds: z.array(project) }) });
export const administrationExtrasSchema = z.strictObject({ projectId: project, favorite: favorite.nullable(), cover: cover.nullable(), scope: scope.nullable() });
export const administrationProjectDirectorySchema = z.strictObject({ projectId: project, identities: z.array(identity), teams: z.array(z.strictObject({ id: uuid, name: z.string().max(160), members: z.array(identity) })), assignment: z.strictObject({ id: uuid, version }).nullable() });
const standard = agentChatToolResultFields;
export const AdministrationToolResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('administration_workspace'), items: z.array(workspaceIdentity).max(1), ...standard }),
  z.strictObject({ kind: z.literal('administration_profile'), items: z.array(administrationProfileSchema).max(1), ...standard }),
  z.strictObject({ kind: z.literal('administration_members'), items: z.array(administrationMemberSchema).max(50), serverNow: timestamp, presenceTtlMs: count, canManageMembers: z.boolean(), ...standard }),
  z.strictObject({ kind: z.literal('administration_invitations'), items: z.array(invitation).max(50), enabled: z.boolean(), ...standard }),
  z.strictObject({ kind: z.literal('administration_teams'), items: z.array(administrationTeamSchema).max(50), canManage: z.boolean(), ...standard }),
  z.strictObject({ kind: z.literal('administration_workload_members'), items: z.array(administrationWorkloadMemberSchema).max(50), ...workloadFields, ...standard }),
  z.strictObject({ kind: z.literal('administration_workload_tasks'), items: z.array(administrationWorkloadTaskSchema).max(50), ...workloadFields, ...standard }),
  z.strictObject({ kind: z.literal('administration_workload_teams'), items: z.array(administrationWorkloadTeamSchema).max(50), ...workloadFields, ...standard }),
  z.strictObject({ kind: z.literal('administration_project_extras'), items: z.array(administrationExtrasSchema).max(50), sidebarOrder: sidebarOrder.nullable(), ...standard }),
  z.strictObject({ kind: z.literal('administration_project_directory'), items: z.array(administrationProjectDirectorySchema).max(50), ...standard }),
  z.strictObject({ kind: z.literal('administration_directory_reference'), items: z.array(z.strictObject({ projectId: project, storageId: uuid.nullable(), kind: z.enum(['local', 'legacy']), status: z.enum(['available', 'unavailable']) })).max(1), ...standard }),
  z.strictObject({ kind: z.literal('administration_command'), items: z.array(z.strictObject({ id: z.string().min(1).max(200), version: version.nullable() })).max(1), ...standard }),
]);
export type AdministrationToolResult = z.infer<typeof AdministrationToolResultSchema>;
