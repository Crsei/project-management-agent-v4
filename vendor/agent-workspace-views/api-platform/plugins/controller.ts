import { apScope, type ApCopy, type ApScenario } from "../model.ts"
import type { ApAccountData, ApAccountIntegration } from "../fixtures/accounts"
import {
  pluginCategoryIds,
  pluginConfigDefault,
  pluginFixtureOutcome,
  type PluginCategory,
} from "./fixtures.ts"

export type PluginFilter = "all" | "active" | "connected" | PluginCategory

export type PluginDraft = {
  integrationId: string
  projectId: string
  enabled: boolean
  linked: boolean
  projectLinks: Record<string, boolean>
  config: string
  tools: string[]
  reason: string
  dirty: boolean
}

/**
 * One retained local operation. `integrationId`, `projectId` and
 * `configVersion` are the original request identity captured at submit time;
 * `unknown` keeps them verbatim until an explicit check resolves the fixture
 * receipt. No field of this record is ever replayed automatically.
 */
export type PluginOperation = {
  kind: "connect" | "disable" | "save"
  action: "connect" | "disable" | "enable" | "save"
  operationId: string
  integrationId: string
  projectId: string
  configVersion: number
  enabled: boolean | null
  linked: boolean | null
  config: string | null
  tools: string[] | null
  reason: string | null
  intent: "submit" | "check" | null
  status: "pending" | "confirmed" | "rejected" | "unknown"
  recorded?: "confirmed" | "rejected"
}

export type PluginOperationInput = Omit<
  PluginOperation,
  "operationId" | "intent" | "status" | "recorded"
>

export type PluginsState = {
  canWrite: boolean
  search: string
  filter: PluginFilter
  selectedId: string | null
  connectionDialog: boolean
  drafts: Record<string, PluginDraft>
  configs: Record<string, { config: string; tools: string[] | null }>
  op: PluginOperation | null
  opCount: number
  load: "idle" | "pending" | "error"
  skeleton: boolean
  notice: "idle" | "request" | "refreshed"
  request: { open: boolean; name: string; url: string; purpose: string }
  requests: { id: string; name: string; url: string; purpose: string }[]
  test: {
    integrationId: string | null
    status: "idle" | "pending" | "passed" | "failed"
    configurationValid?: boolean
    toolCount?: number
  }
}

export function createPluginsState(scenario: ApScenario): PluginsState {
  return {
    canWrite: apScope.canWrite && scenario !== "readonly",
    search: "",
    filter: "all",
    selectedId: null,
    connectionDialog: false,
    drafts: {},
    configs: {},
    op: null,
    opCount: 0,
    load: scenario === "refresh-error" ? "error" : "idle",
    skeleton: scenario === "loading",
    notice: "idle",
    request: { open: false, name: "", url: "", purpose: "" },
    requests: [],
    test: { integrationId: null, status: "idle" },
  }
}

/** Enabled and healthy are independent: an errored connection stays enabled.
 * The error badge and failed test remain authoritative; enabled is not success. */
export function pluginSwitchOn(
  status: ApAccountIntegration["status"],
): boolean {
  return status === "connected" || status === "configuration-error"
}

/** Healthy connection is distinct from an enabled (but broken) integration. */
export function pluginHealthyConnection(
  status: ApAccountIntegration["status"],
): boolean {
  return status === "connected"
}

export function pluginCounts(integrations: readonly ApAccountIntegration[]) {
  const counts = { all: integrations.length, connected: 0, active: 0 } as {
    all: number
    connected: number
    active: number
  } & Record<PluginCategory, number>
  for (const category of pluginCategoryIds) counts[category] = 0
  for (const integration of integrations) {
    if (pluginSwitchOn(integration.status)) counts.active += 1
    if (pluginHealthyConnection(integration.status)) counts.connected += 1
    const category = integration.category as PluginCategory
    if (counts[category] !== undefined) counts[category] += 1
  }
  return counts
}

export function filterPlugins(
  integrations: readonly ApAccountIntegration[],
  state: Pick<PluginsState, "search" | "filter">,
): ApAccountIntegration[] {
  const search = state.search.trim().toLowerCase()
  return integrations.filter((integration) => {
    if (
      search &&
      !`${integration.provider} ${integration.name["zh-CN"]} ${integration.name.en}`
        .toLowerCase()
        .includes(search)
    )
      return false
    if (state.filter === "all") return true
    if (state.filter === "active") return pluginSwitchOn(integration.status)
    if (state.filter === "connected")
      return pluginHealthyConnection(integration.status)
    return integration.category === state.filter
  })
}

export type PluginValidation = {
  configError: boolean
  toolsError: boolean
  reasonError: boolean
  valid: boolean
}

/** Config is required only while the connection stays enabled; disabling always requires a reason. */
export function pluginDraftValidation(
  draft: PluginDraft,
  baselineEnabled: boolean,
): PluginValidation {
  const disabling = draft.enabled === false && baselineEnabled
  const configError = draft.enabled && draft.config.trim() === ""
  const toolsError = draft.enabled && draft.tools.length === 0
  const reasonError = disabling && draft.reason.trim() === ""
  return {
    configError,
    toolsError,
    reasonError,
    valid: !configError && !toolsError && !reasonError,
  }
}

export function pluginOperationLocked(state: PluginsState): boolean {
  const status = state.op?.status
  return status === "pending" || status === "unknown"
}

export function openPlugin(
  state: PluginsState,
  integration: ApAccountIntegration,
  linked: boolean,
): PluginsState {
  const existing = state.drafts[integration.integrationId]
  if (existing) {
    return {
      ...state,
      selectedId: integration.integrationId,
      connectionDialog: false,
      test: { integrationId: integration.integrationId, status: "idle" },
    }
  }
  const stored = state.configs[integration.integrationId]
  const draft: PluginDraft = {
    integrationId: integration.integrationId,
    projectId: apScope.projectId,
    enabled: pluginSwitchOn(integration.status),
    linked,
    projectLinks: { [apScope.projectId]: linked },
    config: stored?.config ?? pluginConfigDefault(integration.integrationId),
    tools: stored?.tools ?? [...integration.capabilities],
    reason: "",
    dirty: false,
  }
  return {
    ...state,
    selectedId: integration.integrationId,
    connectionDialog: false,
    drafts: { ...state.drafts, [integration.integrationId]: draft },
    test: { integrationId: integration.integrationId, status: "idle" },
  }
}

export function openPluginForDisable(
  state: PluginsState,
  integration: ApAccountIntegration,
  linked: boolean,
): PluginsState {
  const opened = openPlugin(state, integration, linked)
  const draft = opened.drafts[integration.integrationId]
  if (!draft || draft.enabled === false) return opened
  return {
    ...opened,
    drafts: {
      ...opened.drafts,
      [integration.integrationId]: {
        ...draft,
        enabled: false,
        reason: "",
        dirty: true,
      },
    },
  }
}

export function closePlugin(state: PluginsState): PluginsState {
  return { ...state, selectedId: null, connectionDialog: false }
}

export function openPluginForConnect(
  state: PluginsState,
  integration: ApAccountIntegration,
  linked: boolean,
): PluginsState {
  const opened = openPlugin(state, integration, linked)
  const draft = opened.drafts[integration.integrationId]
  if (!draft || pluginOperationLocked(state) || !state.canWrite) return opened
  return {
    ...opened,
    connectionDialog: true,
    drafts: {
      ...opened.drafts,
      [integration.integrationId]: { ...draft, enabled: true, dirty: true },
    },
  }
}

export function discardPluginDraft(
  state: PluginsState,
  integration: ApAccountIntegration,
  linked: boolean,
): PluginsState {
  if (pluginOperationLocked(state)) return state
  const drafts = { ...state.drafts }
  delete drafts[integration.integrationId]
  return openPlugin({ ...state, drafts }, integration, linked)
}

export function updateDraft(
  state: PluginsState,
  integrationId: string,
  patch: Partial<PluginDraft>,
): PluginsState {
  const draft = state.drafts[integrationId]
  if (!draft || !state.canWrite) return state
  if (pluginOperationLocked(state)) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [integrationId]: {
        ...draft,
        ...patch,
        projectLinks:
          patch.linked === undefined
            ? draft.projectLinks
            : { ...draft.projectLinks, [draft.projectId]: patch.linked },
        dirty: true,
      },
    },
  }
}

/** Scope re-selection is a view change: the linkage baseline follows the chosen project. */
export function selectDraftProject(
  state: PluginsState,
  integrationId: string,
  projectId: string,
  linked: boolean,
): PluginsState {
  const draft = state.drafts[integrationId]
  if (!draft || !state.canWrite) return state
  if (pluginOperationLocked(state)) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [integrationId]: {
        ...draft,
        projectId,
        linked: draft.projectLinks[projectId] ?? linked,
        projectLinks: {
          ...draft.projectLinks,
          [draft.projectId]: draft.linked,
        },
      },
    },
  }
}

export function beginOperation(
  state: PluginsState,
  input: PluginOperationInput,
): PluginsState {
  if (!state.canWrite) return state
  if (pluginOperationLocked(state)) return state
  const disabling = input.kind === "disable" || input.enabled === false
  if (disabling && !(input.reason ?? "").trim()) return state
  if (input.enabled === true && !(input.config ?? "x").trim()) return state
  if (
    input.enabled === true &&
    input.tools !== null &&
    input.tools.length === 0
  )
    return state
  const count = state.opCount + 1
  return {
    ...state,
    opCount: count,
    op: {
      ...input,
      operationId: `op-plugin-${count}`,
      intent: "submit",
      status: "pending",
    },
  }
}

export function resolveOperation(state: PluginsState): PluginsState {
  const op = state.op
  if (!op || op.status !== "pending" || op.intent !== "submit") return state
  const { outcome, recorded } = pluginFixtureOutcome(
    op.action,
    op.integrationId,
  )
  if (outcome === "confirmed")
    return { ...state, op: { ...op, intent: null, status: "confirmed" } }
  if (outcome === "rejected")
    return { ...state, op: { ...op, intent: null, status: "rejected" } }
  return { ...state, op: { ...op, intent: null, status: "unknown", recorded } }
}

export function beginCheck(state: PluginsState): PluginsState {
  const op = state.op
  if (!op || op.status !== "unknown" || !state.canWrite) return state
  return { ...state, op: { ...op, status: "pending", intent: "check" } }
}

/**
 * Explicit receipt for a retained `unknown` operation. A configuration version
 * that moved in the meantime resolves as rejected instead of replaying a stale
 * request against changed data.
 */
export function resolveCheck(
  state: PluginsState,
  currentConfigVersion: number,
): PluginsState {
  const op = state.op
  if (!op || op.status !== "pending" || op.intent !== "check") return state
  const stale =
    (op.config !== null || op.tools !== null) &&
    currentConfigVersion !== op.configVersion
  const recorded = stale ? "rejected" : (op.recorded ?? "rejected")
  return { ...state, op: { ...op, intent: null, status: recorded } }
}

/** Confirmed operations fold their draft back into the page-local config store. */
export function commitDraft(
  state: PluginsState,
  op: PluginOperation,
): PluginsState {
  if (op.status !== "confirmed") return state
  const id = op.integrationId
  const draft = state.drafts[id]
  const stored = state.configs[id]
  const next: PluginsState = { ...state }
  if (op.config !== null || op.tools !== null) {
    next.configs = {
      ...state.configs,
      [id]: {
        config: op.config ?? stored?.config ?? draft?.config ?? "",
        tools: op.tools ?? stored?.tools ?? null,
      },
    }
  }
  if (draft) {
    const cleared =
      op.enabled === false || op.action === "disable" ? "" : draft.reason
    next.drafts = {
      ...state.drafts,
      [id]: {
        ...draft,
        config: next.configs[id]?.config ?? draft.config,
        tools: next.configs[id]?.tools ?? draft.tools,
        reason: cleared,
        dirty: false,
      },
    }
  }
  return next
}

/**
 * Applies a confirmed operation to the shared account snapshot using field
 * patches only. Values are absolute (target config version, set membership),
 * so a duplicated application can never double-increment or double-insert.
 */
export function applyPluginOperation(
  account: ApAccountData,
  op: PluginOperation,
): ApAccountData {
  if (op.status !== "confirmed") return account
  let changed = false
  const integrations = account.integrations.map((integration) => {
    if (integration.integrationId !== op.integrationId) return integration
    let next = integration
    if (
      op.enabled === true ||
      (next.status === "configuration-error" &&
        op.enabled !== false &&
        op.config !== null &&
        op.config.trim() !== "")
    ) {
      if (next.status !== "connected" || next.disabledReason !== null) {
        next = { ...next, status: "connected", disabledReason: null }
      }
    } else if (op.enabled === false) {
      const reason: ApCopy = { "zh-CN": op.reason ?? "", en: op.reason ?? "" }
      if (
        next.status !== "disabled" ||
        next.disabledReason?.["zh-CN"] !== reason["zh-CN"]
      ) {
        next = { ...next, status: "disabled", disabledReason: reason }
      }
    }
    if (op.config !== null || op.tools !== null) {
      const target = op.configVersion + 1
      if (next.configVersion !== target)
        next = { ...next, configVersion: target }
    }
    if (next !== integration) changed = true
    return next
  })
  let projects = account.projects
  if (op.linked !== null) {
    projects = account.projects.map((project) => {
      if (project.projectId !== op.projectId) return project
      const has = project.integrationIds.includes(op.integrationId)
      if (has === op.linked) return project
      changed = true
      return {
        ...project,
        integrationIds: op.linked
          ? [...project.integrationIds, op.integrationId]
          : project.integrationIds.filter((id) => id !== op.integrationId),
      }
    })
  }
  return changed ? { ...account, integrations, projects } : account
}

export function beginRefresh(state: PluginsState): PluginsState {
  if (state.load === "pending") return state
  return { ...state, load: "pending" }
}

export function settleRefresh(state: PluginsState): PluginsState {
  if (state.load !== "pending") return state
  return { ...state, load: "idle", notice: "refreshed" }
}

export function completeSkeleton(state: PluginsState): PluginsState {
  return state.skeleton ? { ...state, skeleton: false } : state
}

export function beginPluginTest(
  state: PluginsState,
  integrationId: string,
): PluginsState {
  return {
    ...state,
    test: {
      integrationId,
      status: "pending",
      toolCount: state.drafts[integrationId]?.tools.length ?? 0,
      configurationValid: Boolean(
        state.drafts[integrationId]?.enabled &&
        state.drafts[integrationId]?.config.trim() &&
        state.drafts[integrationId]?.tools.length,
      ),
    },
  }
}

export function settlePluginTest(
  state: PluginsState,
  integration: ApAccountIntegration | undefined,
): PluginsState {
  if (state.test.status !== "pending" || !integration) return state
  const status =
    integration.status === "connected" && state.test.configurationValid
      ? "passed"
      : "failed"
  return {
    ...state,
    test: { ...state.test, integrationId: integration.integrationId, status },
  }
}

export function submitIntegrationRequest(state: PluginsState): PluginsState {
  const { name, url, purpose } = state.request
  if (!state.canWrite || !name.trim() || !purpose.trim()) return state
  return {
    ...state,
    notice: "request",
    request: { open: false, name: "", url: "", purpose: "" },
    requests: [
      ...state.requests,
      {
        id: `integration-request-${state.requests.length + 1}`,
        name: name.trim(),
        url: url.trim(),
        purpose: purpose.trim(),
      },
    ],
  }
}
