import {
  agents,
  copy,
  statuses,
  taskFixtures,
  type Agent,
  type Task,
  type TaskStatus,
} from "./fixtures"

export type LaunchConfig = {
  mode: "current" | "new"
  base: string
  branch: string
  local: boolean
  agent: Agent
}
export type TaskDraft = {
  title: string
  description: string
  status: TaskStatus
  priority: Task["priority"]
  kind: Task["kind"]
  agent: Agent | ""
  dependencies: string[]
}
export type FactoryState = {
  tasks: Task[]
  selected: string | null
  query: string
  status: TaskStatus | ""
  agent: Agent | ""
  priority: Task["priority"] | ""
  scope: "all" | "mine" | "inbox"
  navOpen: boolean
  tab: "summary" | "timeline" | "code"
  draft: TaskDraft
  dependencyDraft: Record<string, string[]>
  editId: string | null
  dialog: "task" | "launch" | "dependencies" | "delete" | null
  error: string
  launch: Record<string, LaunchConfig>
  collapsed: string[]
  loaded: boolean
  refreshError: boolean
  events: {
    id: string
    taskId: string
    action:
      "created" | "edited" | "moved" | "queued" | "cancelled" | "dependencies"
    detail: string
  }[]
  positions: Record<string, { left: number; top: number }>
  nextId: number
}
export const blankDraft = (status: TaskStatus = "backlog"): TaskDraft => ({
  title: "",
  description: "",
  status,
  priority: "medium",
  kind: "feature",
  agent: "",
  dependencies: [],
})
export function safeBranch(id: string, title: string) {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    .replace(/-$/g, "")
  return `agent/${id.toLowerCase()}${slug ? `-${slug}` : ""}`
}
export function validBranch(value: string) {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    !/^[-./]|[./]$/.test(value) &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock")) &&
    value !== "@"
  )
}
export function createFactoryState(scenario: string): FactoryState {
  const tasks = scenario === "empty" ? [] : structuredClone(taskFixtures)
  if (scenario === "long-content")
    for (let i = 0; i < 24; i++)
      tasks.push({
        ...structuredClone(taskFixtures[i % 7]),
        id: `ARC-${300 + i}`,
        title: copy(
          `跨团队交付与依赖审查 ${i + 1}：保留完整上下文并验证所有任务边界`,
          `Cross-team delivery and dependency review ${i + 1}: preserve complete context and verify every task boundary`,
        ),
        dependencies: [],
      })
  return {
    tasks,
    selected: null,
    query: "",
    status: "",
    agent: "",
    priority: "",
    scope: "all",
    navOpen: true,
    tab: "summary",
    draft: blankDraft(),
    dependencyDraft: {},
    editId: null,
    dialog: null,
    error: "",
    launch: {},
    collapsed: [],
    loaded: scenario !== "loading",
    refreshError: scenario === "refresh-error",
    events: [],
    positions: {},
    nextId: 400,
  }
}
export function visibleTasks(state: FactoryState, locale: "zh-CN" | "en") {
  const query = state.query.trim().toLocaleLowerCase()
  return state.tasks.filter(
    (task) =>
      (!state.status || task.status === state.status) &&
      (!state.agent || task.agent === state.agent) &&
      (!state.priority || task.priority === state.priority) &&
      (state.scope !== "mine" || task.agent === "Builder") &&
      (state.scope !== "inbox" ||
        task.runtime !== "idle" ||
        task.dependencies.some(
          (id) => state.tasks.find((item) => item.id === id)?.status !== "done",
        )) &&
      (!query ||
        `${task.id} ${task.title[locale]} ${task.description[locale]} ${task.agent ?? ""}`
          .toLocaleLowerCase()
          .includes(query)),
  )
}
export function openTaskDraft(
  state: FactoryState,
  status: TaskStatus,
  task?: Task,
  locale: "zh-CN" | "en" = "en",
): FactoryState {
  const retained =
    state.editId === (task?.id ?? null) && state.draft.title.length > 0
  return {
    ...state,
    dialog: "task",
    editId: task?.id ?? null,
    error: "",
    draft: retained
      ? state.draft
      : task
        ? {
            title: task.title[locale],
            description: task.description[locale],
            status: task.status,
            priority: task.priority,
            kind: task.kind,
            agent: task.agent ?? "",
            dependencies: [...task.dependencies],
          }
        : blankDraft(status),
  }
}
function event(
  state: FactoryState,
  taskId: string,
  action: FactoryState["events"][number]["action"],
  detail: string,
) {
  return [
    ...state.events,
    { id: `event-${state.events.length + 1}`, taskId, action, detail },
  ]
}
export function dependencyError(
  tasks: readonly Task[],
  id: string,
  dependencies: readonly string[],
): string {
  if (dependencies.includes(id)) return "self-dependency"
  const byId = new Map(tasks.map((task) => [task.id, task]))
  if (dependencies.some((dependency) => !byId.has(dependency)))
    return "missing-dependency"
  const reaches = (from: string, visited: Set<string>): boolean => {
    if (from === id) return true
    if (visited.has(from)) return false
    visited.add(from)
    return (byId.get(from)?.dependencies ?? []).some((dependency) =>
      reaches(dependency, visited),
    )
  }
  return dependencies.some((dependency) => reaches(dependency, new Set()))
    ? "cycle"
    : ""
}
export function saveTask(state: FactoryState): FactoryState {
  const draft = state.draft
  if (!draft.title.trim()) return { ...state, error: "title-required" }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(draft.title + draft.description))
    return { ...state, error: "invalid-text" }
  const id = state.editId ?? `ARC-${state.nextId}`
  const error = dependencyError(state.tasks, id, draft.dependencies)
  if (error) return { ...state, error }
  const previous = state.tasks.find((task) => task.id === id)
  const task: Task = {
    id,
    title: copy(draft.title.trim(), draft.title.trim()),
    description: copy(draft.description.trim(), draft.description.trim()),
    detail:
      previous?.detail ??
      copy(draft.description.trim(), draft.description.trim()),
    status: draft.status,
    priority: draft.priority,
    kind: draft.kind,
    agent: draft.agent || null,
    dependencies: [...new Set(draft.dependencies)],
    checks: previous?.checks ?? [],
    files: previous?.files ?? [],
    runtime: previous?.runtime ?? "idle",
    revision: (previous?.revision ?? 0) + 1,
  }
  const launch = { ...state.launch }
  if (
    launch[id] &&
    previous &&
    launch[id].branch === safeBranch(id, previous.title.en)
  )
    launch[id] = { ...launch[id], branch: safeBranch(id, task.title.en) }
  return {
    ...state,
    tasks: previous
      ? state.tasks.map((item) => (item.id === id ? task : item))
      : [...state.tasks, task],
    selected: id,
    dialog: null,
    draft: blankDraft(),
    editId: null,
    error: "",
    launch,
    nextId: state.nextId + (previous ? 0 : 1),
    events: event(state, id, previous ? "edited" : "created", task.title.en),
  }
}
export function moveTask(
  state: FactoryState,
  id: string,
  status: TaskStatus,
): FactoryState {
  const task = state.tasks.find((item) => item.id === id)
  if (!task || task.status === status || !statuses.includes(status))
    return state
  return {
    ...state,
    tasks: state.tasks.map((item) =>
      item.id === id ? { ...item, status, revision: item.revision + 1 } : item,
    ),
    events: event(state, id, "moved", status),
  }
}
export function setDependencies(
  state: FactoryState,
  id: string,
  dependencies: string[],
): FactoryState {
  const error = dependencyError(state.tasks, id, dependencies)
  if (error) return { ...state, error }
  const dependencyDraft = { ...state.dependencyDraft }
  delete dependencyDraft[id]
  return {
    ...state,
    dependencyDraft,
    tasks: state.tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            dependencies: [...new Set(dependencies)],
            revision: task.revision + 1,
          }
        : task,
    ),
    dialog: null,
    error: "",
    events: event(state, id, "dependencies", dependencies.join(", ")),
  }
}
export function launchConfig(state: FactoryState, task: Task): LaunchConfig {
  return (
    state.launch[task.id] ?? {
      mode: "current",
      base: "main",
      branch: safeBranch(task.id, task.title.en),
      local: false,
      agent: task.agent ?? "Builder",
    }
  )
}
export function launchError(
  state: FactoryState,
  task: Task,
  config: LaunchConfig,
) {
  if (task.runtime !== "idle") return "already-active"
  if (!agents.includes(config.agent)) return "agent-required"
  if (
    task.dependencies.some(
      (id) => state.tasks.find((item) => item.id === id)?.status !== "done",
    )
  )
    return "blocked-dependency"
  if (
    config.mode === "new" &&
    (!validBranch(config.base) || !validBranch(config.branch))
  )
    return "invalid-branch"
  if (config.mode === "new" && config.base === config.branch)
    return "same-branch"
  return ""
}
export function queueRun(state: FactoryState, id: string): FactoryState {
  const task = state.tasks.find((item) => item.id === id)
  if (!task) return { ...state, error: "missing-task" }
  const config = launchConfig(state, task)
  const error = launchError(state, task, config)
  if (error) return { ...state, error }
  return {
    ...state,
    tasks: state.tasks.map((item) =>
      item.id === id
        ? {
            ...item,
            status: "in-progress",
            runtime: "queued",
            revision: item.revision + 1,
          }
        : item,
    ),
    launch: { ...state.launch, [id]: config },
    dialog: null,
    error: "",
    events: event(
      state,
      id,
      "queued",
      JSON.stringify({ ...config, source: "memory-fixture", taskId: id }),
    ),
  }
}
export function cancelQueuedRun(state: FactoryState, id: string): FactoryState {
  if (state.tasks.find((task) => task.id === id)?.runtime !== "queued")
    return state
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === id
        ? { ...task, runtime: "idle", revision: task.revision + 1 }
        : task,
    ),
    events: event(state, id, "cancelled", "memory-fixture"),
  }
}
export function deleteTask(state: FactoryState, id: string): FactoryState {
  if (state.tasks.some((task) => task.dependencies.includes(id)))
    return { ...state, error: "has-dependents" }
  if (state.tasks.find((task) => task.id === id)?.runtime !== "idle")
    return { ...state, error: "already-active" }
  const launch = { ...state.launch }
  delete launch[id]
  return {
    ...state,
    tasks: state.tasks.filter((task) => task.id !== id),
    selected: state.selected === id ? null : state.selected,
    dialog: null,
    error: "",
    launch,
  }
}
