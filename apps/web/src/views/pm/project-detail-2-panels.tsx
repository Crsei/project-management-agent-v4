import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useRef,
  type ReactNode,
} from "react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Timeline,
  type TimelineRecord,
} from "@/components/blocks/timeline"
import { PmMemberIdentity, PmSearch, usePmScenarioState } from "./shared"
import {
  analyticsEntityKey,
  type AnalyticsEntityRef,
} from "@/lib/analytics-model"
import type {
  CanvasDocument,
  CanvasNodeDefinition,
  CanvasSelection,
} from "@/lib/canvas-model"
import {
  timelineViewport,
  type TimelineScale,
  type TimelineSettings,
} from "@/lib/schedule-view-model"
import { useI18n } from "@/lib/i18n-provider"
import { pmMembers } from "./model"
import type { Copy } from "../views-model"
import {
  issueCatalog,
  issueGroups,
  issueRecord,
  type PmIssue,
} from "./issue-domain"
import {
  formatProjectDay,
  formatProjectInstant,
  projectDependencies,
  projectOverview,
  validateProjectDependencies,
  type ProjectIssueStats,
  type ProjectsFamily,
} from "./projects-domain"
import type { ProjectCardRecord } from "./project-list-1-fixtures"
import { usePmNavigation } from "./domain-session"
import { ChevronRight, ClipboardList, Clock3, FileText, Flag, GripVertical, Users } from "lucide-react"
import styles from "./projects-views.module.css"
import workspaceStyles from "./project-detail-2.module.css"
import type { WorkflowCanvasProps } from "@/components/blocks/workflow-canvas"
import { CanvasPort } from "@/components/ui/canvas-port"
import { WorkItemBoard } from "@/components/blocks/work-items-views"
import { ScrollArea } from "@/components/ui/scroll-area"

const importWorkflowCanvas = () =>
  import("@/components/blocks/workflow-canvas").then((module) => ({
    default: module.WorkflowCanvas,
  }))
let WorkflowCanvas = lazy(importWorkflowCanvas)

class CanvasLoadBoundary extends Component<
  {
    onRetry: () => void
    title: string
    retryLabel: string
    children: ReactNode
  },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <Alert tone="error" data-pm-canvas-error>
          <AlertTitle headingLevel={2}>{this.props.title}</AlertTitle>
          <AlertDescription>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                this.setState({ failed: false })
                this.props.onRetry()
              }}
            >
              {this.props.retryLabel}
            </Button>
          </AlertDescription>
        </Alert>
      )
    return this.props.children
  }
}

function taskLabels(issue: PmIssue, locale: "zh-CN" | "en") {
  const catalog = issueCatalog(locale)
  const member = pmMembers.find((m) => m.id === issue.assigneeIds[0])
  return {
    localized: issueRecord(issue, locale),
    state:
      catalog.states.find((state) => state.id === issue.stateId)?.label ??
      issue.stateId,
    priority:
      catalog.priorities.find((p) => p.id === issue.priorityId)?.label ??
      issue.priorityId,
    assignee: member?.name ?? (locale === "en" ? "No owner" : "无负责人"),
    labels: issue.labelIds
      .map((id) => catalog.labels.find((label) => label.id === id)?.label ?? id)
      .join(", "),
  }
}

export function ProjectTasksPanel({ issues }: { issues: PmIssue[] }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [selectedId, setSelectedId] = usePmScenarioState<string | null>(
    "tasks-selected",
    () => null,
  )
  const [collapsed, setCollapsed] = usePmScenarioState<string[]>(
    "tasks-collapsed",
    () => [],
  )
  const [scrollLeft, setScrollLeft] = usePmScenarioState(
    "tasks-horizontal-scroll",
    () => 0,
  )
  const taskReading = useRef(scrollLeft)
  const restoreTaskReading = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      node.scrollLeft = taskReading.current
      const remember = () => {
        taskReading.current = node.scrollLeft
        setScrollLeft(node.scrollLeft)
      }
      // Cache at native scroll completion/unmount, not every animation frame.
      node.addEventListener("scrollend", remember)
      return () => {
        remember()
        node.removeEventListener("scrollend", remember)
      }
    },
    [setScrollLeft],
  )
  const catalog = issueCatalog(locale)
  const groups = issueGroups(issues, locale, "pm-project-tasks")
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const selected = selectedId ? byId.get(selectedId) : undefined
  if (issues.length === 0)
    return (
      <Empty
        title={en ? "No tasks in this scene" : "本场景没有任务"}
        description={
          en
            ? "The shared issue domain has no items for this project."
            : "共享 Issue 域中本项目没有条目。"
        }
      />
    )
  return (
    <div className={styles.panelStack} data-pm-tasks-panel>
      <ScrollArea
        ref={restoreTaskReading}
        onFocusCapture={(event) => {
          const viewport = event.currentTarget
          const target = event.target
          if (
            !(target instanceof HTMLElement) ||
            target === viewport ||
            !viewport.contains(target)
          )
            return
          const viewportBounds = viewport.getBoundingClientRect()
          const targetBounds = target.getBoundingClientRect()
          const left = viewportBounds.left + viewport.clientLeft + 4
          const right =
            viewportBounds.left + viewport.clientLeft + viewport.clientWidth - 4
          const delta =
            targetBounds.left < left
              ? targetBounds.left - left
              : targetBounds.right > right
                ? targetBounds.right - right
                : 0
          if (delta) viewport.scrollBy({ left: delta, behavior: "instant" })
        }}
        className={styles.tasksViewport}
        label={en ? "Project task lanes" : "项目任务分栏"}
        orientation="horizontal"
        data-pm-task-lanes
      >
        <WorkItemBoard
          className={styles.tasksBoard}
          queryKey="pm-project-tasks"
          items={issues.map((issue) => issueRecord(issue, locale))}
          groups={groups}
          interaction={{
            selectedIds: selectedId ? [selectedId] : [],
            activeItemId: selectedId,
            collapsedGroupIds: collapsed,
          }}
          onSelectionChange={(ids) => setSelectedId(ids.at(-1) ?? null)}
          onToggleGroup={(key) =>
            setCollapsed((previous) =>
              previous.includes(key)
                ? previous.filter((id) => id !== key)
                : [...previous, key],
            )
          }
          getPresentation={(item) => {
            const estimate = byId.get(item.id)?.estimate
            return {
              catalog,
              visibleProperties: [
                "state",
                "priority",
                "assignees",
              ],
              onOpen: (selected) => setSelectedId(selected.id),
              actions: estimate !== null && estimate !== undefined ? (
                <span className={styles.taskEstimate}>{estimate}{en ? " pts" : " 点"}</span>
              ) : null,
            }
          }}
        />
      </ScrollArea>
      {selected && (
        <div className={styles.taskInspector} data-pm-task-inspector>
          <strong>{taskLabels(selected, locale).localized.title}</strong>
          <p>{taskLabels(selected, locale).localized.description}</p>
          <p className={styles.muted}>
            {selected.startAt
              ? `${en ? "Starts" : "开始"} ${formatProjectInstant(selected.startAt, locale)}`
              : en
                ? "No scheduled start"
                : "未安排开始时间"}
            {" · "}
            {en ? "revision" : "版本"} {selected.revision}
          </p>
          <dl data-pm-task-facts>
            <div><dt>{en ? "Labels" : "标签"}</dt><dd>{taskLabels(selected, locale).labels || "—"}</dd></div>
            <div><dt>{en ? "Due date" : "截止日期"}</dt><dd>{selected.dueDate ?? "—"}</dd></div>
            <div><dt>{en ? "Estimate" : "估点"}</dt><dd>{selected.estimate ?? "—"}</dd></div>
          </dl>
        </div>
      )}
    </div>
  )
}

export function ProjectIssuesPanel({ issues }: { issues: PmIssue[] }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [filters, setFilters] = usePmScenarioState(
    "issues-table-state",
    () => ({
      search: "",
      state: "all",
    }),
  )
  const catalog = issueCatalog(locale)
  const query = filters.search.trim().toLocaleLowerCase(locale)
  const rows = issues.filter((issue) => {
    const labels = taskLabels(issue, locale)
    return (
      (filters.state === "all" || issue.stateId === filters.state) &&
      (!query ||
        `${issue.identifier} ${labels.localized.title} ${labels.assignee}`
          .toLocaleLowerCase(locale)
          .includes(query))
    )
  })
  if (issues.length === 0)
    return (
      <Empty
        title={en ? "No issues for this project" : "本项目没有 Issue"}
        description={
          en
            ? "Nothing in the shared issue domain references this project."
            : "共享 Issue 域中没有引用本项目的条目。"
        }
      />
    )
  return (
    <div className={styles.panelStack} data-pm-issues-panel>
      <details className={workspaceStyles.issueFilters} data-pm-issue-filters>
        <summary>{en ? "Filter issues" : "筛选 Issue"}</summary>
      <div className={styles.toolbarGroup}>
        <PmSearch
          value={filters.search}
          onChange={(value) =>
            setFilters((previous) => ({ ...previous, search: value }))
          }
          label={en ? "Search issues" : "搜索 Issue"}
        />
        <Select
          value={filters.state}
          onValueChange={(value) => {
            if (value !== null)
              setFilters((previous) => ({ ...previous, state: value }))
          }}
        >
          <SelectTrigger aria-label={en ? "Filter by status" : "按状态筛选"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {en ? "All statuses" : "全部状态"}
            </SelectItem>
            {catalog.states.map((state) => (
              <SelectItem key={state.id} value={state.id}>
                {state.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className={styles.muted}>
          {en
            ? `${rows.length} of ${issues.length}`
            : `${rows.length} / ${issues.length}`}
        </span>
      </div>
      </details>
      {rows.length === 0 ? (
        <p className={styles.muted} data-pm-issues-filter-empty>
          {en
            ? "No issues match the current filters."
            : "没有 Issue 符合当前筛选条件。"}
        </p>
      ) : (
        <TableContainer>
          <Table data-pm-issues-table>
            <TableHeader>
              <tr>
                <TableHead>{en ? "Issue" : "Issue"}</TableHead>
                <TableHead>{en ? "Status" : "状态"}</TableHead>
                <TableHead>{en ? "Priority" : "优先级"}</TableHead>
                <TableHead>{en ? "Assignee" : "负责人"}</TableHead>
                <TableHead>{en ? "Labels" : "标签"}</TableHead>
                <TableHead>{en ? "Start date" : "开始日期"}</TableHead>
                <TableHead>{en ? "Due date" : "截止日期"}</TableHead>
                <TableHead>{en ? "Cycle" : "周期"}</TableHead>
                <TableHead>{en ? "Module" : "模块"}</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {rows.map((issue) => {
                const labels = taskLabels(issue, locale)
                const member = pmMembers.find((candidate) => candidate.id === issue.assigneeIds[0])
                return (
                  <TableRow key={issue.id} data-pm-issue-row={issue.id}>
                    <TableCell>
                      <span className={workspaceStyles.issueIdentity}>
                        <span>{issue.identifier}</span>
                        <span title={labels.localized.title}>{labels.localized.title}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge size="sm" data-pm-issue-state={issue.stateId}>{labels.state}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className={workspaceStyles.issuePriority}><Flag aria-hidden="true" />{labels.priority}</span>
                    </TableCell>
                    <TableCell>{member ? <PmMemberIdentity member={member} /> : labels.assignee}</TableCell>
                    <TableCell>{labels.labels || "—"}</TableCell>
                    <TableCell>{issue.startDate ?? "—"}</TableCell>
                    <TableCell>{issue.dueDate ?? "—"}</TableCell>
                    <TableCell>{issue.cycleId}</TableCell>
                    <TableCell>{issue.moduleId}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </div>
  )
}

type TimelineState = {
  scale: TimelineScale
  scroll: { top: number; left: number }
  activeId: string | null
}
export function ProjectTimelinePanel({ issues, variant = "workspace" }: { issues: PmIssue[]; variant?: "brief" | "workspace" }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [state, setState] = usePmScenarioState<TimelineState>(
    "timeline-state",
    () => ({ scale: "month", scroll: { top: 0, left: 0 }, activeId: null }),
  )
  const scheduled = issues.filter((issue) => issue.startDate && issue.dueDate)
  const unscheduled = issues.filter(
    (issue) => !issue.startDate || !issue.dueDate,
  )
  const settings: TimelineSettings = {
    anchorDate: "2026-01-12",
    timeZone: "UTC",
    weekStartsOn: 1,
    scale: state.scale,
  }
  const records: TimelineRecord[] = []
  for (const issue of scheduled) {
    if (!issue.startDate || !issue.dueDate) continue
    records.push({
      id: issue.id,
      label: `${issue.identifier} ${issueRecord(issue, locale).title}`,
      startDate: issue.startDate,
      dueDate: issue.dueDate,
    })
  }
  if (issues.length === 0)
    return (
      <Empty
        title={en ? "Nothing to schedule" : "没有可排期的内容"}
        description={
          en
            ? "No shared issues reference this project."
            : "没有共享 Issue 引用本项目。"
        }
      />
    )
  return (
    <div className={styles.timelineLayout} data-pm-timeline-panel data-pm-timeline-variant={variant}>
      <details data-pm-timeline-scales>
        <summary>{en ? "Timeline scale" : "时间线比例"}</summary>
      <div className={styles.toolbarGroup}>
        {(["week", "month", "quarter"] as TimelineScale[]).map((scale) => (
          <button
            key={scale}
            type="button"
            className={styles.chipToggle}
            aria-pressed={state.scale === scale}
            onClick={() => setState((previous) => ({ ...previous, scale }))}
          >
            {scale === "week"
              ? en
                ? "Week"
                : "周"
              : scale === "month"
                ? en
                  ? "Month"
                  : "月"
                : en
                  ? "Quarter"
                  : "季度"}
          </button>
        ))}
      </div>
      </details>
      {records.length > 0 ? (
        <Timeline
          items={records}
          viewport={timelineViewport(settings)}
          scale={settings.scale}
          today="2026-01-12"
          queryKey="pm-project-timeline"
          getScrollPosition={() => state.scroll}
          onScrollPosition={(position) =>
            setState((previous) => ({ ...previous, scroll: position }))
          }
          selectedIds={state.activeId ? [state.activeId] : []}
          activeId={state.activeId}
          onEdit={(item) =>
            setState((previous) => ({ ...previous, activeId: item.id }))
          }
          sidebarHeader={
            <span className={styles.timelineSidebar}>
              <span>{en ? "Issues" : "Issue"}</span>
              <span>{en ? "Duration" : "工期"}</span>
            </span>
          }
          renderSidebar={(item) => (
            <span className={styles.timelineSidebar}>
              <span title={item.label}>{item.label}</span>
              <span>
                {item.startDate && item.dueDate
                  ? Math.round(
                      (Date.parse(item.dueDate + "T00:00:00Z") -
                        Date.parse(item.startDate + "T00:00:00Z")) /
                        86400000,
                    ) + 1
                  : "—"}
                {en ? " days" : " 天"}
              </span>
            </span>
          )}
        />
      ) : (
        <p className={styles.muted} data-pm-timeline-empty>
          {en
            ? "No issue in this project has both a start and due date."
            : "本项目没有同时具备开始与截止日期的 Issue。"}
        </p>
      )}
      {unscheduled.length > 0 && (
        <section className={styles.unscheduled} data-pm-unscheduled>
          <strong>
            {en ? "Unscheduled issues" : "未排期的 Issue"} ·{" "}
            {unscheduled.length}
          </strong>
          <ul className={styles.bullets}>
            {unscheduled.map((issue) => (
              <li key={issue.id}>
                {issue.identifier} {issueRecord(issue, locale).title} —{" "}
                {!issue.startDate && !issue.dueDate
                  ? en
                    ? "no dates recorded"
                    : "未记录日期"
                  : !issue.startDate
                    ? en
                      ? "missing start date"
                      : "缺少开始日期"
                    : en
                      ? "missing due date"
                      : "缺少截止日期"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function ProjectActivityPanel({
  projectId,
  family,
  issues,
  activity,
}: {
  projectId: string
  family: ProjectsFamily
  issues: PmIssue[]
  activity: readonly {
    id: string
    itemId: string
    at: string
    description: Copy
  }[]
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const projectIssues = issues.filter((issue) => issue.projectId === projectId)
  const ownIds = new Set(projectIssues.map((issue) => issue.id))
  const issueById = new Map(projectIssues.map((issue) => [issue.id, issue]))
  const records = [
    ...family.activity
      .filter((entry) => entry.projectId === projectId)
      .map((entry) => ({
        at: entry.at,
        id: entry.id,
        agent:
          pmMembers.find((member) => member.id === entry.actorId)?.name ??
          (en ? "System" : "系统"),
        action: entry.title[locale],
        detail: entry.detail?.[locale],
      })),
    ...activity
      .filter((entry) => ownIds.has(entry.itemId))
      .map((entry) => {
        const issue = issueById.get(entry.itemId)
        return {
          at: entry.at,
          id: entry.id,
          agent: issue
            ? pmMembers.find((m) => m.id === issue.assigneeIds[0])?.name
            : undefined,
          action: entry.description[locale],
          detail: issue ? issueRecord(issue, locale).title : undefined,
        }
      }),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const events = records.map((record) => ({
    ...record,
    time: formatProjectInstant(record.at, locale),
  }))
  return (
    <section className={workspaceStyles.activity} data-pm-activity-panel>
      {events.length > 0 ? (
        <ol className={workspaceStyles.activityList}>
          {events.map((event, index) => (
            <li key={event.id} className={workspaceStyles.activityItem} data-latest={index === 0 || undefined}>
              <span className={workspaceStyles.activityDot} aria-hidden="true" />
              <div className={workspaceStyles.activityHeading}>
                <strong>{event.action}</strong>
                <time dateTime={event.at}>{event.time}</time>
              </div>
              {(event.detail || event.agent) && <p>{event.detail ?? event.agent}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.muted}>{en ? "No activity recorded for this project." : "本项目尚无动态记录。"}</p>
      )}
    </section>
  )
}

export function ProjectDependenciesPanel({
  projectId,
  family,
  issues,
}: {
  projectId: string
  family: ProjectsFamily
  issues: PmIssue[]
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const { navigate } = usePmNavigation()
  const [state, setState] = usePmScenarioState("dependencies-state", () => ({
    selection: { nodeIds: [], edgeIds: [] } as CanvasSelection,
    viewport: null as { x: number; y: number; zoom: number } | null,
    attempt: 0,
  }))
  const seeds = projectDependencies(family, projectId)
  const graph = validateProjectDependencies(seeds, issues, projectId)
  const issueById = new Map(issues.map((issue) => [issue.id, issue]))
  const refs = [
    ...new Map(
      graph.edges
        .flatMap((edge) => [edge.from, edge.to])
        .map((ref) => [analyticsEntityKey(ref), ref]),
    ).values(),
  ]
  const refByKey = new Map<string, AnalyticsEntityRef>(
    refs.map((ref) => [analyticsEntityKey(ref), ref]),
  )
  const definitions: CanvasNodeDefinition[] = [
    {
      type: "work",
      label: en ? "Work item" : "工作项",
      category: "work",
      defaults: {},
      ports: [
        { id: "in", label: "in", direction: "input", type: "object" },
        { id: "out", label: "out", direction: "output", type: "object" },
      ],
    },
  ]
  const renderDependencyNode: NonNullable<
    WorkflowCanvasProps["renderNode"]
  > = ({ node, selected, definition }) => {
    const issue = issueById.get(refByKey.get(node.id)?.entityId ?? "")
    const member = issue
      ? pmMembers.find((candidate) => candidate.id === issue.assigneeIds[0])
      : undefined
    return (
      <div
        className={styles.dependencyNode}
        data-canvas-node={node.id}
        data-selected={selected || undefined}
      >
        <div className={styles.dependencyNodeHeader}>
          <span
            className={styles.dependencyDot}
            data-state={issue?.stateId}
            aria-hidden="true"
          />
          <strong className={styles.dependencyNodeTitle} title={node.title}>
            {node.title}
          </strong>
        </div>
        <div className={styles.dependencyNodeFooter}>
          {member ? (
            <PmMemberIdentity member={member} />
          ) : (
            <span>
              {issue
                ? en
                  ? "No owner"
                  : "无负责人"
                : en
                  ? "Owner unavailable"
                  : "负责人未知"}
            </span>
          )}
          <span>
            {issue
              ? taskLabels(issue, locale).state
              : en
                ? "Unknown reference"
                : "未知引用"}
          </span>
          {issue?.dueDate && (
            <time dateTime={issue.dueDate}>
              {formatProjectDay(issue.dueDate, locale)}
            </time>
          )}
        </div>
        {definition?.ports.map((port) => (
          <CanvasPort key={port.id} port={port} readOnly />
        ))}
      </div>
    )
  }
  const doc: CanvasDocument = {
    schemaVersion: 1,
    id: `pm-project-dependencies-${projectId}`,
    revision: 0,
    frames: [],
    notes: [],
    viewport: state.viewport ?? undefined,
    nodes: refs.map((ref, index) => {
      const issue = issueById.get(ref.entityId)
      return {
        id: analyticsEntityKey(ref),
        type: "work",
        title: issue
          ? `${issue.identifier} ${issueRecord(issue, locale).title}`
          : ref.entityId,
        position: { x: (index % 3) * 300, y: Math.floor(index / 3) * 120 },
        config: {},
      }
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: analyticsEntityKey(edge.from),
      sourcePort: "out",
      target: analyticsEntityKey(edge.to),
      targetPort: "in",
    })),
  }
  const selectedRef = state.selection.nodeIds[0]
    ? refByKey.get(state.selection.nodeIds[0])
    : undefined
  const inspected = selectedRef
    ? issueById.get(selectedRef.entityId)
    : undefined
  if (seeds.length === 0)
    return (
      <Empty
        title={en ? "No dependencies recorded" : "未记录依赖"}
        description={
          en
            ? "This project has no dependency entries in the local family fixture."
            : "本项目在本地族固定数据中没有依赖条目。"
        }
      />
    )
  if (graph.edges.length === 0)
    return (
      <div data-pm-dependency-graph="unavailable">
        <Alert tone="warning">
          <AlertTitle headingLevel={2}>
            {en ? "Dependency graph unavailable" : "依赖图不可用"}
          </AlertTitle>
          <AlertDescription>
            {en
              ? "Every recorded dependency points at an issue id that does not exist in the shared issue domain."
              : "所有已记录依赖指向的 Issue ID 在共享 Issue 域中不存在。"}
          </AlertDescription>
        </Alert>
        <ul className={styles.bullets} data-pm-unresolved-deps>
          {graph.unresolved.map((item) => (
            <li key={item.id}>
              {item.id}: {item.fromId} → {item.toId} (
              {item.reason === "missing-from"
                ? en
                  ? "source missing"
                  : "来源缺失"
                : en
                  ? "target missing"
                  : "目标缺失"}
              )
            </li>
          ))}
        </ul>
      </div>
    )
  return (
    <div className={styles.panelStack} data-pm-dependency-graph>
      <div className={styles.depsLayout}>
        <div>
          <div className={styles.graphBox}>
            <CanvasLoadBoundary
              title={
                en
                  ? "The dependency canvas failed to load."
                  : "依赖画布加载失败。"
              }
              retryLabel={en ? "Retry" : "重试"}
              onRetry={() => {
                WorkflowCanvas = lazy(importWorkflowCanvas)
                setState((previous) => ({
                  ...previous,
                  attempt: previous.attempt + 1,
                }))
              }}
            >
              <Suspense
                fallback={
                  <p className={styles.graphFallback}>
                    {en ? "Loading dependency canvas..." : "正在加载依赖画布…"}
                  </p>
                }
              >
                <WorkflowCanvas
                  key={state.attempt}
                  document={doc}
                  definitions={definitions}
                  selection={state.selection}
                  onSelectionChange={(selection) =>
                    setState((previous) => ({ ...previous, selection }))
                  }
                  onViewportChange={(viewport) =>
                    setState((previous) => ({ ...previous, viewport }))
                  }
                  viewport={state.viewport ?? undefined}
                  renderNode={renderDependencyNode}
                  showMiniMap={false}
                  controlsVariant="minimal-vertical"
                  fitViewOptions={{ maxZoom: 1 }}
                  onOpenNode={(id) => {
                    const ref = refByKey.get(id)
                    if (ref && issueById.has(ref.entityId))
                      navigate("issue-detail-1", ref.entityId)
                  }}
                  readOnly
                />
              </Suspense>
            </CanvasLoadBoundary>
          </div>
          <div className={styles.legend} data-pm-dependency-legend>
            <Badge tone="success" size="sm">
              {en ? "Satisfied" : "已满足"}
            </Badge>
            <Badge tone="danger" size="sm">
              {en ? "Blocked" : "受阻"}
            </Badge>
            <Badge tone="warning" size="sm">
              {en ? "Unknown" : "未知"}
            </Badge>
            <Badge size="sm">
              {en ? "Unresolved reference" : "未解析引用"}
            </Badge>
          </div>
        </div>
        <aside
          className={styles.inspector}
          aria-label={en ? "Dependency selection inspector" : "依赖选择检查器"}
          data-pm-dependency-inspector
        >
          <strong className={styles.filterLabel}>
            {en ? "Selection inspector" : "选择检查器"}
          </strong>
          {inspected ? (
            <>
              <span className={styles.inspectorField}>
                <span className={styles.inspectorLabel}>
                  {en ? "Issue" : "Issue"}
                </span>
                {inspected.identifier} {issueRecord(inspected, locale).title}
              </span>
              <span className={styles.inspectorField}>
                <span className={styles.inspectorLabel}>
                  {en ? "Status" : "状态"}
                </span>
                {taskLabels(inspected, locale).state}
              </span>
              <span className={styles.inspectorField}>
                <span className={styles.inspectorLabel}>
                  {en ? "Assignee" : "负责人"}
                </span>
                {taskLabels(inspected, locale).assignee}
              </span>
              <span className={styles.inspectorField}>
                <span className={styles.inspectorLabel}>
                  {en ? "Dates" : "日期"}
                </span>
                {inspected.startDate ?? "—"} → {inspected.dueDate ?? "—"}
              </span>
            </>
          ) : (
            <p className={styles.muted}>
              {en
                ? "Select a node or row to inspect the referenced issue."
                : "选择节点或行以查看引用的 Issue。"}
            </p>
          )}
        </aside>
      </div>
      {graph.cycleCount > 0 && (
        <Alert tone="warning" data-pm-dependency-cycles>
          <AlertTitle headingLevel={2}>
            {en
              ? `${graph.cycleCount} dependency cycle(s) detected`
              : `检测到 ${graph.cycleCount} 个依赖环`}
          </AlertTitle>
          <AlertDescription>
            {en
              ? "Cyclic edges stay visible; delivery order cannot be inferred from them."
              : "环上的连线仍然显示；无法据此推断交付顺序。"}
          </AlertDescription>
        </Alert>
      )}
      <TableContainer>
        <Table data-pm-dependency-table>
          <TableHeader>
            <tr>
              <TableHead>{en ? "Source" : "来源"}</TableHead>
              <TableHead>{en ? "Target" : "目标"}</TableHead>
              <TableHead>{en ? "State" : "状态"}</TableHead>
              <TableHead>{en ? "Evidence" : "依据"}</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {graph.edges.map((edge) => (
              <TableRow
                key={edge.id}
                data-pm-dependency-edge={edge.id}
                data-selected={
                  state.selection.edgeIds.includes(edge.id) || undefined
                }
                onClick={() =>
                  setState((previous) => ({
                    ...previous,
                    selection: {
                      nodeIds: [analyticsEntityKey(edge.to)],
                      edgeIds: [edge.id],
                    },
                  }))
                }
              >
                <TableCell>{edge.from.entityId}</TableCell>
                <TableCell>{edge.to.entityId}</TableCell>
                <TableCell>
                  <Badge
                    size="sm"
                    tone={
                      edge.state === "satisfied"
                        ? "success"
                        : edge.state === "blocked"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {edge.state === "satisfied"
                      ? en
                        ? "Satisfied"
                        : "已满足"
                      : edge.state === "blocked"
                        ? en
                          ? "Blocked"
                          : "受阻"
                        : en
                          ? "Unknown"
                          : "未知"}
                  </Badge>
                </TableCell>
                <TableCell>{edge.evidence}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {graph.unresolved.length > 0 && (
        <Alert
          tone="warning"
          className={styles.unresolved}
          data-pm-unresolved-deps
        >
          <AlertTitle headingLevel={2}>
            {en ? "Unresolved dependency references" : "未解析的依赖引用"}
          </AlertTitle>
          <AlertDescription>
            <ul className={styles.bullets}>
              {graph.unresolved.map((item) => (
                <li key={item.id}>
                  {item.id}: {item.fromId} → {item.toId} (
                  {item.reason === "missing-from"
                    ? en
                      ? "source missing from the shared issue domain"
                      : "来源不在共享 Issue 域中"
                    : en
                      ? "target missing from the shared issue domain"
                      : "目标不在共享 Issue 域中"}
                  )
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

export function ProjectDetailRail({
  project,
  family,
  issues,
  onOpenComments,
  variant = "workspace",
}: {
  project: ProjectCardRecord
  stats: ProjectIssueStats
  family: ProjectsFamily
  issues: PmIssue[]
  onOpenComments?: () => void
  variant?: "brief" | "workspace"
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const { navigate } = usePmNavigation()
  const backlog = issues.filter((issue) => issue.stateId === "backlog")
  const owner = pmMembers.find((member) => member.id === project.ownerId)
  const overview = projectOverview(family, project.id)
  const startDates = issues
    .filter((issue) => issue.startDate)
    .map((issue) => issue.startDate as string)
    .sort()
  const start = startDates[0] ?? null
  return (
    <div className={`${styles.rail} ${variant === "workspace" ? workspaceStyles.rail : ""}`} data-pm-detail-rail data-pm-rail-variant={variant}>
      {variant === "workspace" && (
        <section className={styles.railSection} data-pm-project-backlog>
          <h2 className={styles.railTitle}>
            <span className={workspaceStyles.railHeading}><ClipboardList aria-hidden="true" />{en ? "Backlog" : "待办池"}</span>
            <Badge size="sm">{backlog.length}</Badge>
          </h2>
          {backlog.length ? (
            <ul className={styles.backlogList}>
              {backlog.map((issue) => (
                <li key={issue.id}>
                  <Button
                    variant="ghost"
                    onClick={() => navigate("issue-detail-1", issue.id)}
                  >
                    <GripVertical className={workspaceStyles.backlogGrip} aria-hidden="true" />
                    <span>{issueRecord(issue, locale).title}</span>
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>
              {en
                ? "No backlog issues in the current shared snapshot."
                : "当前共享快照没有待办池 Issue。"}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("issue-list-1", project.id)}
          >
            {en ? "View full backlog" : "查看全部待办"}
            <ChevronRight aria-hidden="true" />
          </Button>
        </section>
      )}
      <section className={styles.railSection}>
        <h2 className={styles.railTitle}>
          <span className={workspaceStyles.railHeading}><Users aria-hidden="true" />{en ? "Contributors" : "贡献者"}</span>
          <Badge size="sm">{project.teamSize}</Badge>
        </h2>
        {owner ? (
          <PmMemberIdentity member={owner} detail />
        ) : (
          <span className={styles.muted}>
            {en ? "No owner assigned" : "未分配负责人"}
          </span>
        )}
        <p className={styles.muted}>
          {en
            ? `+ ${Math.max(project.teamSize - 1, 0)} teammates; the roster is not part of the local fixture.`
            : `+ ${Math.max(project.teamSize - 1, 0)} 名成员；名单不属于本地固定数据。`}
        </p>
        {variant === "workspace" && <Button variant="outline" size="sm" onClick={() => navigate("member-list-1")}>
          {en ? "View contributors" : "查看贡献者"}<ChevronRight aria-hidden="true" />
        </Button>}
      </section>
      <section className={styles.railSection}>
        <h2 className={styles.railTitle}>
          <span className={workspaceStyles.railHeading}><Clock3 aria-hidden="true" />{variant === "brief" ? en ? "Schedule" : "排期" : en ? "Time" : "时间"}</span>
        </h2>
        <p className={styles.railRow}>
          <span>{en ? "Start date" : "开始日期"}</span>
          <span className={styles.railValue}>
            {start
              ? formatProjectDay(start, locale, {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              : en
                ? "No start date yet"
                : "尚无开始日期"}
          </span>
        </p>
        <p className={styles.railRow}>
          <span>{en ? "Target date" : "目标日期"}</span>
          <span className={styles.railValue}>
            {project.dueDate
              ? formatProjectDay(project.dueDate, locale, {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              : en
                ? "No target date"
                : "无目标日期"}
          </span>
        </p>
        <p className={styles.railRow}>
          <span>{en ? "Last updated" : "最近更新"}</span>
          <span className={styles.railValue}>
            {formatProjectInstant(project.updatedAt, locale)}
          </span>
        </p>
      </section>
      <section className={styles.railSection}>
        <h2 className={styles.railTitle}><span className={workspaceStyles.railHeading}><FileText aria-hidden="true" />{en ? "Notes" : "备注"}</span></h2>
        <p className={styles.brief}>
          {overview
            ? overview.healthNote[locale]
            : en
              ? "No overview note recorded."
              : "未记录概览备注。"}
        </p>
        {onOpenComments && (
          <Button variant="outline" size="sm" onClick={onOpenComments}>
            {en ? "Open comments" : "打开评论"}
          </Button>
        )}
      </section>
    </div>
  )
}
