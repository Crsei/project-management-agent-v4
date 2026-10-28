"use client"

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileCode2,
  GitBranch,
  Inbox,
  ListFilter,
  ListTodo,
  MoreHorizontal,
  PanelLeft,
  Play,
  Plus,
  Search,
  Settings2,
  Users,
} from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import {
  RadioGroup,
  RadioGroupItem,
} from "@easyuse-ui/ui/components/ui/radio-group"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
} from "@easyuse-ui/ui/components/blocks/sidebar"
import {
  BoardColumn,
  BoardItem,
} from "@easyuse-ui/ui/components/blocks/item-board"
import { GroupHeader } from "@easyuse-ui/ui/components/blocks/grouped-list"
import { ActivityTimeline } from "@easyuse-ui/ui/components/blocks/activity-timeline"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@easyuse-ui/ui/components/ui/select"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  agents,
  statusLabels,
  statuses,
  type Agent,
  type Copy,
  type Task,
  type TaskStatus,
} from "./fixtures"
import {
  cancelQueuedRun,
  createFactoryState,
  deleteTask,
  launchConfig,
  launchError,
  moveTask,
  openTaskDraft,
  queueRun,
  safeBranch,
  saveTask,
  setDependencies,
  visibleTasks,
  type FactoryState,
  type LaunchConfig,
  type TaskDraft,
} from "./controller"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const errors: Record<string, Copy> = {
  "title-required": { "zh-CN": "请输入任务标题。", en: "Enter a task title." },
  "invalid-text": {
    "zh-CN": "任务内容不能包含控制字符。",
    en: "Task content cannot contain control characters.",
  },
  "self-dependency": {
    "zh-CN": "任务不能依赖自身。",
    en: "A task cannot depend on itself.",
  },
  "missing-dependency": {
    "zh-CN": "依赖任务不存在。",
    en: "A dependency task is missing.",
  },
  cycle: {
    "zh-CN": "此依赖会形成循环。请保留草稿并选择其他任务。",
    en: "This dependency creates a cycle. Choose another task; your draft is retained.",
  },
  "blocked-dependency": {
    "zh-CN": "请先完成所有依赖任务。",
    en: "Complete all prerequisite tasks before queuing this run.",
  },
  "invalid-branch": {
    "zh-CN": "请输入安全的 Git 分支名称：不能含空格、..、控制字符或保留符号。",
    en: "Enter safe Git branch names without spaces, .., control characters, or reserved symbols.",
  },
  "same-branch": {
    "zh-CN": "新分支不能与基础分支相同。",
    en: "The new branch must differ from the base branch.",
  },
  "already-active": {
    "zh-CN": "此任务已有活动运行，不能重复启动或删除。",
    en: "This task already has an active run and cannot be relaunched or deleted.",
  },
  "has-dependents": {
    "zh-CN": "其他任务仍依赖此任务。请先修改依赖。",
    en: "Other tasks depend on this task. Update their dependencies first.",
  },
  "agent-required": { "zh-CN": "请选择 Agent。", en: "Select an agent." },
  "missing-task": {
    "zh-CN": "任务已不存在。",
    en: "The task no longer exists.",
  },
}
const eventLabels: Record<string, Copy> = {
  created: { "zh-CN": "已在内存中创建任务", en: "Task created in memory" },
  edited: { "zh-CN": "已更新任务", en: "Task updated" },
  moved: { "zh-CN": "已移动任务状态", en: "Task workflow status changed" },
  queued: {
    "zh-CN": "已加入本地示例队列（未执行）",
    en: "Queued in the local fixture (not executed)",
  },
  cancelled: {
    "zh-CN": "已取消本地排队记录",
    en: "Local queued entry cancelled",
  },
  dependencies: { "zh-CN": "已更新任务依赖", en: "Task dependencies updated" },
}

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <FactoryView key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}

function FactoryView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en)
  const c = (value: Copy) => value[locale]
  const [state, setState] = useRemainingPageState<FactoryState>(
    `agent-factory-1:${scenario}`,
    () => createFactoryState(scenario),
  )
  const readonly = scenario === "readonly"
  const selected = state.tasks.find((task) => task.id === state.selected)
  const visible = visibleTasks(state, locale)
  const root = useRef<HTMLDivElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const inspector = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const dialogOpener = useRef<HTMLButtonElement>(null)
  const drag = useRef<string | null>(null)
  const prefix = useId()
  const update = (patch: Partial<FactoryState>) =>
    setState((previous) => ({ ...previous, ...patch }))
  const remember = (id: string, node: HTMLElement) =>
    setState((previous) => ({
      ...previous,
      positions: {
        ...previous.positions,
        [id]: { left: node.scrollLeft, top: node.scrollTop },
      },
    }))
  useLayoutEffect(() => {
    if (board.current) {
      const p = state.positions.board
      if (p) {
        board.current.scrollLeft = p.left
        board.current.scrollTop = p.top
      }
    }
    if (inspector.current)
      inspector.current.scrollTop =
        state.positions[`inspector:${state.selected}:${state.tab}`]?.top ?? 0
    root.current
      ?.querySelectorAll<HTMLElement>("[data-column-scroll]")
      .forEach((node) => {
        const p = state.positions[node.dataset.columnScroll!]
        if (p) node.scrollTop = p.top
      })
  }, [state.selected, state.tab, state.positions])
  const closeInspector = () => {
    update({ selected: null })
    requestAnimationFrame(() => opener.current?.focus())
  }
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target as HTMLElement).closest(
          "[role=menu],[role=listbox],[role=dialog]",
        )
      )
        return
      if (event.key === "Escape" && !state.dialog && state.selected) {
        event.preventDefault()
        setState((previous) => ({ ...previous, selected: null }))
        requestAnimationFrame(() => opener.current?.focus())
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, state.dialog, state.selected, setState])
  const open = (task: Task, element?: HTMLElement) => {
    opener.current =
      element ??
      root.current?.querySelector<HTMLElement>(`[data-task="${task.id}"]`) ??
      (document.activeElement as HTMLElement)
    update({ selected: task.id, tab: "summary", error: "" })
  }
  const create = (status: TaskStatus = "backlog") => {
    if (!readonly) setState((previous) => openTaskDraft(previous, status))
  }
  const edit = (task: Task) => {
    if (!readonly)
      setState((previous) => openTaskDraft(previous, task.status, task, locale))
  }
  const patchDraft = (patch: Partial<TaskDraft>) =>
    setState((previous) => ({
      ...previous,
      draft: { ...previous.draft, ...patch },
      error: "",
    }))
  const config = selected ? launchConfig(state, selected) : null
  const patchLaunch = (patch: Partial<LaunchConfig>) => {
    if (selected && config)
      update({
        launch: { ...state.launch, [selected.id]: { ...config, ...patch } },
        error: "",
      })
  }
  const groupCount = (status: TaskStatus) =>
    state.tasks.filter((task) => task.status === status).length
  const nav = (
    title: string,
    icon: ReactNode,
    count: number | undefined,
    onSelect: () => void,
    chosen: boolean,
  ) => (
    <Item
      className={styles.navItem}
      title={title}
      leading={icon}
      trailing={
        count === undefined ? undefined : (
          <span className={styles.count}>{count}</span>
        )
      }
      density="compact"
      selected={chosen}
      onSelect={onSelect}
    />
  )
  const statusBadge = (status: TaskStatus) => (
    <span className={styles.status} data-status={status}>
      <i />
      {c(statusLabels[status])}
    </span>
  )
  const err = state.error
    ? c(errors[state.error] ?? errors["missing-task"])
    : ""
  const taskSelect = <T extends string>(
    label: string,
    value: T,
    entries: readonly { id: T; label: string }[],
    onChange: (value: T) => void,
  ) => (
    <Field label={label}>
      {(props) => (
        <Select
          value={value}
          items={Object.fromEntries(
            entries.map((entry) => [entry.id, entry.label]),
          )}
          onValueChange={(next) => {
            if (next !== null) onChange(next as T)
          }}
        >
          <SelectTrigger {...props} className={styles.select}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entries.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  )
  const disclosure = (
    id: string,
    title: string,
    body: ReactNode,
    count?: number,
  ) => {
    const expanded = !state.collapsed.includes(id)
    return (
      <section className={styles.disclosure}>
        <Button
          variant="ghost"
          className={styles.disclosureHeading}
          aria-expanded={expanded}
          aria-controls={`${prefix}-${id}`}
          onClick={() =>
            update({
              collapsed: expanded
                ? [...state.collapsed, id]
                : state.collapsed.filter((value) => value !== id),
            })
          }
        >
          {title}
          <ChevronDown size={14} data-closed={!expanded} />
          {count !== undefined && <span className={styles.count}>{count}</span>}
        </Button>
        {expanded && (
          <div id={`${prefix}-${id}`} className={styles.disclosureBody}>
            {body}
          </div>
        )}
      </section>
    )
  }
  const exportTasks = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            source: "memory-fixture",
            tasks: state.tasks,
            launch: state.launch,
            events: state.events,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "agent-factory-tasks.json"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const renderTask = (task: Task) => (
    <article
      data-task={task.id}
      role="group"
      tabIndex={0}
      aria-label={`${c(task.title)}. ${text("按 Enter 选择；左右方向键移动状态。", "Press Enter to select; use left and right arrow keys to move status.")}`}
      className={styles.card}
      data-selected={state.selected === task.id}
      draggable={!readonly}
      onDragStart={(event) => {
        drag.current = task.id
        event.dataTransfer.setData("text/plain", task.id)
        event.dataTransfer.effectAllowed = "move"
      }}
      onDragEnd={() => {
        drag.current = null
      }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button,[role=menuitem]"))
          open(task, event.currentTarget)
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          open(task, event.currentTarget)
        }
        if (
          !readonly &&
          (event.key === "ArrowRight" || event.key === "ArrowLeft")
        ) {
          event.preventDefault()
          const status =
            statuses[
              Math.max(
                0,
                Math.min(
                  3,
                  statuses.indexOf(task.status) +
                    (event.key === "ArrowRight" ? 1 : -1),
                ),
              )
            ]
          setState((previous) => moveTask(previous, task.id, status))
          requestAnimationFrame(() =>
            root.current
              ?.querySelector<HTMLElement>(`[data-task="${task.id}"]`)
              ?.focus(),
          )
        }
      }}
    >
      <div className={styles.cardTop}>
        <div>
          <p className={styles.taskId}>{task.id}</p>
          <h3>{c(task.title)}</h3>
          <p className={styles.description}>{c(task.description)}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className={styles.cardMenu}
                aria-label={`${text("更多操作", "More actions for")} ${c(task.title)}`}
                title={text("任务操作", "Task actions")}
              />
            }
          >
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => open(task)}>
              {text("查看任务", "View task")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={readonly} onClick={() => edit(task)}>
              {text("编辑任务", "Edit task")}
            </DropdownMenuItem>
            {statuses
              .filter((status) => status !== task.status)
              .map((status) => (
                <DropdownMenuItem
                  key={status}
                  disabled={readonly}
                  onClick={() =>
                    setState((previous) => moveTask(previous, task.id, status))
                  }
                >
                  {text("移动至", "Move to")} {c(statusLabels[status])}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem
              disabled={readonly}
              onClick={() => {
                open(task)
                update({ selected: task.id, dialog: "delete", error: "" })
              }}
            >
              {text("删除任务", "Delete task")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={styles.metadata}>
        {task.runtime !== "idle" ? (
          <RuntimeStatusBadge status={task.runtime} />
        ) : task.kind === "feature" ? (
          text("功能", "Feature")
        ) : (
          text("维护", "Maintenance")
        )}
        <span>/</span>
        <span>
          {task.priority === "high"
            ? text("高", "High")
            : task.priority === "medium"
              ? text("中", "Medium")
              : text("低", "Low")}
        </span>
      </div>
      <div className={styles.cardBottom}>
        {statusBadge(task.status)}
        {task.agent && (
          <span
            className={styles.avatar}
            data-agent={task.agent}
            title={task.agent}
            aria-label={task.agent}
          >
            {task.agent.slice(0, 1)}
          </span>
        )}
      </div>
    </article>
  )

  return (
    <div ref={root} className={styles.page} data-page="agent-factory-1" onClickCapture={(event) => {
      if (!state.dialog && event.target instanceof Element) {
        const button = event.target.closest<HTMLButtonElement>("button")
        if (button) dialogOpener.current = button
      }
    }}>
      {state.navOpen && (
        <Sidebar
          label={text("工厂导航", "Factory navigation")}
          width={234}
          className={styles.navigation}
        >
          <SidebarHeader className={styles.team}>
            <Box size={18} />
            <strong>Shadcnblocks</strong>
            <ChevronDown size={14} />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={text("切换主题", "Toggle theme")}
              title={text("切换主题", "Toggle theme")}
              onClick={() =>
                host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Circle size={15} />
            </Button>
          </SidebarHeader>
          <SidebarContent className={styles.navContent}>
            <p className={styles.navHeading}>{text("操作", "Actions")}</p>
            {nav(
              text("任务看板", "Task board"),
              <Box size={16} />,
              undefined,
              () =>
                update({
                  scope: "all",
                  status: "",
                  agent: "",
                  priority: "",
                  query: "",
                }),
              false,
            )}
            <p className={styles.navHeading}>{text("你的工作", "Your work")}</p>
            {nav(
              text("收件箱", "Inbox"),
              <Inbox size={16} />,
              state.tasks.filter(
                (task) =>
                  task.runtime !== "idle" ||
                  task.dependencies.some(
                    (id) =>
                      state.tasks.find((other) => other.id === id)?.status !==
                      "done",
                  ),
              ).length,
              () => update({ scope: "inbox", status: "", agent: "" }),
              state.scope === "inbox",
            )}
            {nav(
              text("我的任务", "My tasks"),
              <Circle size={16} />,
              state.tasks.filter((task) => task.agent === "Builder").length,
              () => update({ scope: "mine", status: "", agent: "" }),
              state.scope === "mine",
            )}
            {nav(
              text("所有任务", "All tasks"),
              <ListTodo size={16} />,
              state.tasks.length,
              () => update({ scope: "all", status: "", agent: "" }),
              state.scope === "all" && !state.status && !state.agent,
            )}
            <p className={styles.navHeading}>{text("状态", "Status")}</p>
            {statuses.map((status) => (
              <div key={status}>
                {nav(
                  c(statusLabels[status]),
                  <Circle size={16} />,
                  groupCount(status),
                  () =>
                    update({
                      scope: "all",
                      status: state.status === status ? "" : status,
                      agent: "",
                    }),
                  state.status === status,
                )}
              </div>
            ))}
            <p className={styles.navHeading}>Agents</p>
            {agents.map((agent) => (
              <div key={agent}>
                {nav(
                  agent,
                  <span className={styles.agentDot} data-agent={agent} />,
                  state.tasks.filter((task) => task.agent === agent).length,
                  () =>
                    update({
                      scope: "all",
                      agent: state.agent === agent ? "" : agent,
                      status: "",
                    }),
                  state.agent === agent,
                )}
              </div>
            ))}
          </SidebarContent>
          <SidebarFooter className={styles.navFooter}>
            <host.Link href={host.componentsHref}>
              <Settings2 size={16} />
              {text("工作区组件", "Workspace components")}
            </host.Link>
          </SidebarFooter>
        </Sidebar>
      )}
      <section className={styles.workspace}
      aria-label="Agent Factory 1" ><header className={styles.header}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={text("切换工厂导航", "Toggle AI workspace navigation")}
          title={text("切换工厂导航", "Toggle factory navigation")}
          aria-expanded={state.navOpen}
          onClick={() => update({ navOpen: !state.navOpen })}
        >
          <PanelLeft size={16} />
        </Button>
        <h1>Agent Factory 1</h1>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={text("工厂操作", "Agent Factory actions")}
                title={text("工厂操作", "Factory actions")}
              />
            }
          >
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={exportTasks}>
              {text("导出本地任务 JSON", "Export local task JSON")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                update({
                  query: "",
                  status: "",
                  agent: "",
                  priority: "",
                  scope: "all",
                })
              }
            >
              {text("清除所有筛选", "Clear all filters")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className={styles.toolbar}>
        <div className={styles.factoryTitle}>
          <Box size={16} />
          <span>{text("发布工厂", "Release factory")}</span>
          <span className={styles.branch}>
            <GitBranch size={12} />
            main
          </span>
        </div>
        <div className={styles.search}>
          <Search size={14} />
          <Input
            aria-label={text("搜索任务", "Search tasks")}
            placeholder={text("搜索任务", "Search tasks")}
            value={state.query}
            onChange={(event) => update({ query: event.target.value })}
          />
        </div>
        <span className={styles.count}>
          {state.tasks.length} {text("任务", "tasks")}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="secondary"
                size="icon"
                aria-label={text("筛选任务", "Filter tasks")}
                title={text("筛选任务", "Filter tasks")}
              />
            }
          >
            <ListFilter size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <p className={styles.menuLabel}>{text("优先级", "Priority")}</p>
            {(["high", "medium", "low"] as const).map((priority) => (
              <DropdownMenuCheckboxItem
                key={priority}
                checked={state.priority === priority}
                onCheckedChange={(checked) =>
                  update({ priority: checked ? priority : "" })
                }
              >
                {priority === "high"
                  ? text("高", "High")
                  : priority === "medium"
                    ? text("中", "Medium")
                    : text("低", "Low")}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuItem
              onClick={() =>
                update({
                  query: "",
                  status: "",
                  agent: "",
                  priority: "",
                  scope: "all",
                })
              }
            >
              {text("清除所有筛选", "Clear all filters")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button disabled={readonly || !state.loaded} onClick={() => create()}>
          <Plus size={16} />
          {text("新建任务", "New task")}
        </Button>
      </div>
      {readonly && (
        <p className={styles.notice}>
          {text(
            "只读场景：可搜索、筛选和查看；创建、修改及启动不可用。",
            "Read-only scenario: search, filter, and inspect; creation, edits, and launch are unavailable.",
          )}
        </p>
      )}
      {state.refreshError && (
        <div className={styles.notice} role="alert">
          {text(
            "刷新失败，保留最后的任务与草稿。",
            "Refresh failed. Last tasks and drafts are retained.",
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update({ refreshError: false })}
          >
            {text("重新载入本地示例", "Reload local fixture")}
          </Button>
        </div>
      )}
      <div className={styles.content}>
        <div
          ref={board}
          className={styles.boardScroll}
          role="region"
          aria-label={text("任务看板", "Task board")}
          tabIndex={0}
          onScroll={(event) => remember("board", event.currentTarget)}
        >
          {!state.loaded ? (
            <DataRegion
              state="loading"
              loadingLabel={text("加载任务", "Loading tasks")}
            />
          ) : (
            <>
              {visible.length === 0 && (
                <div className={styles.empty}>
                  <DataRegion
                    state="empty"
                    emptyTitle={
                      state.tasks.length
                        ? text("没有符合条件的任务", "No matching tasks")
                        : text("尚无任务", "No tasks yet")
                    }
                    emptyDescription={
                      state.tasks.length
                        ? text(
                            "清除筛选以查看现有任务。",
                            "Clear filters to view existing tasks.",
                          )
                        : text(
                            "创建任务并配置依赖与启动方式。",
                            "Create a task, then configure dependencies and launch options.",
                          )
                    }
                    emptyAction={
                      <Button
                        variant="secondary"
                        disabled={readonly && !state.tasks.length}
                        onClick={() =>
                          state.tasks.length
                            ? update({
                                query: "",
                                status: "",
                                agent: "",
                                priority: "",
                                scope: "all",
                              })
                            : create()
                        }
                      >
                        {state.tasks.length
                          ? text("清除筛选", "Clear filters")
                          : text("新建任务", "New task")}
                      </Button>
                    }
                  />
                </div>
              )}
              <div className={styles.board}>
                {statuses
                  .filter(
                    (status) => !state.status || state.status === status,
                  )
                  .map((status) => {
                    const tasks = visible.filter(
                      (task) => task.status === status,
                    )
                    const group = {
                      key: status,
                      label: c(statusLabels[status]),
                      loadedCount: tasks.length,
                      totalCount: tasks.length,
                      itemIds: tasks.map((task) => task.id),
                      dataState: "success" as const,
                      queryKey: "factory-tasks",
                    }
                    return (
                      <div
                        key={status}
                        className={styles.columnWrap}
                        onDragOver={(event) => {
                          if (!readonly && drag.current)
                            event.preventDefault()
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          if (!readonly && drag.current)
                            setState((previous) =>
                              moveTask(previous, drag.current!, status),
                            )
                          drag.current = null
                        }}
                      >
                        <BoardColumn
                          group={group}
                          collapsed={false}
                          header={
                            <GroupHeader
                              group={group}
                              collapsed={false}
                              onCreate={
                                readonly ? undefined : () => create(status)
                              }
                            />
                          }
                        >
                          <div
                            className={styles.columnScroll}
                            data-column-scroll={status}
                            onScroll={(event) =>
                              remember(status, event.currentTarget)
                            }
                          >
                            <ul className={styles.cards}>
                              {tasks.map((task) => (
                                <BoardItem key={task.id} id={task.id}>
                                  {renderTask(task)}
                                </BoardItem>
                              ))}
                            </ul>
                            <Button
                              className={styles.newIssue}
                              variant="ghost"
                              disabled={readonly}
                              onClick={() => create(status)}
                            >
                              <Plus size={14} />
                              {text("新建事项", "New issue")}
                            </Button>
                          </div>
                        </BoardColumn>
                      </div>
                    )
                  })}
              </div>
            </>
          )}
          {!state.loaded && (
            <Button
              className={styles.loadFixture}
              onClick={() => update({ loaded: true })}
            >
              {text("载入本地示例", "Load local fixture")}
            </Button>
          )}
        </div>
        {selected && (
          <aside
            className={styles.inspector}
            aria-label={text("任务检查器", "Task inspector")}
          >
            <div className={styles.inspectorHeader}>
              <div className={styles.breadcrumb}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={text("返回任务看板", "Back to task board")}
                  title={text("返回任务看板", "Back to task board")}
                  onClick={closeInspector}
                >
                  <ArrowLeft size={16} />
                </Button>
                <span>{text("发布工厂", "Release factory")}</span>/
                <span>{selected.id}</span>
                <Button
                  className={styles.editButton}
                  variant="ghost"
                  size="sm"
                  disabled={readonly}
                  onClick={() => edit(selected)}
                >
                  {text("编辑", "Edit")}
                </Button>
              </div>
              <h2>{c(selected.title)}</h2>
              <div className={styles.metadata}>
                {selected.agent && (
                  <span className={styles.avatar} data-agent={selected.agent}>
                    {selected.agent.slice(0, 1)}
                  </span>
                )}
                {selected.agent ?? text("未分配", "Unassigned")} ·{" "}
                {text("18 分钟前更新", "updated 18 min ago")}
              </div>
              <div className={styles.codeMeta}>
                <code>main</code>
                <ArrowRight size={12} />
                <code>{safeBranch(selected.id, selected.title.en)}</code>
                <span>{selected.files.length}</span>
                <span className={styles.additions}>+72</span>
                <span className={styles.deletions}>−9</span>
              </div>
            </div>
            <Tabs
              value={state.tab}
              onValueChange={(tab) =>
                update({ tab: tab as FactoryState["tab"] })
              }
              className={styles.inspectorTabs}
            >
              <TabsList className={styles.tabs}>
                <TabsTab value="summary">{text("概要", "Summary")}</TabsTab>
                <TabsTab value="timeline">
                  {text("时间线", "Timeline")}
                </TabsTab>
                <TabsTab value="code">{text("代码", "Code")}</TabsTab>
                <span className={styles.checkCount}>
                  <CheckCircle2 size={12} />
                  1/{selected.checks.length + 1} {text("检查", "checks")}
                </span>
              </TabsList>
              <div
                ref={inspector}
                className={styles.inspectorScroll}
                onScroll={(event) =>
                  remember(
                    `inspector:${selected.id}:${state.tab}`,
                    event.currentTarget,
                  )
                }
              >
                <TabsPanel value="summary" className={styles.summary}>
                  <dl className={styles.properties}>
                    <dt>
                      <Users size={14} />
                      {text("审查者", "Reviewers")}
                    </dt>
                    <dd>Reviewer, Verifier</dd>
                    <dt>
                      <ListFilter size={14} />
                      {text("标签", "Labels")}
                    </dt>
                    <dd>
                      {selected.kind === "feature"
                        ? text("功能", "Feature")
                        : text("维护", "Maintenance")}{" "}
                      · {selected.priority}
                    </dd>
                    <dt>
                      <Inbox size={14} />
                      {text("评论", "Comments")}
                    </dt>
                    <dd>{text("1 条审查评论", "1 review comment")}</dd>
                  </dl>
                  {disclosure(
                    "description",
                    text("描述", "Description"),
                    <>
                      <p>{c(selected.description)}</p>
                      <p className={styles.description}>
                        {c(selected.detail)}
                      </p>
                      {selected.files[0] && (
                        <p>
                          {text("主要范围", "Primary scope")}:{" "}
                          <code>{selected.files[0]}</code>
                        </p>
                      )}
                    </>,
                  )}
                  {disclosure(
                    "checks",
                    text("检查", "Checks"),
                    <div className={styles.checks}>
                      <div>
                        <CheckCircle2 size={14} />
                        <span>
                          {text("已确定任务范围", "Task scope resolved")}
                        </span>
                        <span>
                          {text("已通过（示例）", "Passed (fixture)")}
                        </span>
                      </div>
                      {selected.checks.map((check, index) => (
                        <div key={index}>
                          <Circle size={14} />
                          <span>{c(check)}</span>
                          <span>{text("待检查", "Pending")}</span>
                        </div>
                      ))}
                    </div>,
                    selected.checks.length + 1,
                  )}
                  {disclosure(
                    "comments",
                    text("评论", "Comments"),
                    <article className={styles.comment}>
                      <strong>Reviewer</strong>
                      <span className={styles.count}>12 min ago</span>
                      <p>
                        {text(
                          "任务标题更改后，分支预览也应始终与提交的配置保持一致。",
                          "The branch preview should always match the value sent to the runner, including after the task title changes.",
                        )}
                      </p>
                    </article>,
                    1,
                  )}
                  {disclosure(
                    "run-with",
                    text("运行 Agent", "Run with"),
                    <div className={styles.agentChoices}>
                      {agents.map((agent) => (
                        <Button
                          key={agent}
                          variant="secondary"
                          disabled={readonly}
                          aria-pressed={config?.agent === agent}
                          onClick={() => patchLaunch({ agent })}
                        >
                          <span
                            className={styles.agentDot}
                            data-agent={agent}
                          />
                          {agent}
                          {config?.agent === agent && <Check size={14} />}
                        </Button>
                      ))}
                    </div>,
                  )}
                  {disclosure(
                    "dependencies",
                    text("依赖", "Dependencies"),
                    <>
                      <div>
                        {selected.dependencies.length ? (
                          selected.dependencies.map((id) => {
                            const task = state.tasks.find(
                              (item) => item.id === id,
                            )
                            return (
                              <Item
                                key={id}
                                title={`${id} · ${task ? c(task.title) : text("任务不存在", "Missing task")}`}
                                leading={<GitBranch size={14} />}
                                trailing={task && statusBadge(task.status)}
                                onSelect={task ? () => open(task) : undefined}
                              />
                            )
                          })
                        ) : (
                          <p className={styles.description}>
                            {text("无前置任务。", "No prerequisites.")}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={readonly}
                        onClick={() =>
                          update({
                            dialog: "dependencies",
                            dependencyDraft: {
                              ...state.dependencyDraft,
                              [selected.id]: state.dependencyDraft[
                                selected.id
                              ] ?? [...selected.dependencies],
                            },
                            error: "",
                          })
                        }
                      >
                        {text("管理依赖", "Manage dependencies")}
                      </Button>
                    </>,
                    selected.dependencies.length,
                  )}
                </TabsPanel>
                <TabsPanel value="timeline">
                  <ActivityTimeline
                    compact
                    events={[
                      {
                        id: `${selected.id}:created`,
                        time: "Aug 24",
                        type: "task",
                        action: text(
                          "任务已加入发布队列",
                          "Task added to the release queue",
                        ),
                        target: selected.id,
                        status: "idle",
                        details: c(selected.description),
                      },
                      {
                        id: `${selected.id}:branch`,
                        time: "22 min ago",
                        type: "context",
                        action: text(
                          "已准备工作分支（示例）",
                          "Working branch prepared (fixture)",
                        ),
                        target: safeBranch(selected.id, selected.title.en),
                        status: "idle",
                        details: selected.files.join("\n"),
                      },
                      ...state.events
                        .filter((event) => event.taskId === selected.id)
                        .map((event) => ({
                          id: event.id,
                          time: text("刚刚", "Just now"),
                          type: "local",
                          action: c(eventLabels[event.action]),
                          status:
                            event.action === "queued" ? "queued" : "idle",
                          details: (
                            <pre className={styles.eventDetail}>
                              {event.detail}
                            </pre>
                          ),
                        })),
                    ]}
                  />
                </TabsPanel>
                <TabsPanel value="code">
                  <div className={styles.codeBody}>
                    <h3>
                      {text(
                        "更改文件（固定示例）",
                        "Changed files (fixture)",
                      )}
                    </h3>
                    {selected.files.map((file, index) => (
                      <Item
                        key={file}
                        title={file.split("/").at(-1)}
                        description={file.split("/").slice(0, -1).join("/")}
                        leading={<FileCode2 size={16} />}
                        trailing={
                          <span className={styles.count}>
                            {index ? "+8 −0 A" : "+64 −9 M"}
                          </span>
                        }
                      />
                    ))}
                    {!selected.files.length && (
                      <p>
                        {text(
                          "此任务尚无文件范围。",
                          "No files are scoped to this task yet.",
                        )}
                      </p>
                    )}
                    <p className={styles.description}>
                      {text(
                        "审查实现及定向回归测试后，再将任务移至已完成。此处只显示固定范围，不读取仓库。",
                        "Review the implementation and its focused regression test before moving the task to Done. This is a fixed scope snapshot, not repository access.",
                      )}
                    </p>
                  </div>
                </TabsPanel>
              </div>
            </Tabs>
            <footer className={styles.inspectorFooter}>
              <div>
                <strong>
                  {text("运行 Agent", "Run with")} {config?.agent}
                </strong>
                <code>{config?.mode === "new" ? config.branch : "main"}</code>
                {selected.runtime !== "idle" && (
                  <RuntimeStatusBadge status={selected.runtime} />
                )}
              </div>
              {selected.runtime === "queued" ? (
                <Button
                  variant="secondary"
                  disabled={readonly}
                  onClick={() =>
                    setState((previous) =>
                      cancelQueuedRun(previous, selected.id),
                    )
                  }
                >
                  {text("取消排队", "Cancel queued run")}
                </Button>
              ) : (
                <Button
                  disabled={readonly || selected.runtime !== "idle"}
                  aria-describedby={
                    selected.runtime !== "idle"
                      ? "factory-runtime-reason"
                      : undefined
                  }
                  onClick={() => update({ dialog: "launch", error: "" })}
                >
                  <Play size={16} />
                  {text("运行任务", "Run task")}
                </Button>
              )}
              {selected.runtime === "running" && (
                <span id="factory-runtime-reason" className="sr-only">
                  {text(
                    "固定示例正在运行，不能重复启动。",
                    "The running fixture cannot be launched again.",
                  )}
                </span>
              )}
            </footer>
          </aside>
        )}
      </div></section>
      <Dialog
        open={active && state.dialog !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) update({ dialog: null, error: "" })
        }}
      >
        <DialogContent className={styles.dialog} finalFocus={dialogOpener}>
          {state.dialog === "task" && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!readonly) setState(saveTask)
              }}
            >
              <DialogTitle>
                {state.editId
                  ? text("编辑任务", "Edit task")
                  : text("新建任务", "New task")}
              </DialogTitle>
              <DialogDescription>
                {text(
                  "仅保存到当前场景内存；不会创建外部任务。",
                  "Saved only in this scenario's memory; no external task is created.",
                )}
              </DialogDescription>
              <div className={styles.formBody}>
                <Field
                  label={text("标题", "Title")}
                  required
                  error={state.error === "title-required" ? err : undefined}
                >
                  {(props) => (
                    <Input
                      {...props}
                      autoFocus
                      value={state.draft.title}
                      onChange={(event) =>
                        patchDraft({ title: event.target.value })
                      }
                    />
                  )}
                </Field>
                <Field label={text("描述", "Description")}>
                  {(props) => (
                    <Textarea
                      {...props}
                      value={state.draft.description}
                      onChange={(event) =>
                        patchDraft({ description: event.target.value })
                      }
                    />
                  )}
                </Field>
                <div className={styles.formGrid}>
                  {taskSelect(
                    text("状态", "Status"),
                    state.draft.status,
                    statuses.map((status) => ({
                      id: status,
                      label: c(statusLabels[status]),
                    })),
                    (status) => patchDraft({ status }),
                  )}
                  {taskSelect(
                    text("优先级", "Priority"),
                    state.draft.priority,
                    [
                      { id: "low", label: text("低", "Low") },
                      { id: "medium", label: text("中", "Medium") },
                      { id: "high", label: text("高", "High") },
                    ],
                    (priority) => patchDraft({ priority }),
                  )}
                  {taskSelect(
                    text("类别", "Type"),
                    state.draft.kind,
                    [
                      { id: "feature", label: text("功能", "Feature") },
                      { id: "maintenance", label: text("维护", "Maintenance") },
                    ],
                    (kind) => patchDraft({ kind }),
                  )}
                  {taskSelect(
                    "Agent",
                    state.draft.agent,
                    [
                      { id: "", label: text("未分配", "Unassigned") },
                      ...agents.map((agent) => ({ id: agent, label: agent })),
                    ],
                    (agent) => patchDraft({ agent: agent as Agent | "" }),
                  )}
                </div>
              </div>
              {state.error && state.error !== "title-required" && (
                <p role="alert" className={styles.error}>
                  {err}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => update({ dialog: null, error: "" })}
                >
                  {text("取消", "Cancel")}
                </Button>
                <Button type="submit" disabled={readonly}>
                  {state.editId
                    ? text("保存任务", "Save task")
                    : text("创建任务", "Create task")}
                </Button>
              </DialogFooter>
            </form>
          )}
          {state.dialog === "launch" && selected && config && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!readonly)
                  setState((previous) => queueRun(previous, selected.id))
              }}
            >
              <DialogTitle>
                {text("启动", "Launch")} {config.agent}
              </DialogTitle>
              <DialogDescription>
                {text(
                  `为 ${selected.id} 准备本地示例配置。不会运行命令、创建分支或连接 Provider。`,
                  `Prepare a local fixture configuration for ${selected.id}. No commands, branches, or Provider calls are executed.`,
                )}
              </DialogDescription>
              <div className={styles.formBody}>
                <RadioGroup
                  aria-label={text("分支模式", "Branch mode")}
                  value={config.mode}
                  onValueChange={(mode) =>
                    patchLaunch({ mode: mode as LaunchConfig["mode"] })
                  }
                >
                  {(["current", "new"] as const).map((mode) => (
                    <label
                      key={mode}
                      className={styles.radioCard}
                      data-selected={config.mode === mode}
                    >
                      <RadioGroupItem value={mode} />
                      <GitBranch size={18} />
                      <span>
                        <strong>
                          {mode === "current"
                            ? text("当前分支", "Current branch")
                            : text("新分支", "New branch")}
                        </strong>
                        <small>
                          {mode === "current"
                            ? text(
                                "使用当前工作区分支",
                                "Use the active workspace branch",
                              )
                            : text(
                                "在独立分支中隔离此任务",
                                "Isolate this task in a dedicated branch",
                              )}
                        </small>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                {config.mode === "new" && (
                  <>
                    <Field
                      label={text("基础分支", "Base branch")}
                      error={state.error === "invalid-branch" ? err : undefined}
                    >
                      {(props) => (
                        <Input
                          {...props}
                          value={config.base}
                          onChange={(event) =>
                            patchLaunch({ base: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <Field label={text("分支名称", "Branch name")}>
                      {(props) => (
                        <Input
                          {...props}
                          value={config.branch}
                          onChange={(event) =>
                            patchLaunch({ branch: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <label className={styles.switchRow}>
                      <span>
                        <strong>{text("本地工作区", "Local workspace")}</strong>
                        <small>
                          {text(
                            "在当前目录准备本地启动配置",
                            "Prepare launch configuration in the current directory",
                          )}
                        </small>
                      </span>
                      <Switch
                        checked={config.local}
                        onCheckedChange={(local) => patchLaunch({ local })}
                        aria-label={text("本地工作区", "Local workspace")}
                      />
                    </label>
                  </>
                )}
                {launchError(state, selected, config) ===
                  "blocked-dependency" && (
                  <p className={styles.error}>
                    {c(errors["blocked-dependency"])}
                  </p>
                )}
              </div>
              {state.error && (
                <p role="alert" className={styles.error}>
                  {err}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => update({ dialog: null, error: "" })}
                >
                  {text("取消", "Cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    readonly ||
                    launchError(state, selected, config) ===
                      "blocked-dependency"
                  }
                >
                  <Play size={14} />
                  {text("确认加入示例队列", "Confirm fixture run")}
                </Button>
              </DialogFooter>
            </form>
          )}
          {state.dialog === "dependencies" && selected && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!readonly)
                  setState((previous) =>
                    setDependencies(
                      previous,
                      selected.id,
                      previous.dependencyDraft[selected.id] ??
                        selected.dependencies,
                    ),
                  )
              }}
            >
              <DialogTitle>
                {text("管理依赖", "Manage dependencies")}
              </DialogTitle>
              <DialogDescription>
                {selected.id} ·{" "}
                {text(
                  "运行前必须完成所有前置任务。循环依赖会被拒绝。",
                  "All prerequisites must be Done before launch. Cyclic dependencies are rejected.",
                )}
              </DialogDescription>
              <div className={styles.dependencyOptions}>
                {state.tasks
                  .filter((task) => task.id !== selected.id)
                  .map((task) => (
                    <label key={task.id}>
                      <Checkbox
                        checked={(
                          state.dependencyDraft[selected.id] ??
                          selected.dependencies
                        ).includes(task.id)}
                        onCheckedChange={(checked) =>
                          update({
                            dependencyDraft: {
                              ...state.dependencyDraft,
                              [selected.id]: checked
                                ? [
                                    ...(state.dependencyDraft[selected.id] ??
                                      selected.dependencies),
                                    task.id,
                                  ]
                                : (
                                    state.dependencyDraft[selected.id] ??
                                    selected.dependencies
                                  ).filter((id) => id !== task.id),
                            },
                            error: "",
                          })
                        }
                      />
                      <span>
                        {task.id} · {c(task.title)}
                      </span>
                      {statusBadge(task.status)}
                    </label>
                  ))}
              </div>
              {state.error && (
                <p role="alert" className={styles.error}>
                  {err}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => update({ dialog: null, error: "" })}
                >
                  {text("取消", "Cancel")}
                </Button>
                <Button type="submit" disabled={readonly}>
                  {text("保存依赖", "Save dependencies")}
                </Button>
              </DialogFooter>
            </form>
          )}
          {state.dialog === "delete" && selected && (
            <>
              <DialogTitle>
                {text("删除任务", "Delete task")} {selected.id}?
              </DialogTitle>
              <DialogDescription>
                {text(
                  "仅移除本地内存记录；有依赖者或活动运行的任务不能删除。",
                  "Remove only the local memory record. Tasks with dependents or active runs cannot be deleted.",
                )}
              </DialogDescription>
              {state.error && (
                <p role="alert" className={styles.error}>
                  {err}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => update({ dialog: null, error: "" })}
                >
                  {text("取消", "Cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={readonly}
                  onClick={() =>
                    setState((previous) => deleteTask(previous, selected.id))
                  }
                >
                  {text("删除任务", "Delete task")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
