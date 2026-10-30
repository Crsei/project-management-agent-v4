import type { MemberDirectoryMember, MemberInvitationDto } from "@contracts"
import type { ControlledInvitation, ControlledMember, MemberDirectoryInteraction } from "@/views/pm/people-controlled-contracts"
import { matchesMemberConditions } from "@/views/pm/member-directory-filters"

export const memberRoleValues = { admin: 0, member: 1, guest: 2, custom: 3, unknown: 4 } as const

export function directoryMemberRecord(member: MemberDirectoryMember, ownerId: string | undefined, serverNow: number, presenceTtlMs: number): ControlledMember {
  const expired = !member.presence.lastHeartbeatAt || serverNow - Date.parse(member.presence.lastHeartbeatAt) > presenceTtlMs
  return {
    membershipId: member.userId, userId: member.userId, name: member.name, email: member.email ?? "",
    role: memberRoleValues[member.role], scope: member.access === null ? "unknown" : member.access.projectIds === null ? "workspace" : "project",
    projectId: member.access?.projectIds?.length === 1 ? member.access.projectIds[0]! : null,
    isActive: !member.access?.revokedAt, isOwner: ownerId === member.userId,
    version: member.access === null ? "" : String(member.access.version), companyRole: member.jobTitle,
    phone: member.phone, joinedAt: member.joinedAt, avatarDataUrl: member.avatarDataUrl, teams: member.teams,
    ownership: null, engagement: null, twoFactor: member.twoFactorEnabled,
    presence: expired || member.presence.status === "offline" ? "offline" : member.presence.status === "online" ? "available" : member.presence.status,
  }
}

export function invitationRecord(invitation: MemberInvitationDto): ControlledInvitation {
  return {
    id: invitation.id, email: invitation.email, role: memberRoleValues[invitation.role], requestId: null,
    status: invitation.status, createdAt: invitation.createdAt, error: invitation.delivery?.failureCode ?? null,
    version: invitation.version, expiresAt: invitation.expiresAt, deliveryStatus: invitation.delivery?.status ?? null,
  }
}

export function visibleDirectoryMembers(all: readonly ControlledMember[], state: MemberDirectoryInteraction, variant: string): ControlledMember[] {
  const query = state.query.trim().toLocaleLowerCase()
  const rows = all.filter(member =>
    matchesMemberConditions(member, state.conditions) &&
    [member.name, member.email, member.companyRole ?? "", ...(member.teams ?? []).map(team => team.name)].join(" ").toLocaleLowerCase().includes(query) &&
    (state.activeFilter === "all" || member.isActive === (state.activeFilter === "active")) &&
    (variant === "member1" ? !state.roleFilters?.length || state.roleFilters.includes(member.role) : state.roleFilter === null || state.roleFilter === member.role) &&
    (!state.presenceFilters?.length || !!member.presence && state.presenceFilters.includes(member.presence))
  )
  const presenceOrder = { available: 0, away: 1, offline: 2 }
  return rows.sort((a, b) => {
    let result = 0
    if (state.sort === "role") result = a.role - b.role
    else if (state.sort === "joined" || state.sort === "joined-desc") result = (a.joinedAt ?? "").localeCompare(b.joinedAt ?? "") * (state.sort === "joined-desc" ? -1 : 1)
    else if (state.sort === "teams" || state.sort === "teams-desc") result = ((a.teams?.length ?? 0) - (b.teams?.length ?? 0)) * (state.sort === "teams-desc" ? -1 : 1)
    else if (state.sort === "presence") result = (a.presence ? presenceOrder[a.presence] : 3) - (b.presence ? presenceOrder[b.presence] : 3)
    else result = a.name.localeCompare(b.name) * (state.sort === "name-desc" ? -1 : 1)
    return result || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)
  })
}
