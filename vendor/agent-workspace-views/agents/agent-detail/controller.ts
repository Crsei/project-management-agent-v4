import {
  activityFixtures,
  applicationFixtures,
  identityFixture,
  skillFixtures,
  taskFixtures,
  text,
  type AgentActivity,
  type AgentIdentity,
  type BackgroundTask,
  type Capability,
  type ActivityKind,
  type Localized,
} from "./fixtures.ts"

export type AgentView = "skills" | "calendar" | "activity" | "identity"
export type ResourceView = "tasks" | "applications"
export type ActivityFilter = "all" | ActivityKind
export type Message = { id: string; role: "user" | "agent"; content: Localized }
export type AgentDetailState = {
  identity: AgentIdentity
  draft: AgentIdentity
  tasks: BackgroundTask[]
  applications: Capability[]
  skills: Capability[]
  activities: AgentActivity[]
  view: AgentView
  resources: ResourceView
  filter: ActivityFilter
  day: number
  expanded: string[]
  paused: boolean
  readonly: boolean
  dataState: "ready" | "empty" | "loading" | "refresh-error"
  messageOpen: boolean
  messageDraft: string
  messages: Message[]
  saveFeedback: "saved" | null
  errors: Partial<Record<keyof AgentIdentity, Localized>>
}

export function createAgentDetailState(scenario: string): AgentDetailState {
  const identity = structuredClone(identityFixture)
  const empty = scenario === "empty"
  const activities = empty ? [] : activityFixtures()
  if (scenario === "long-content") {
    for (let index = 0; index < 32; index++) {
      const source = activities[index % 8]
      activities.push({
        ...source,
        id: `${source.id}-history-${index}`,
        result: text(
          `${source.result["zh-CN"]}\n\n补充交接说明：保留账户来源、待定决策和负责人信息，以便后续评审时核实上下文。`.repeat(
            3,
          ),
          `${source.result.en}\n\nAdditional handoff context: preserve account sources, open decisions, and owner details so the team can verify the context at its next review.`.repeat(
            3,
          ),
        ),
      })
    }
    identity.introduction = text(
      "跟踪客户交接、标记账户变化，并为团队准备下一步行动。跨时区协调支持、实施与客户成功团队，保留来源上下文和明确的负责人。",
      "Tracks customer handoffs, flags account changes, and prepares the team’s next steps. Coordinates support, implementation, and customer success across time zones while preserving source context and clear ownership.",
    )
  }
  return {
    identity,
    draft: structuredClone(identity),
    tasks: empty ? [] : taskFixtures(),
    applications: empty ? [] : applicationFixtures(),
    skills: empty ? [] : skillFixtures(),
    activities,
    view: "activity",
    resources: "tasks",
    filter: "all",
    day: 2,
    expanded: empty ? [] : ["pulse"],
    paused: false,
    readonly: scenario === "readonly",
    dataState: empty
      ? "empty"
      : scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "refresh-error"
          : "ready",
    messageOpen: false,
    messageDraft: "",
    messages: [],
    saveFeedback: null,
    errors: {},
  }
}

export function canEditAgent(state: AgentDetailState): boolean {
  return !state.readonly && state.dataState !== "loading"
}

export function setCapability(
  state: AgentDetailState,
  collection: "tasks" | "applications" | "skills",
  id: string,
  enabled: boolean,
): AgentDetailState {
  if (
    !canEditAgent(state) ||
    !state[collection].some(
      (entry) => entry.id === id && entry.enabled !== enabled,
    )
  )
    return state
  if (collection === "tasks")
    return {
      ...state,
      tasks: state.tasks.map((entry) =>
        entry.id === id ? { ...entry, enabled } : entry,
      ),
    }
  return {
    ...state,
    [collection]: state[collection].map((entry) =>
      entry.id === id ? { ...entry, enabled } : entry,
    ),
  }
}

export function pauseAgent(state: AgentDetailState): AgentDetailState {
  return canEditAgent(state) ? { ...state, paused: !state.paused } : state
}

export function scheduleForDay(state: AgentDetailState): BackgroundTask[] {
  if (state.paused || state.dataState === "loading") return []
  return state.tasks.filter(
    (task) => task.enabled && task.days.includes(state.day),
  )
}

export function visibleActivities(state: AgentDetailState): AgentActivity[] {
  return state.filter === "all"
    ? state.activities
    : state.activities.filter((event) => event.kind === state.filter)
}

export function toggleActivity(
  state: AgentDetailState,
  id: string,
): AgentDetailState {
  if (!state.activities.some((event) => event.id === id)) return state
  return {
    ...state,
    expanded: state.expanded.includes(id)
      ? state.expanded.filter((value) => value !== id)
      : [...state.expanded, id],
  }
}

export function updateIdentityDraft(
  state: AgentDetailState,
  field: keyof AgentIdentity,
  value: string,
): AgentDetailState {
  if (!canEditAgent(state)) return state
  const errors = { ...state.errors }
  delete errors[field]
  return {
    ...state,
    draft: { ...state.draft, [field]: text(value, value) },
    errors,
    saveFeedback: null,
  }
}

export function identityIsDirty(state: AgentDetailState): boolean {
  return (Object.keys(state.identity) as (keyof AgentIdentity)[]).some(
    (key) =>
      state.identity[key].en !== state.draft[key].en ||
      state.identity[key]["zh-CN"] !== state.draft[key]["zh-CN"],
  )
}

export function saveIdentity(state: AgentDetailState): AgentDetailState {
  if (!canEditAgent(state) || !identityIsDirty(state)) return state
  const errors: AgentDetailState["errors"] = {}
  for (const key of ["name", "role", "introduction"] as const) {
    if (!state.draft[key].en.trim() || !state.draft[key]["zh-CN"].trim())
      errors[key] = text(
        "请输入此字段，草稿已保留。",
        "Enter a value for this field. Your draft has been retained.",
      )
  }
  if (Object.keys(errors).length)
    return { ...state, errors, saveFeedback: null }
  const identity = Object.fromEntries(
    Object.entries(state.draft).map(([key, value]) => [
      key,
      text(value["zh-CN"].trim(), value.en.trim()),
    ]),
  ) as AgentIdentity
  return {
    ...state,
    identity,
    draft: structuredClone(identity),
    errors: {},
    saveFeedback: "saved",
  }
}

export function resetIdentity(state: AgentDetailState): AgentDetailState {
  return canEditAgent(state)
    ? {
        ...state,
        draft: structuredClone(state.identity),
        errors: {},
        saveFeedback: null,
      }
    : state
}

export function recoverAgentData(state: AgentDetailState): AgentDetailState {
  if (state.dataState === "ready") return state
  if (state.dataState === "refresh-error" || state.dataState === "loading")
    return { ...state, dataState: "ready" }
  return {
    ...state,
    tasks: taskFixtures(),
    applications: applicationFixtures(),
    skills: skillFixtures(),
    activities: activityFixtures(),
    expanded: ["pulse"],
    dataState: "ready",
  }
}

/** A deterministic local recap of the current sample; it does not call a Provider or an integration. */
export function sendLocalMessage(state: AgentDetailState): AgentDetailState {
  const question = state.messageDraft.trim()
  if (!canEditAgent(state) || !question) return state
  const latest = state.activities[0]
  const enabledSkills = state.skills.filter((skill) => skill.enabled)
  const activeTasks = state.paused
    ? []
    : state.tasks.filter((task) => task.enabled)
  const answer = text(
    `本地示例回顾：${latest ? latest.result["zh-CN"] : "暂无活动记录可供回顾。"}\n\n当前启用 ${enabledSkills.length} 项技能；${state.paused ? "Agent 已暂停。" : `有 ${activeTasks.length} 项后台任务已启用。`}此回复仅来自当前页面的示例记录，没有访问应用或运行外部任务。`,
    `Local sample recap: ${latest ? latest.result.en : "No activity records are available to recap."}\n\n${enabledSkills.length} skills are enabled; ${state.paused ? "the agent is paused." : `${activeTasks.length} background tasks are enabled.`} This reply uses only the current page's sample records. No application was accessed and no external task was run.`,
  )
  const sequence = state.messages.length
  return {
    ...state,
    messageDraft: "",
    messages: [
      ...state.messages,
      {
        id: `message-${sequence + 1}`,
        role: "user",
        content: text(question, question),
      },
      { id: `message-${sequence + 2}`, role: "agent", content: answer },
    ],
  }
}
