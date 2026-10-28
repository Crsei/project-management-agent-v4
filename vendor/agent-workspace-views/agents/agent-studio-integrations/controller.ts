import {
  integrationFixtures,
  type Category,
  type Integration,
} from "./fixtures.ts"
export type Permissions = {
  read: boolean
  drafts: boolean
  approvedWrite: boolean
}
export type Filter = "all" | "connected" | Category
export type ConnectionDraft = {
  permissions: Permissions
  check: {
    resources: string[]
    drafts: boolean
    approvalRequired: boolean
  } | null
}
export type IntegrationsState = {
  items: Integration[]
  filter: Filter
  query: string
  searchOpen: boolean
  navigationOpen: boolean
  selectedId: string | null
  drafts: Record<string, ConnectionDraft>
  savedPermissions: Record<string, Permissions>
  requestOpen: boolean
  requestDraft: { name: string; purpose: string }
  requests: { id: number; name: string; purpose: string }[]
  dataState: "ready" | "loading" | "refresh-error"
  readonly: boolean
  notice: "saved" | "disconnected" | "requested" | null
}
export function createIntegrationsState(scenario: string): IntegrationsState {
  const items =
    scenario === "empty" || scenario === "loading"
      ? []
      : integrationFixtures.map((item) => ({
          ...item,
          description: { ...item.description },
          resources: [...item.resources],
        }))
  if (scenario === "long-content")
    items[0].description = {
      "zh-CN":
        "运行推理和语言模型，基于团队文档与项目上下文支持跨部门研究、分析与内容生成；所有写入仍需明确的人类批准。",
      en: "Run reasoning and language models with team documents and project context for cross-functional research, analysis, and content creation; writes still require explicit human approval.",
    }
  return {
    items,
    filter: "all",
    query: "",
    searchOpen: false,
    navigationOpen: true,
    selectedId: null,
    drafts: {},
    savedPermissions: {},
    requestOpen: false,
    requestDraft: { name: "", purpose: "" },
    requests: [],
    dataState:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "refresh-error"
          : "ready",
    readonly: scenario === "readonly",
    notice: null,
  }
}
export function visibleIntegrations(state: IntegrationsState) {
  const query = state.query.trim().toLocaleLowerCase()
  return state.items.filter(
    (item) =>
      (state.filter === "all" ||
        (state.filter === "connected"
          ? item.connected
          : item.category === state.filter)) &&
      (!query ||
        [item.name, item.description.en, item.description["zh-CN"]].some(
          (text) => text.toLocaleLowerCase().includes(query),
        )),
  )
}
export function openIntegration(
  state: IntegrationsState,
  id: string,
): IntegrationsState {
  if (!state.items.some((item) => item.id === id)) return state
  return {
    ...state,
    selectedId: id,
    drafts: state.drafts[id]
      ? state.drafts
      : {
          ...state.drafts,
          [id]: {
            permissions: {
              ...(state.savedPermissions[id] ?? {
                read: true,
                drafts: false,
                approvedWrite: false,
              }),
            },
            check: null,
          },
        },
  }
}
export function setPermission(
  state: IntegrationsState,
  key: keyof Permissions,
  value: boolean,
): IntegrationsState {
  const id = state.selectedId
  if (!id || state.readonly || !state.drafts[id]) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [id]: {
        permissions: { ...state.drafts[id].permissions, [key]: value },
        check: null,
      },
    },
  }
}
export function checkIntegration(state: IntegrationsState): IntegrationsState {
  const item = state.items.find((item) => item.id === state.selectedId)
  const draft = item && state.drafts[item.id]
  if (!item || !draft) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [item.id]: {
        ...draft,
        check: {
          resources: draft.permissions.read ? [...item.resources] : [],
          drafts: draft.permissions.drafts,
          approvalRequired: draft.permissions.approvedWrite,
        },
      },
    },
  }
}
export function saveIntegration(state: IntegrationsState): IntegrationsState {
  const id = state.selectedId
  if (!id || state.readonly || !state.drafts[id]) return state
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === id ? { ...item, connected: true } : item,
    ),
    savedPermissions: {
      ...state.savedPermissions,
      [id]: { ...state.drafts[id].permissions },
    },
    selectedId: null,
    notice: "saved",
  }
}
export function disconnectIntegration(
  state: IntegrationsState,
): IntegrationsState {
  const id = state.selectedId
  if (
    !id ||
    state.readonly ||
    !state.items.some((item) => item.id === id && item.connected)
  )
    return state
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === id ? { ...item, connected: false } : item,
    ),
    selectedId: null,
    notice: "disconnected",
  }
}
export function saveRequest(state: IntegrationsState): IntegrationsState {
  const name = state.requestDraft.name.trim(),
    purpose = state.requestDraft.purpose.trim()
  if (state.readonly || !name || !state.requestOpen) return state
  return {
    ...state,
    requests: [
      ...state.requests,
      { id: state.requests.length + 1, name, purpose },
    ],
    requestOpen: false,
    requestDraft: { name: "", purpose: "" },
    notice: "requested",
  }
}
export function reloadIntegrations(
  state: IntegrationsState,
): IntegrationsState {
  if (state.dataState === "ready") return state
  return {
    ...state,
    items: state.items.length
      ? state.items
      : createIntegrationsState("default").items,
    dataState: "ready",
  }
}
