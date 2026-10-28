import { apScope, type ApScenario, type ApOperationResult } from "../model.ts"
import type { ApAccountData } from "../fixtures/accounts.ts"

export const orgSectionIds = [
  "general",
  "verification",
  "admin-keys",
  "members",
  "invitations",
  "groups",
  "roles",
  "projects",
] as const
export type OrgSectionId = (typeof orgSectionIds)[number]
export const orgTimeZones = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Asia/Kolkata",
] as const
export const orgCapabilities = [
  "project.read",
  "organization.write",
  "project.write",
  "keys.write",
  "members.write",
  "billing.write",
  "integrations.read",
  "integrations.write",
] as const
export const orgAdminScopes = [
  "organization.read",
  "project.write",
  "members.write",
  "billing.read",
] as const
export const orgOperationDelayMs = 700
export const isBuiltinRole = (id: string) =>
  ["role-admin", "role-developer", "role-viewer"].includes(id)
export type ProfileDraft = {
  name: string
  contactEmail: string
  timeZone: string
  defaultMemberRoleId: string
}
export type FeaturePreferences = {
  sharedAccess: boolean
  externalPlugins: boolean
  evaluationProviders: boolean
}
export type OrgAdminKey = {
  keyId: string
  name: string
  masked: string
  scopes: string[]
  createdAt: string
  status: "active" | "revoked"
}
export type OrgFormDraft = {
  name: string
  email: string
  description: string
  roleId: string
  memberIds: string[]
  capabilities: string[]
  scopes: string[]
}
export type OrgDialog = {
  kind:
    | "verification"
    | "invite"
    | "service"
    | "member"
    | "group"
    | "role"
    | "project"
    | "admin-key"
    | "remove"
  targetId?: string
  removeKind?: "member" | "invitation" | "group" | "role" | "admin-key"
}
export type OrgRequest =
  | { kind: "profile"; profile: ProfileDraft }
  | { kind: "features"; preferences: FeaturePreferences }
  | { kind: "invite"; memberId: string; email: string; roleId: string }
  | { kind: "service"; memberId: string; name: string; roleId: string }
  | { kind: "member-role"; memberId: string; roleId: string }
  | { kind: "resend"; memberId: string }
  | { kind: "member-remove"; memberId: string }
  | {
      kind: "group"
      groupId: string
      name: string
      description: string
      roleId: string
      memberIds: string[]
    }
  | { kind: "group-delete"; groupId: string }
  | { kind: "role"; roleId: string; name: string; capabilities: string[] }
  | { kind: "role-delete"; roleId: string }
  | { kind: "project"; projectId: string; name: string; description: string }
  | { kind: "admin-key"; key: OrgAdminKey }
  | { kind: "admin-revoke"; keyId: string }
export type OrgSave = {
  status: ApOperationResult
  operationId: string | null
  request: OrgRequest | null
  section: OrgSectionId
  intent: "save" | "check" | null
  outcome: "confirmed" | "rejected" | "unknown"
  recorded: "confirmed" | "rejected"
  reason: string | null
}
export type OrgState = {
  activeSection: OrgSectionId
  profileDraft: ProfileDraft | null
  features: FeaturePreferences
  featureDraft: FeaturePreferences | null
  adminKeys: OrgAdminKey[]
  drafts: Record<string, OrgFormDraft>
  dialog: OrgDialog | null
  memberSearch: string
  memberType: "all" | "user" | "service-account"
  sectionScroll: Partial<Record<OrgSectionId, number>>
  outcome: "confirmed" | "rejected" | "unknown"
  unknownReceipt: "confirmed" | "rejected"
  save: OrgSave
  sequence: number
  loaded: boolean
  refresh: "idle" | "pending" | "error"
  refreshIntent: "refresh" | "retry"
  refreshFails: boolean
  notice: string | null
}
export function createOrgState(scenario: ApScenario): OrgState {
  return {
    activeSection: "general",
    profileDraft: null,
    features: {
      sharedAccess: true,
      externalPlugins: false,
      evaluationProviders: true,
    },
    featureDraft: null,
    adminKeys:
      scenario === "empty"
        ? []
        : [
            {
              keyId: "org-admin-infrastructure",
              name: "Infrastructure automation",
              masked: "demo_admin_••••n_01",
              scopes: ["organization.read", "project.write"],
              createdAt: "2026-08-24T00:00:00Z",
              status: "active",
            },
            {
              keyId: "org-admin-billing",
              name: "Billing export",
              masked: "demo_admin_••••n_02",
              scopes: ["organization.read", "billing.read"],
              createdAt: "2026-09-02T00:00:00Z",
              status: "active",
            },
          ],
    drafts: {},
    dialog: null,
    memberSearch: "",
    memberType: "all",
    sectionScroll: {},
    outcome: "confirmed",
    unknownReceipt: "confirmed",
    save: {
      status: "idle",
      operationId: null,
      request: null,
      section: "general",
      intent: null,
      outcome: "confirmed",
      recorded: "confirmed",
      reason: null,
    },
    sequence: 0,
    loaded: scenario !== "loading",
    refresh: scenario === "refresh-error" ? "error" : "idle",
    refreshIntent: "refresh",
    refreshFails: scenario === "refresh-error",
    notice: null,
  }
}
export const writeLocked = (state: OrgState) =>
  state.save.status === "pending" || state.save.status === "unknown"
export function canWrite(
  account: ApAccountData,
  scenario: ApScenario,
  capability: string,
): boolean {
  if (scenario === "readonly" || !apScope.canWrite) return false
  const actor = account.members.find(
    (m) => m.memberId === account.profile.memberId,
  )
  return (
    !!actor &&
    !!account.roles
      .find((r) => r.roleId === actor.roleId)
      ?.capabilities.includes(capability)
  )
}
export function requestCapability(request: OrgRequest): string {
  if (
    ["profile", "features", "admin-key", "admin-revoke"].includes(request.kind)
  )
    return "organization.write"
  return request.kind === "project" ? "project.write" : "members.write"
}
export function profileFromAccount(account: ApAccountData): ProfileDraft {
  return {
    name: account.organization.name,
    contactEmail: account.organization.contactEmail,
    timeZone: account.organization.timeZone,
    defaultMemberRoleId: account.organization.defaultMemberRoleId ?? "",
  }
}
export function profileDirty(
  draft: ProfileDraft,
  account: ApAccountData,
): boolean {
  const saved = profileFromAccount(account)
  return (Object.keys(saved) as (keyof ProfileDraft)[]).some(
    (key) => saved[key] !== draft[key],
  )
}
export function validateProfile(
  profile: ProfileDraft,
  account: ApAccountData,
  en: boolean,
): Partial<Record<keyof ProfileDraft, string>> {
  const errors: Partial<Record<keyof ProfileDraft, string>> = {}
  if (!profile.name.trim())
    errors.name = en ? "Organization name is required." : "组织名称不能为空。"
  if (profile.name.trim().length > 200)
    errors.name = en
      ? "Use 200 characters or fewer."
      : "名称不能超过200个字符。"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contactEmail))
    errors.contactEmail = en
      ? "Enter a valid email address."
      : "请输入有效的电子邮件地址。"
  if (!(orgTimeZones as readonly string[]).includes(profile.timeZone))
    errors.timeZone = en
      ? "Choose a supported time zone."
      : "请选择支持的时区。"
  if (!account.roles.some((r) => r.roleId === profile.defaultMemberRoleId))
    errors.defaultMemberRoleId = en
      ? "Choose an available role."
      : "请选择可用的角色。"
  return errors
}
export function dialogKey(dialog: OrgDialog): string {
  return `${dialog.kind}:${dialog.targetId ?? "new"}`
}
export function formFromAccount(
  dialog: OrgDialog,
  account: ApAccountData,
): OrgFormDraft {
  const roleId = account.organization.defaultMemberRoleId ?? "role-viewer"
  const base: OrgFormDraft = {
    name: "",
    email: "",
    description: "",
    roleId,
    memberIds: [],
    capabilities: ["project.read"],
    scopes: ["organization.read"],
  }
  if (dialog.kind === "member")
    return {
      ...base,
      roleId:
        account.members.find((m) => m.memberId === dialog.targetId)?.roleId ??
        "",
    }
  if (dialog.kind === "group" && dialog.targetId) {
    const group = account.groups.find((g) => g.groupId === dialog.targetId)
    return {
      ...base,
      name: group?.name ?? "",
      description: group?.description ?? "",
      roleId: group?.roleId ?? roleId,
      memberIds: account.members
        .filter((m) => m.groupIds.includes(dialog.targetId!))
        .map((m) => m.memberId),
    }
  }
  if (dialog.kind === "role" && dialog.targetId) {
    const role = account.roles.find((r) => r.roleId === dialog.targetId)
    return {
      ...base,
      name: role?.name.en ?? "",
      capabilities: [...(role?.capabilities ?? [])],
    }
  }
  if (dialog.kind === "project" && dialog.targetId) {
    const project = account.projects.find(
      (p) => p.projectId === dialog.targetId,
    )
    return {
      ...base,
      name: project?.name ?? "",
      description: project?.description ?? "",
    }
  }
  return base
}
export function validateForm(
  dialog: OrgDialog,
  form: OrgFormDraft,
  account: ApAccountData,
  en: boolean,
): Partial<Record<"name" | "email" | "roleId" | "scopes", string>> {
  const error: Partial<Record<"name" | "email" | "roleId" | "scopes", string>> =
    {}
  if (
    ["service", "group", "role", "project", "admin-key"].includes(
      dialog.kind,
    ) &&
    (!form.name.trim() || form.name.trim().length > 200)
  )
    error.name = en
      ? "Enter a name (1–200 characters)."
      : "请输入名称（1–200个字符）。"
  if (
    dialog.kind === "invite" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
  )
    error.email = en
      ? "Enter a valid email address."
      : "请输入有效的电子邮件地址。"
  if (
    ["service", "group", "member", "invite"].includes(dialog.kind) &&
    !account.roles.some((r) => r.roleId === form.roleId)
  )
    error.roleId = en ? "Choose an available role." : "请选择可用的角色。"
  if (dialog.kind === "admin-key" && !form.scopes.length)
    error.scopes = en ? "Select at least one scope." : "请至少选择一个范围。"
  return error
}
/** Check target invariants against the latest shared snapshot, not only the form. */
export function rejectionReason(
  request: OrgRequest,
  account: ApAccountData,
  scenario: ApScenario,
): string | null {
  if (!canWrite(account, scenario, requestCapability(request)))
    return "permission"
  switch (request.kind) {
    case "profile":
      return Object.keys(validateProfile(request.profile, account, true)).length
        ? "invalid-fields"
        : null
    case "invite":
      return account.members.some(
        (m) => m.email.toLowerCase() === request.email.toLowerCase(),
      )
        ? "duplicate-email"
        : null
    case "member-role": {
      const member = account.members.find(
        (m) => m.memberId === request.memberId,
      )
      return !member ||
        member.memberId === account.profile.memberId ||
        member.invitationState !== "active" ||
        !account.roles.some((r) => r.roleId === request.roleId)
        ? "protected-member"
        : null
    }
    case "member-remove":
      return request.memberId === account.profile.memberId ||
        !account.members.some((m) => m.memberId === request.memberId)
        ? "protected-member"
        : null
    case "resend":
      return account.members.some(
        (m) =>
          m.memberId === request.memberId && m.invitationState === "invited",
      )
        ? null
        : "missing-invitation"
    case "group":
      return account.groups.some(
        (g) =>
          g.groupId !== request.groupId &&
          g.name.toLowerCase() === request.name.toLowerCase(),
      )
        ? "duplicate-name"
        : null
    case "role":
      return isBuiltinRole(request.roleId) ||
        account.roles.some(
          (r) =>
            r.roleId !== request.roleId &&
            Object.values(r.name).some(
              (n) => n.toLowerCase() === request.name.toLowerCase(),
            ),
        )
        ? "protected-or-duplicate-role"
        : null
    case "role-delete":
      return isBuiltinRole(request.roleId) ||
        account.members.some((m) => m.roleId === request.roleId) ||
        account.groups.some((g) => g.roleId === request.roleId) ||
        account.organization.defaultMemberRoleId === request.roleId
        ? "assigned-role"
        : null
    default:
      return null
  }
}
export function beginSave(
  state: OrgState,
  request: OrgRequest,
  account: ApAccountData,
  scenario: ApScenario,
): OrgState {
  if (
    writeLocked(state) ||
    !canWrite(account, scenario, requestCapability(request))
  )
    return state
  const sequence = state.sequence + 1
  const capturedRequest = structuredClone(request)
  const reason = rejectionReason(capturedRequest, account, scenario)
  return {
    ...state,
    sequence,
    save: {
      status: "pending",
      operationId: `${account.organization.orgId}:op-org-${sequence}`,
      request: capturedRequest,
      section: state.activeSection,
      intent: "save",
      outcome: reason ? "rejected" : state.outcome,
      recorded: reason ? "rejected" : state.unknownReceipt,
      reason,
    },
  }
}
export function beginCheck(state: OrgState): OrgState {
  return state.save.status === "unknown"
    ? { ...state, save: { ...state.save, status: "pending", intent: "check" } }
    : state
}
/** The original payload is applied only once after a matching confirmation. Checking a receipt never starts a second operation. */
export function finishOperation(
  state: OrgState,
  captured: OrgSave,
  account: ApAccountData,
  scenario: ApScenario,
): OrgState {
  if (
    state.save.status !== "pending" ||
    state.save.operationId !== captured.operationId ||
    state.save.intent !== captured.intent ||
    !captured.request
  )
    return state
  const reason = rejectionReason(captured.request, account, scenario)
  const status = reason
    ? "rejected"
    : captured.intent === "check"
      ? captured.recorded
      : captured.outcome
  const next = {
    ...state,
    save: {
      ...captured,
      status,
      intent: null,
      reason: reason ?? captured.reason,
    },
  }
  if (status !== "confirmed") return next
  const request = captured.request
  if (request.kind === "profile") next.profileDraft = null
  if (request.kind === "features") {
    next.features = request.preferences
    next.featureDraft = null
  }
  if (request.kind === "admin-key")
    next.adminKeys = [...state.adminKeys, request.key]
  if (request.kind === "admin-revoke")
    next.adminKeys = state.adminKeys.map((k) =>
      k.keyId === request.keyId ? { ...k, status: "revoked" } : k,
    )
  if (state.dialog && state.dialog.kind !== "verification") {
    const drafts = { ...state.drafts }
    delete drafts[dialogKey(state.dialog)]
    next.drafts = drafts
    next.dialog = null
  }
  return next
}
export function applyAccountRequest(
  account: ApAccountData,
  request: OrgRequest,
): ApAccountData {
  switch (request.kind) {
    case "profile":
      return {
        ...account,
        organization: {
          ...account.organization,
          ...request.profile,
          name: request.profile.name.trim(),
          contactEmail: request.profile.contactEmail.trim(),
        },
      }
    case "invite":
      return {
        ...account,
        members: [
          ...account.members,
          {
            memberId: request.memberId,
            name: request.email.split("@")[0],
            email: request.email,
            roleId: request.roleId,
            projectIds: [],
            groupIds: [],
            invitationState: "invited",
            type: "user",
            invitedExpiresAt: "2026-10-20T00:00:00Z",
          },
        ],
      }
    case "service":
      return {
        ...account,
        members: [
          ...account.members,
          {
            memberId: request.memberId,
            name: request.name,
            email: request.memberId,
            roleId: request.roleId,
            projectIds: [],
            groupIds: [],
            invitationState: "active",
            type: "service-account",
          },
        ],
      }
    case "member-role":
      return {
        ...account,
        members: account.members.map((m) =>
          m.memberId === request.memberId
            ? { ...m, roleId: request.roleId }
            : m,
        ),
      }
    case "member-remove":
      return {
        ...account,
        members: account.members.filter((m) => m.memberId !== request.memberId),
      }
    case "group":
      return {
        ...account,
        groups: account.groups.some((g) => g.groupId === request.groupId)
          ? account.groups.map((g) =>
              g.groupId === request.groupId
                ? {
                    ...g,
                    name: request.name,
                    description: request.description,
                    roleId: request.roleId,
                  }
                : g,
            )
          : [
              ...account.groups,
              {
                groupId: request.groupId,
                name: request.name,
                description: request.description,
                roleId: request.roleId,
              },
            ],
        members: account.members.map((m) => ({
          ...m,
          groupIds: request.memberIds.includes(m.memberId)
            ? [
                ...m.groupIds.filter((id) => id !== request.groupId),
                request.groupId,
              ]
            : m.groupIds.filter((id) => id !== request.groupId),
        })),
      }
    case "group-delete":
      return {
        ...account,
        groups: account.groups.filter((g) => g.groupId !== request.groupId),
        members: account.members.map((m) => ({
          ...m,
          groupIds: m.groupIds.filter((id) => id !== request.groupId),
        })),
      }
    case "role":
      return {
        ...account,
        roles: account.roles.some((r) => r.roleId === request.roleId)
          ? account.roles.map((r) =>
              r.roleId === request.roleId
                ? {
                    ...r,
                    name: { en: request.name, "zh-CN": request.name },
                    capabilities: request.capabilities,
                  }
                : r,
            )
          : [
              ...account.roles,
              {
                roleId: request.roleId,
                name: { en: request.name, "zh-CN": request.name },
                capabilities: request.capabilities,
              },
            ],
      }
    case "role-delete":
      return {
        ...account,
        roles: account.roles.filter((r) => r.roleId !== request.roleId),
      }
    case "project":
      return {
        ...account,
        projects: account.projects.some(
          (p) => p.projectId === request.projectId,
        )
          ? account.projects.map((p) =>
              p.projectId === request.projectId
                ? { ...p, name: request.name, description: request.description }
                : p,
            )
          : [
              ...account.projects,
              {
                projectId: request.projectId,
                orgId: account.organization.orgId,
                name: request.name,
                description: request.description,
                defaultModelId: null,
                modelTokenLimit: null,
                monthlyBudgetMicroUsd: null,
                integrationIds: [],
              },
            ],
      }
    default:
      return account
  }
}
export function beginRefresh(
  state: OrgState,
  intent: "refresh" | "retry",
): OrgState {
  return state.refresh === "pending"
    ? state
    : { ...state, refresh: "pending", refreshIntent: intent, notice: null }
}
export function settleRefresh(state: OrgState): OrgState {
  return state.refresh !== "pending"
    ? state
    : state.refreshIntent === "retry" || !state.refreshFails
      ? { ...state, refresh: "idle", refreshFails: false, notice: "refreshed" }
      : { ...state, refresh: "error" }
}
export function formatBudget(value: number | null, en: boolean): string {
  return value === null
    ? en
      ? "Unknown"
      : "未知"
    : new Intl.NumberFormat(en ? "en-US" : "zh-CN", {
        style: "currency",
        currency: "USD",
      }).format(value / 1_000_000)
}
