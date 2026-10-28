import type { ApCopy, ApOperationResult, ApScenario } from "../model.ts"
import { apScope } from "../model.ts"
import { createCatalogModels } from "../fixtures/models.ts"
import type { ApAccountData, ApAccountProject } from "../fixtures/accounts.ts"

export type ProjectSectionId =
  "general" | "model-limits" | "members" | "groups" | "roles"
export const projectSectionIds: readonly ProjectSectionId[] = [
  "general",
  "model-limits",
  "members",
  "groups",
  "roles",
]
/** `inherit` = project field is null and the organization value applies. */
export type ValueMode = "inherit" | "override"
export type ProjectDraft = {
  name: string
  description: string
  integrationIds: string[]
  dataRegion: string
  logRetentionDays: string
  acceptsNewRequests: boolean
  modelLimits: {
    modelId: string
    requestsText: string
    tokensText: string
    enabled: boolean
  }[]
  modelMode: ValueMode
  modelId: string
  tokenMode: ValueMode
  tokenText: string
  budgetMode: ValueMode
  budgetText: string
  budgetUsdText: string
}
/**
 * One immutable write request per operation. `unknown` keeps this exact
 * request plus its operation ID; a check resolves the recorded fixture
 * receipt and never re-submits the request.
 */
export type ProjectRequest =
  | {
      kind: "project-details"
      projectId: string
      name: string
      description: string
      integrationIds: string[]
      dataRegion: string
      logRetentionDays: number
      acceptsNewRequests: boolean
    }
  | {
      kind: "project-limits"
      projectId: string
      defaultModelId: string | null
      modelTokenLimit: number | null
      monthlyBudgetMicroUsd: number | null
      modelLimits: {
        modelId: string
        requestsPerMinute: number
        tokensPerMinute: number
        enabled: boolean
      }[]
    }
  | { kind: "member-role"; memberId: string; roleId: string }
  | { kind: "member-remove"; memberId: string; projectId: string }
  | { kind: "invitation-cancel"; memberId: string }
  | {
      kind: "member-create"
      memberId: string
      name: string
      email: string
      roleId: string
      projectId: string
      memberKind: "user" | "service-account"
    }
  | {
      kind: "group-create"
      groupId: string
      name: string
      description: string
      roleId: string
      memberIds: string[]
    }
  | { kind: "group-delete"; groupId: string }
  | {
      kind: "group-members"
      groupId: string
      projectId: string
      memberIds: string[]
      description: string
      roleId: string
    }
  | {
      kind: "role-create"
      roleId: string
      name: string
      capabilities: string[]
    }
  | { kind: "role-edit"; roleId: string; name: string; capabilities: string[] }
  | { kind: "role-delete"; roleId: string }

export type SaveState = {
  status: ApOperationResult
  intent: "save" | "check" | null
  operationId: string | null
  section: ProjectSectionId | null
  request: ProjectRequest | null
}
export type ProjectState = {
  selectedProjectId: string
  activeSection: ProjectSectionId
  /** Per-project form drafts; switching project never drops other drafts. */
  drafts: Record<string, ProjectDraft>
  /** Per-member proposed role edits kept across project switches. */
  memberRoles: Record<string, string>
  /** Selected member row; discarded when it is invalid for the active project. */
  selectedMemberId: string | null
  dialogs: {
    editMemberId: string | null
    createGroup: boolean
    manageGroupId: string | null
    createRole: boolean
    editRoleId: string | null
    createMember: "invite" | "service" | null
  }
  /** Dialog-local form drafts retained in page state, not in the shared account. */
  groupCreateName: string
  groupMemberIds: string[]
  groupDescription: string
  groupRoleId: string
  memberForm: { name: string; email: string; roleId: string }
  memberCreateCount: number
  memberType: "all" | "user" | "service-account"
  roleForm: { name: string; capabilities: string[] }
  memberSearch: string
  save: SaveState
  saveCount: number
  refresh: "idle" | "pending" | "error"
  refreshIntent: "refresh" | "retry" | null
  refreshFails: boolean
  loaded: boolean
  notice: "idle" | "refreshed" | "copied-project" | "copy-error"
  groupCreateCount: number
  roleCreateCount: number
}

/**
 * Fixture-declared local outcomes. Entry conditions are value-addressed so
 * every outcome is reachable from the default scene through the model-limit
 * editor: most saves confirm, a sakana override rejects, and a gpt-live-1
 * override returns unknown whose recorded receipt is a rejection, so an
 * unknown result can never update confirmed state.
 */
export type ProjectSaveFixture = {
  outcome: "confirmed" | "rejected" | "unknown"
  recorded?: "confirmed" | "rejected"
}
export const projectSaveFixture: Readonly<Record<string, ProjectSaveFixture>> =
  {
    "defaultModelId:sakana/fugu-max": { outcome: "rejected" },
    "defaultModelId:openai/gpt-live-1": {
      outcome: "unknown",
      recorded: "rejected",
    },
  }
export function saveFixtureKey(request: ProjectRequest): string {
  if (request.kind === "project-limits")
    return `defaultModelId:${request.defaultModelId ?? "inherit"}`
  return request.kind
}
export function fixtureSaveOutcome(
  request: ProjectRequest,
): ProjectSaveFixture {
  return projectSaveFixture[saveFixtureKey(request)] ?? { outcome: "confirmed" }
}

export const tokenLimitMax = 100_000_000
export const budgetMicroUsdMax = 1_000_000_000_000
export type IntegerError = "empty" | "format" | "range"
/**
 * Strict raw-text parsing of the untouched input value. Display strings are
 * formatted only for reading and are never parsed back into canonical data.
 */
export function parseIntegerText(
  text: string,
  max: number,
): { ok: true; value: number } | { ok: false; reason: IntegerError } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: "empty" }
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: "format" }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value > max)
    return { ok: false, reason: "range" }
  return { ok: true, value }
}
/** Formats a canonical integer for read-only display only. */
export function formatGrouped(value: number): string {
  return value.toLocaleString("en-US")
}

export type GeneralErrors = {
  name?: "required"
  missingIntegrations?: string[]
}
export type LimitsErrors = {
  model?: "required" | "missing"
  token?: IntegerError
  budget?: IntegerError
}
function sameIds(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false
  const left = [...a].sort(),
    right = [...b].sort()
  return left.every((value, index) => value === right[index])
}
export function projectDraftFrom(project: ApAccountProject): ProjectDraft {
  return {
    name: project.name,
    description: project.description,
    integrationIds: [...project.integrationIds],
    dataRegion: project.dataRegion ?? "",
    logRetentionDays:
      project.logRetentionDays == null ? "" : String(project.logRetentionDays),
    acceptsNewRequests: project.acceptsNewRequests ?? true,
    modelLimits: (project.modelLimits ?? []).map((row) => ({
      modelId: row.modelId,
      requestsText: String(row.requestsPerMinute),
      tokensText: String(row.tokensPerMinute),
      enabled: row.enabled,
    })),
    modelMode: project.defaultModelId === null ? "inherit" : "override",
    modelId: project.defaultModelId ?? "",
    tokenMode: project.modelTokenLimit === null ? "inherit" : "override",
    tokenText:
      project.modelTokenLimit === null ? "" : String(project.modelTokenLimit),
    budgetMode: project.monthlyBudgetMicroUsd === null ? "inherit" : "override",
    budgetText:
      project.monthlyBudgetMicroUsd === null
        ? ""
        : String(project.monthlyBudgetMicroUsd),
    budgetUsdText:
      project.monthlyBudgetMicroUsd == null
        ? ""
        : formatUsdMicro(project.monthlyBudgetMicroUsd),
  }
}
export function draftFor(
  state: ProjectState,
  project: ApAccountProject,
): ProjectDraft {
  return state.drafts[project.projectId] ?? projectDraftFrom(project)
}
export function isGeneralDirty(
  project: ApAccountProject,
  draft: ProjectDraft,
): boolean {
  return (
    draft.name.trim() !== project.name ||
    draft.description.trim() !== project.description ||
    draft.dataRegion !== (project.dataRegion ?? "") ||
    draft.logRetentionDays !==
      (project.logRetentionDays == null
        ? ""
        : String(project.logRetentionDays)) ||
    draft.acceptsNewRequests !== (project.acceptsNewRequests ?? true) ||
    !sameIds(draft.integrationIds, project.integrationIds)
  )
}
export function isLimitsDirty(
  project: ApAccountProject,
  draft: ProjectDraft,
): boolean {
  const rates = project.modelLimits ?? []
  if (
    draft.modelLimits.length !== rates.length ||
    draft.modelLimits.some((row, i) => {
      const base = rates[i]
      const requests = parseIntegerText(row.requestsText, 1_000_000)
      const tokens = parseIntegerText(row.tokensText, tokenLimitMax)
      return (
        !base ||
        row.modelId !== base.modelId ||
        row.enabled !== base.enabled ||
        !requests.ok ||
        !tokens.ok ||
        requests.value !== base.requestsPerMinute ||
        tokens.value !== base.tokensPerMinute
      )
    })
  )
    return true
  if (
    (project.defaultModelId === null) !== (draft.modelMode === "inherit") ||
    (draft.modelMode === "override" && draft.modelId !== project.defaultModelId)
  )
    return true
  if ((project.modelTokenLimit === null) !== (draft.tokenMode === "inherit")) {
    return true
  }
  if (draft.tokenMode === "override") {
    const parsed = parseIntegerText(draft.tokenText, tokenLimitMax)
    if (!parsed.ok || parsed.value !== project.modelTokenLimit) return true
  }
  if (
    (project.monthlyBudgetMicroUsd === null) !==
    (draft.budgetMode === "inherit")
  )
    return true
  if (draft.budgetMode === "override") {
    const parsed = parseIntegerText(draft.budgetText, budgetMicroUsdMax)
    if (!parsed.ok || parsed.value !== project.monthlyBudgetMicroUsd)
      return true
  }
  return false
}
export function validateGeneral(
  account: ApAccountData,
  draft: ProjectDraft,
): GeneralErrors {
  const errors: GeneralErrors = {}
  if (!draft.name.trim()) errors.name = "required"
  const missing = draft.integrationIds.filter(
    (id) => !account.integrations.some((item) => item.integrationId === id),
  )
  if (missing.length) errors.missingIntegrations = missing
  return errors
}
export function validateLimits(
  scenario: ApScenario,
  draft: ProjectDraft,
): LimitsErrors {
  const errors: LimitsErrors = {}
  if (draft.modelMode === "override") {
    if (!draft.modelId.trim()) errors.model = "required"
    else {
      const known = createCatalogModels(scenario).some(
        (model) => model.modelId === draft.modelId,
      )
      if (!known) errors.model = "missing"
    }
  }
  if (draft.tokenMode === "override") {
    const parsed = parseIntegerText(draft.tokenText, tokenLimitMax)
    if (!parsed.ok) errors.token = parsed.reason
  }
  if (draft.budgetMode === "override") {
    const parsed = parseIntegerText(draft.budgetText, budgetMicroUsdMax)
    if (!parsed.ok) errors.budget = parsed.reason
  }
  return errors
}
export function hasErrors(
  errors: GeneralErrors | LimitsErrors,
  keys: readonly string[],
): boolean {
  return keys.some((key) => {
    const value = (errors as Record<string, unknown>)[key]
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined
  })
}

export type EffectiveNumber =
  | { kind: "project"; value: number }
  | { kind: "organization"; value: number }
  | { kind: "inherited-unknown" }
/** null project value inherits the organization value; null organization value is inherited-unknown, never zero. */
export function effectiveNumber(
  override: number | null,
  organizationValue: number | null,
): EffectiveNumber {
  if (override !== null) return { kind: "project", value: override }
  if (organizationValue !== null)
    return { kind: "organization", value: organizationValue }
  return { kind: "inherited-unknown" }
}
export type EffectiveModel = {
  modelId: string
  source: "project" | "organization"
}
export function effectiveModel(
  project: ApAccountProject,
  organizationModelId: string,
): EffectiveModel {
  if (project.defaultModelId !== null)
    return { modelId: project.defaultModelId, source: "project" }
  return { modelId: organizationModelId, source: "organization" }
}

export type WriteBlock = "scope" | "capability" | "unknown-role"
export type WriteGate = { canWrite: boolean; blocked: WriteBlock | null }
export type CapabilityName = "project.write" | "members.write"
/**
 * Explicit local permission scope, never a backend auth claim:
 * - `project.write` gates project-scoped field writes (details, limits,
 *   integration association).
 * - `members.write` gates organization-level dictionaries and membership
 *   (role assignment, project association removal, invitation cancellation,
 *   groups, roles).
 * Missing acting role fails closed as unknown capability.
 */
export function writeGate(
  account: ApAccountData,
  scenario: ApScenario,
  capability: CapabilityName,
): WriteGate {
  if (!apScope.canWrite || scenario === "readonly")
    return { canWrite: false, blocked: "scope" }
  const acting = account.members.find(
    (member) => member.memberId === account.profile.memberId,
  )
  if (!acting) return { canWrite: false, blocked: "unknown-role" }
  const role = account.roles.find((item) => item.roleId === acting.roleId)
  if (!role) return { canWrite: false, blocked: "unknown-role" }
  if (!role.capabilities.includes(capability))
    return { canWrite: false, blocked: "capability" }
  return { canWrite: true, blocked: null }
}

export function createProjectState(scenario: ApScenario): ProjectState {
  return {
    selectedProjectId: apScope.projectId,
    activeSection: "general",
    drafts: {},
    memberRoles: {},
    selectedMemberId: null,
    dialogs: {
      editMemberId: null,
      createGroup: false,
      manageGroupId: null,
      createRole: false,
      editRoleId: null,
      createMember: null,
    },
    groupCreateName: "",
    groupMemberIds: [],
    roleForm: { name: "", capabilities: [] },
    memberSearch: "",
    groupDescription: "",
    groupRoleId: "role-developer",
    memberForm: { name: "", email: "", roleId: "role-developer" },
    memberCreateCount: 0,
    memberType: "all",
    save: {
      status: "idle",
      intent: null,
      operationId: null,
      section: null,
      request: null,
    },
    saveCount: 0,
    refresh: scenario === "refresh-error" ? "error" : "idle",
    refreshIntent: null,
    refreshFails: scenario === "refresh-error",
    loaded: scenario !== "loading",
    notice: "idle",
    groupCreateCount: 0,
    roleCreateCount: 0,
  }
}
export function updateDraft(
  state: ProjectState,
  project: ApAccountProject,
  patch: Partial<ProjectDraft>,
): ProjectState {
  const base = draftFor(state, project)
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [project.projectId]: { ...base, ...patch },
    },
  }
}
export function resetSection(
  state: ProjectState,
  section: ProjectSectionId,
  project: ApAccountProject,
): ProjectState {
  if (section === "general") {
    const base = draftFor(state, project)
    return updateDraft(state, project, {
      name: project.name,
      description: project.description,
      integrationIds: [...project.integrationIds],
      dataRegion: project.dataRegion ?? "",
      logRetentionDays:
        project.logRetentionDays == null
          ? ""
          : String(project.logRetentionDays),
      acceptsNewRequests: project.acceptsNewRequests ?? true,
      modelMode: base.modelMode,
      modelId: base.modelId,
      tokenMode: base.tokenMode,
      tokenText: base.tokenText,
      budgetMode: base.budgetMode,
      budgetText: base.budgetText,
    })
  }
  if (section === "model-limits") {
    const base = draftFor(state, project)
    const fresh = projectDraftFrom(project)
    return updateDraft(state, project, {
      name: base.name,
      description: base.description,
      integrationIds: base.integrationIds,
      modelMode: fresh.modelMode,
      modelId: fresh.modelId,
      tokenMode: fresh.tokenMode,
      tokenText: fresh.tokenText,
      budgetMode: fresh.budgetMode,
      budgetText: fresh.budgetText,
      budgetUsdText: fresh.budgetUsdText,
      modelLimits: fresh.modelLimits,
    })
  }
  return state
}
/**
 * Scope switch: drafts are keyed per project and retained; the edit-dialog
 * target and the selected member row are dropped when they do not belong to
 * the new project.
 */
export function selectProject(
  state: ProjectState,
  projectId: string,
  account: ApAccountData,
): ProjectState {
  if (projectId === state.selectedProjectId) return state
  const dialogs = { ...state.dialogs }
  if (
    dialogs.editMemberId &&
    !account.members.some(
      (member) =>
        member.memberId === dialogs.editMemberId &&
        member.projectIds.includes(projectId),
    )
  )
    dialogs.editMemberId = null
  if (dialogs.manageGroupId) dialogs.manageGroupId = null
  const selectionValid =
    state.selectedMemberId !== null &&
    account.members.some(
      (member) =>
        member.memberId === state.selectedMemberId &&
        member.projectIds.includes(projectId),
    )
  return {
    ...state,
    selectedProjectId: projectId,
    selectedMemberId: selectionValid ? state.selectedMemberId : null,
    dialogs,
  }
}
export function setSection(
  state: ProjectState,
  section: ProjectSectionId,
): ProjectState {
  if (section === state.activeSection) return state
  return { ...state, activeSection: section }
}
export function dialogCloseBlocked(state: ProjectState): boolean {
  return state.save.status === "pending" || state.save.status === "unknown"
}
export function writeLocked(state: ProjectState): boolean {
  return state.save.status === "pending" || state.save.status === "unknown"
}
export function beginSave(
  state: ProjectState,
  section: ProjectSectionId,
  request: ProjectRequest,
  gate: WriteGate,
): ProjectState {
  if (!gate.canWrite) return state
  if (state.save.status === "pending" || state.save.status === "unknown")
    return state
  const count = state.saveCount + 1
  return {
    ...state,
    saveCount: count,
    save: {
      status: "pending",
      intent: "save",
      operationId: `op-project-settings-${count}`,
      section,
      request,
    },
  }
}
export function beginCheck(state: ProjectState, gate: WriteGate): ProjectState {
  if (!gate.canWrite) return state
  if (state.save.status !== "unknown") return state
  return {
    ...state,
    save: { ...state.save, status: "pending", intent: "check" },
  }
}
export type SaveResolution = {
  status: "confirmed" | "rejected" | "unknown"
  operationId: string | null
  request: ProjectRequest | null
  confirmed: ProjectRequest | null
}
/** Pure resolution of the captured operation; the recorded outcome never replays the request. */
export function resolveSave(save: SaveState): SaveResolution {
  if (save.status !== "pending" || !save.request) {
    return {
      status: "unknown",
      operationId: save.operationId,
      request: save.request,
      confirmed: null,
    }
  }
  const request = save.request
  if (save.intent === "check") {
    const recorded = fixtureSaveOutcome(request).recorded ?? "rejected"
    return {
      status: recorded,
      operationId: null,
      request,
      confirmed: recorded === "confirmed" ? request : null,
    }
  }
  const { outcome } = fixtureSaveOutcome(request)
  if (outcome === "confirmed")
    return {
      status: "confirmed",
      operationId: null,
      request,
      confirmed: request,
    }
  if (outcome === "rejected")
    return {
      status: "rejected",
      operationId: null,
      request,
      confirmed: null,
    }
  return {
    status: "unknown",
    operationId: save.operationId,
    request,
    confirmed: null,
  }
}
/** Applies a resolution only while the operation ID still matches, so late timers cannot clobber newer state. */
export function applyResolution(
  state: ProjectState,
  captured: SaveState,
  resolution: SaveResolution,
): ProjectState {
  if (state.save.operationId !== captured.operationId) return state
  return {
    ...state,
    save: {
      status: resolution.status,
      intent: null,
      operationId: resolution.operationId,
      section: captured.section,
      request: resolution.request,
    },
  }
}
/** A confirmed dialog write closes its dialog; rejected/unknown keep the dialog open with the draft. */
export function closeCompletedDialog(
  state: ProjectState,
  request: ProjectRequest,
): ProjectState {
  const dialogs = { ...state.dialogs }
  if (request.kind === "member-role" || request.kind === "member-remove")
    dialogs.editMemberId = null
  if (request.kind === "member-create") dialogs.createMember = null
  if (request.kind === "group-create") dialogs.createGroup = false
  if (request.kind === "group-members") dialogs.manageGroupId = null
  if (request.kind === "role-create") dialogs.createRole = false
  if (request.kind === "role-edit") dialogs.editRoleId = null
  const selection =
    (request.kind === "member-remove" ||
      request.kind === "invitation-cancel") &&
    state.selectedMemberId === request.memberId
      ? null
      : state.selectedMemberId
  if (
    dialogs.editMemberId === state.dialogs.editMemberId &&
    dialogs.createGroup === state.dialogs.createGroup &&
    dialogs.manageGroupId === state.dialogs.manageGroupId &&
    dialogs.createRole === state.dialogs.createRole &&
    dialogs.editRoleId === state.dialogs.editRoleId &&
    dialogs.createMember === state.dialogs.createMember &&
    selection === state.selectedMemberId
  )
    return state
  return { ...state, dialogs, selectedMemberId: selection }
}
export function beginRefresh(
  state: ProjectState,
  intent: "refresh" | "retry",
): ProjectState {
  if (state.refresh === "pending") return state
  return { ...state, refresh: "pending", refreshIntent: intent, notice: "idle" }
}
export function settleRefresh(state: ProjectState): ProjectState {
  if (state.refresh !== "pending") return state
  if (state.refreshIntent === "retry" || !state.refreshFails)
    return {
      ...state,
      refresh: "idle",
      refreshIntent: null,
      refreshFails: false,
      loaded: true,
      notice: "refreshed",
    }
  return {
    ...state,
    refresh: "error",
    refreshIntent: null,
    notice: "idle",
  }
}
export function completeLoad(state: ProjectState): ProjectState {
  if (state.loaded) return state
  return { ...state, loaded: true }
}

export const accountCapabilityOrder: readonly string[] = [
  "organization.write",
  "project.write",
  "members.write",
  "keys.write",
  "integrations.write",
  "billing.write",
  "project.read",
  "keys.read",
  "integrations.read",
]
export const accountCapabilityCopy: Readonly<Record<string, ApCopy>> = {
  "organization.write": { "zh-CN": "组织写入", en: "Write organization" },
  "project.write": { "zh-CN": "项目写入", en: "Write projects" },
  "members.write": { "zh-CN": "成员管理", en: "Manage members" },
  "keys.write": { "zh-CN": "密钥管理", en: "Manage keys" },
  "integrations.write": { "zh-CN": "集成管理", en: "Manage integrations" },
  "billing.write": { "zh-CN": "账单管理", en: "Manage billing" },
  "project.read": { "zh-CN": "项目读取", en: "Read projects" },
  "keys.read": { "zh-CN": "密钥读取", en: "Read keys" },
  "integrations.read": { "zh-CN": "集成读取", en: "Read integrations" },
}
/** Ordered capability rows for the permission matrix; unknown capabilities sort last. */
export function capabilityRows(
  capabilities: readonly (readonly string[])[],
): string[] {
  const union = new Set<string>()
  for (const list of capabilities) for (const item of list) union.add(item)
  const known = accountCapabilityOrder.filter((item) => union.has(item))
  const extra = [...union]
    .filter((item) => !accountCapabilityOrder.includes(item))
    .sort()
  return [...known, ...extra]
}
/** Canonical fixture role IDs; the shared record has no built-in flag. */
export const builtInRoleIds: readonly string[] = [
  "role-admin",
  "role-developer",
  "role-viewer",
]
export function isBuiltInRole(roleId: string): boolean {
  return builtInRoleIds.includes(roleId)
}

/** The current workspace owner retains access in the local account fixture. */
export function isProtectedProjectOwner(
  account: ApAccountData,
  memberId: string,
): boolean {
  return (
    account.profile.memberId === memberId &&
    account.members.some(
      (member) =>
        member.memberId === memberId && member.roleId === "role-admin",
    )
  )
}

/** Group role assignments count as references, just like member assignments. */
export function canDeleteProjectRole(
  account: ApAccountData,
  roleId: string,
): boolean {
  return (
    account.roles.some((role) => role.roleId === roleId) &&
    !isBuiltInRole(roleId) &&
    !account.members.some((member) => member.roleId === roleId) &&
    !account.groups.some((group) => group.roleId === roleId)
  )
}

/** Exact decimal USD input to canonical integer micro-USD; no floating-point re-parsing. */
export function parseUsdMicro(text: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null
  const [whole, fraction = ""] = text.split(".")
  const value = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"))
  return Number.isSafeInteger(value) && value <= budgetMicroUsdMax
    ? value
    : null
}
export function formatUsdMicro(value: number): string {
  const whole = Math.floor(value / 1_000_000)
  const fraction = String(value % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}
export function validModelRates(draft: ProjectDraft): boolean {
  return draft.modelLimits.every(
    (row) =>
      parseIntegerText(row.requestsText, 1_000_000).ok &&
      parseIntegerText(row.tokensText, tokenLimitMax).ok,
  )
}
