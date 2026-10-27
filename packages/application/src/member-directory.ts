import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Capability } from '../../domain/src/core.ts';
import { PRESENCE_TTL_MS, presenceStatus } from '../../domain/src/dashboard-time.ts';
import type { PresencePreference } from '../../domain/src/dashboard-time.ts';
import { MEMBER_ROLES, memberRole, memberRoleCapabilities } from '../../domain/src/members.ts';
import type { MemberDirectory, MemberDirectoryMember, MemberDirectoryTeam, MemberRole } from '../../domain/src/members.ts';
import type { ProjectTeam } from '../../domain/src/project-directory.ts';
import { accessCommands, getMembership } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { readSelfProfile } from './dashboard-personal.ts';
import type { CommandRegistry } from './ports.ts';

export const memberDirectoryCommands: CommandRegistry = {
  SetMemberRole: {
    payload: z.strictObject({
      userId: z.uuid().toLowerCase(),
      role: z.enum(MEMBER_ROLES),
      projectIds: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)).max(1000).refine(ids => new Set(ids).size === ids.length, 'Duplicate project IDs').nullable(),
    }).refine(value => value.role !== 'admin' || value.projectIds === null, 'Workspace administrators require workspace scope'),
    async handler(ctx) {
      const payload = ctx.command.payload as { userId: string; role: MemberRole; projectIds: string[] | null };
      const definition = accessCommands.SetWorkspaceMember!;
      const grant = definition.payload.parse({ userId: payload.userId, capabilities: memberRoleCapabilities(payload.role), projectIds: payload.projectIds }) as Record<string, unknown>;
      // Exactly the existing capability gate, scope validation, CAS, last-admin
      // protection and access event; role names never form a weaker write path.
      return definition.handler({ ...ctx, command: { ...ctx.command, payload: grant } });
    },
  },
};

type DirectoryRow = {
  user_id: string; name: string; email: string | null; job_title: string | null; phone: string | null; avatar_data_url: string | null;
  joined_at: Date; capabilities: Capability[] | null; project_ids: string[] | null; version: number | null; revoked_at: Date | null;
  shared_project_ids: string[]; preference: PresencePreference | null; heartbeat_at: string | null; disabled_at: Date | null;
};
type TeamRow = { id: string; data: ProjectTeam; project_ids: string[] };
export type MemberDirectoryReadContext = Pick<DashboardReadContext, 'sql' | 'actor' | 'workspaceId' | 'now'> & {
  core?: Pick<DashboardReadContext['core'], 'list'>;
};

/** Ordinary directory permission is distinct from access-management and domain read. */
export async function readMemberDirectory(ctx: MemberDirectoryReadContext): Promise<MemberDirectory> {
  const membership = await getMembership(ctx.sql, ctx.actor, ctx.workspaceId);
  const canManage = membership.projectIds === null && membership.capabilities.includes('access.manage');
  if (!canManage && !membership.capabilities.includes('directory.read')) throw new DomainError('permission_denied', 'Capability directory.read or workspace access.manage is required', 403);
  const canReadProjects = membership.capabilities.includes('domain.read');
  // No domain.read means no common project evidence: expose only one's own row.
  // Intersect actual Markdown projects, never merely two stale project_ids arrays.
  const projectIds = !canManage && canReadProjects && ctx.core
    ? (await ctx.core.list('project')).filter(project => project.workspaceId === ctx.workspaceId && (membership.projectIds === null || membership.projectIds.includes(project.id))).map(project => project.id)
    : [];
  const directory = await ctx.sql.query<DirectoryRow>(`SELECT m.user_id,u.name,u.job_title,u.avatar_data_url,m.created_at AS joined_at,
    CASE WHEN $2::boolean OR m.user_id=$3 THEN u.email END AS email,
    CASE WHEN $2::boolean OR m.user_id=$3 THEN u.phone END AS phone,
    CASE WHEN $2::boolean OR m.user_id=$3 THEN m.capabilities END AS capabilities,
    CASE WHEN $2::boolean OR m.user_id=$3 THEN m.project_ids END AS project_ids,
    CASE WHEN $2::boolean OR m.user_id=$3 THEN m.version END AS version,
    CASE WHEN $2::boolean OR m.user_id=$3 THEN m.revoked_at END AS revoked_at,
    ARRAY(SELECT project_id FROM unnest($4::text[]) AS project_id WHERE m.project_ids IS NULL OR project_id=ANY(m.project_ids)) AS shared_project_ids,
    p.data->>'preference' AS preference,h.data->>'heartbeatAt' AS heartbeat_at,u.disabled_at
    FROM memberships m JOIN users u ON u.id=m.user_id
    LEFT JOIN dashboard_records p ON p.workspace_id=m.workspace_id AND p.owner_id=m.user_id AND p.kind='presence_preference'
    LEFT JOIN dashboard_records h ON h.workspace_id=m.workspace_id AND h.owner_id=m.user_id AND h.kind='presence_heartbeat'
    WHERE m.workspace_id=$1 AND ($2::boolean OR (m.revoked_at IS NULL AND u.disabled_at IS NULL AND
      (m.user_id=$3 OR ('domain.read'=ANY(m.capabilities) AND cardinality($4::text[])>0 AND (m.project_ids IS NULL OR m.project_ids && $4::text[])))))
    ORDER BY m.created_at,m.user_id`, [ctx.workspaceId, canManage, ctx.actor.id, projectIds]);
  const teams = await ctx.sql.query<TeamRow>(`SELECT t.id,t.data,
    ARRAY(SELECT a.project_id FROM dashboard_records a WHERE a.workspace_id=t.workspace_id AND a.kind='project_team_assignment'
      AND a.owner_id IS NULL AND a.project_id=ANY($3::text[]) AND (a.data->'teamIds') ? t.id::text) AS project_ids
    FROM dashboard_records t WHERE t.workspace_id=$1 AND t.kind='project_team' AND t.project_id IS NULL AND t.owner_id IS NULL
      AND t.data->>'archivedAt' IS NULL AND ($2::boolean OR EXISTS (SELECT 1 FROM dashboard_records a
        WHERE a.workspace_id=t.workspace_id AND a.kind='project_team_assignment' AND a.owner_id IS NULL
          AND a.project_id=ANY($3::text[]) AND (a.data->'teamIds') ? t.id::text)) ORDER BY t.created_at,t.id`, [ctx.workspaceId, canManage, projectIds]);
  const byUser = new Map(directory.rows.map(row => [row.user_id, row]));
  const teamsByUser = new Map<string, MemberDirectoryTeam[]>();
  for (const team of teams.rows) {
    for (const userId of team.data.memberIds) {
      const row = byUser.get(userId);
      if (!row || row.revoked_at !== null || row.disabled_at !== null || !canManage && !team.project_ids.some(id => row.shared_project_ids.includes(id))) continue;
      const assigned = teamsByUser.get(userId) ?? [];
      assigned.push({ id: team.id, name: team.data.name });
      teamsByUser.set(userId, assigned);
    }
  }
  const members: MemberDirectoryMember[] = directory.rows.map(row => {
    const isSelf = row.user_id === ctx.actor.id;
    const showAccess = canManage || isSelf;
    const active = row.revoked_at === null && row.disabled_at === null;
    return {
      userId: row.user_id, name: row.name, email: row.email, jobTitle: row.job_title, phone: row.phone, avatarDataUrl: row.avatar_data_url,
      joinedAt: row.joined_at.toISOString(), isSelf,
      role: showAccess ? memberRole(row.capabilities!, row.project_ids) : 'unknown',
      teams: teamsByUser.get(row.user_id) ?? [],
      presence: { status: active ? presenceStatus(row.preference ?? 'online', row.heartbeat_at, ctx.now) : 'offline', lastHeartbeatAt: row.heartbeat_at },
      twoFactorEnabled: null,
      access: showAccess ? { capabilities: row.capabilities!, projectIds: row.project_ids, version: row.version!, revokedAt: row.revoked_at?.toISOString() ?? null } : null,
    };
  });
  return {
    serverNow: ctx.now.toISOString(), presenceTtlMs: PRESENCE_TTL_MS,
    capabilities: { canReadDirectory: true, canManageMembers: canManage, canEditSelfProfile: canReadProjects, twoFactor: { supported: false } },
    selfProfile: await readSelfProfile(ctx), members,
  };
}
