import { z } from "zod"
import type { Command, Entity, MemberDirectoryAccess, MemberDirectoryMember, MemberRole, Workspace } from "../../../../../../packages/contracts/src/client.ts"

export type ProjectShareScope = "unavailable" | "revoked" | "inherited" | "direct" | "none"
export type ProjectShareScopeDraft = {
  userId: string
  name: string
  action: "add" | "remove"
  base: MemberDirectoryAccess
}

export function canReadProjectShare(workspace: Workspace | null, project: Entity): boolean {
  return !!workspace && project.kind === "project" && project.workspaceId === workspace.id && workspace.capabilities.includes("domain.read") && (workspace.projectIds === null || workspace.projectIds.includes(project.id))
}

export function canManageProjectShare(workspace: Workspace | null): boolean {
  return !!workspace && workspace.projectIds === null && workspace.capabilities.includes("access.manage")
}

export function projectShareScope(access: MemberDirectoryAccess | null, projectId: string): ProjectShareScope {
  if (!access) return "unavailable"
  if (access.revokedAt) return "revoked"
  if (access.projectIds === null) return "inherited"
  return access.projectIds.includes(projectId) ? "direct" : "none"
}

export function projectShareCandidates(members: readonly MemberDirectoryMember[], query: string): MemberDirectoryMember[] {
  const search = query.trim().toLocaleLowerCase()
  return members.filter(member => member.access && !member.access.revokedAt && [member.name, member.email ?? ""].some(value => value.toLocaleLowerCase().includes(search)))
}

export function projectShareDraft(member: MemberDirectoryMember, action: "add" | "remove"): ProjectShareScopeDraft {
  if (!member.access) throw new Error("Member access is not available.")
  return { userId: member.userId, name: member.name, action, base: { ...member.access, capabilities: [...member.access.capabilities], projectIds: member.access.projectIds === null ? null : [...member.access.projectIds] } }
}

export function projectShareConflict(draft: ProjectShareScopeDraft, current: MemberDirectoryAccess | null | undefined): boolean {
  return !current || current.version !== draft.base.version
}

function requireShareManagement(workspace: Workspace | null, project: Entity): void {
  if (!canReadProjectShare(workspace, project) || !canManageProjectShare(workspace)) throw new Error("Project sharing requires unrestricted workspace access.manage and current project domain.read.")
}

/** Scope-only cutover: never apply a role template, reactivate a revoked grant, or revoke membership. */
export function projectShareMemberCommand(workspace: Workspace | null, project: Entity, draft: ProjectShareScopeDraft, current: MemberDirectoryAccess | null | undefined, commandId: string): Command<"SetWorkspaceMember"> {
  requireShareManagement(workspace, project)
  if (projectShareConflict(draft, current)) throw new Error("Member access changed. Keep the draft and explicitly adopt the current version before submitting.")
  const scope = projectShareScope(draft.base, project.id)
  if (scope === "revoked" || scope === "unavailable") throw new Error("Manage revoked or unavailable memberships in the full member editor.")
  if (scope === "inherited") throw new Error("Workspace-wide access is inherited and cannot be removed for one project.")
  if (draft.action === "add" && scope !== "none" || draft.action === "remove" && scope !== "direct") throw new Error("This project scope change is no longer applicable.")
  if (draft.action === "add" && (!draft.base.capabilities.includes("domain.read") || project.data.archivedAt || project.data.archived === true)) throw new Error("Adding this project requires existing domain.read and an unarchived project. No capabilities will be added automatically.")
  const projectIds = draft.base.projectIds!
  return {
    commandId,
    commandType: "SetWorkspaceMember",
    targetId: draft.userId,
    expectedVersions: { [draft.userId]: draft.base.version },
    payload: {
      userId: draft.userId,
      capabilities: [...draft.base.capabilities],
      projectIds: draft.action === "add" ? [...projectIds, project.id] : projectIds.filter(id => id !== project.id),
    },
  }
}

/** New invitations have exactly this project; Admin is intentionally not a project role. */
export function projectShareInvitationCommand(workspace: Workspace | null, project: Entity, email: string, role: MemberRole, enabled: boolean, commandId: string): Command<"CreateMemberInvitation"> {
  requireShareManagement(workspace, project)
  if (!enabled) throw new Error("SMTP invitations are not configured or their status is unavailable.")
  if (project.data.archivedAt || project.data.archived === true) throw new Error("Invitations require an unarchived project.")
  if (role !== "guest" && role !== "member") throw new Error("Only Guest or Member templates can be invited to this project.")
  return { commandId, commandType: "CreateMemberInvitation", expectedVersions: {}, payload: { email: z.email().max(254).parse(email.trim().toLowerCase()), role, projectIds: [project.id] } }
}

export function projectShareUrl(origin: string, workspaceId: string, projectId: string): string {
  return new URL(`/pm/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`, origin).href
}
