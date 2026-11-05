import { useCallback, useEffect, useMemo, useState } from "react"
import { Handle, Position } from "@xyflow/react"
import { AlertTriangle, ArrowUpRight, CalendarDays, ChevronDown, Download, Filter, FolderKanban, ListTodo, Network, SlidersHorizontal } from "lucide-react"
import type { Entity } from "@contracts"
import { DataTable } from "@/components/blocks/data-table"
import { FilterCard } from "@/components/blocks/filter-card"
import type { FilterCondition, FilterField } from "@/lib/filter-model"
import { WorkflowCanvas, type CanvasContextMenuTarget } from "@/components/blocks/workflow-canvas"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { CanvasNodeProps } from "@/components/ui/canvas-node"
import { Checkbox } from "@/components/ui/checkbox"
import { CountUp } from "@/components/ui/count-up"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { layoutCanvasDAG } from "@/lib/canvas-layout"
import type { CanvasDocument, CanvasEdgeRecord, CanvasNodeDefinition, CanvasSelection } from "@/lib/canvas-model"
import { useI18n } from "@/lib/i18n-provider"
import { DashboardView } from "@/views/pm/dashboard"
import { DashboardNavigation } from "@/views/pm/dashboard-navigation"
import { PmSearch } from "@/views/pm/presentation-page"
import d4 from "@/views/pm/dashboard-4.module.css"
import { allowed, QueryNotice, string, strings, writable } from "./pm-ui"
import type { DependencyEditorTarget, ServiceDashboardProps } from "./service-dashboard-contract"
import { usePlanningDashboard, usePmCommand, usePmService } from "./pm-service"
import { CriticalPathPanel, MilestoneReschedule, ProjectDependenciesPanel } from "./dashboard-planning"
import { PortfolioHealth } from "./dashboard-portfolio"
import { SprintPlanner } from "./dashboard-sprints"
import styles from "./service-dashboard-4.module.css"
import { ContextMenuItem, ContextMenuLabel, ContextMenuPopup, useContextMenu } from "@/components/ui/context-menu"

type StateGroup = "planned" | "working" | "done" | "other"
type DependencyFacts = { notDone: number; unknownState: number; unavailable: number; manual: number }
type LayoutSnapshot = { source: CanvasDocument; document: CanvasDocument; grid: boolean }

const fitViewOptions = { padding: 0.2, maxZoom: 0.85 }
const stateColors: Record<StateGroup, string> = {
  planned: "#a1a1aa", working: "#3b82f6", done: "#10b981", other: "#a78bfa",
}
const stateGroups: StateGroup[] = ["planned", "working", "done", "other"]
const itemTitle = (item: Entity): string => string(item.data.title) || item.id
const stateGroup = (item: Entity): StateGroup => {
  const status = string(item.data.status)
  return status === "done" ? "done" : status === "in_progress" || status === "in_review" ? "working" : status === "draft" || status === "ready" ? "planned" : "other"
}
const dueBucket = (value: string, today: string): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return "none"
  if (value < today) return "overdue"
  return value <= new Date(Date.parse(today) + 6 * 86_400_000).toISOString().slice(0, 10) ? "week" : "later"
}
/** Unknown fields yield `null` so a mode that cannot evaluate a field leaves rows untouched. */
const workItemValues = (item: Entity, field: string, today: string): string[] | null => {
  switch (field) {
    case "status": return [string(item.data.status) || "unspecified"]
    case "priority": return [string(item.data.priority) || "unspecified"]
    case "assignee": return [string(item.data.assigneeId) || "unassigned"]
    case "project": return item.projectId ? [item.projectId] : []
    case "due": return [dueBucket(string(item.data.dueDate), today)]
    default: return null
  }
}
const projectValues = (id: string, field: string, projectById: Map<string, Entity>, today: string): string[] | null => {
  switch (field) {
    case "status": return [string(projectById.get(id)?.data.status) || "unspecified"]
    case "project": return [id]
    case "due": return [dueBucket(string(projectById.get(id)?.data.dueDate), today)]
    default: return null
  }
}
const conditionMatches = (condition: FilterCondition, values: readonly string[] | null): boolean => {
  if (!condition.values.length || values === null) return true
  const hit = values.some(value => condition.values.includes(value))
  return condition.operator === "is" ? hit : !hit
}

/** Project dependencies and task prerequisites remain separate authoritative graphs. */
export function ServiceDashboard4({ surface, projects, issues, members, openEntity, openActivity, renderDependencyEditor }: ServiceDashboardProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const text = useCallback((zh: string, english: string): string => en ? english : zh, [en])
  const planning = usePlanningDashboard()
  const [graphMode, setGraphMode] = useState<"projects" | "work_items">("projects")
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const today = surface.readModel.today
  const [showRail, setShowRail] = useState(true)
  const [selection, setSelection] = useState<CanvasSelection>({ nodeIds: [], edgeIds: [] })
  const [layout, setLayout] = useState<LayoutSnapshot | null>(null)
  const { workspace } = usePmService()
  const command = usePmCommand()
  const [dependencyOpen, setDependencyOpen] = useState(false)
  const [dependencyTarget, setDependencyTarget] = useState<DependencyEditorTarget>()
  const contextMenu = useContextMenu<{ kind: "node"; item: Entity } | { kind: "edge"; item: Entity; prerequisite: Entity }>()
  const projectById = useMemo(() => new Map((projects.data ?? []).filter(project => project.kind === "project").map(project => [project.id, project])), [projects.data])
  const available = projects.data !== undefined && issues.data !== undefined
  const items = useMemo(() => available ? (issues.data ?? []).filter(item => item.kind === "work_item" && item.projectId !== null && projectById.has(item.projectId)) : [], [available, issues.data, projectById])
  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items])
  const facts = useMemo(() => new Map(items.map(item => {
    const detail: DependencyFacts = { notDone: 0, unknownState: 0, unavailable: 0, manual: strings(item.data.manualBlockReasons).length }
    for (const id of new Set(strings(item.data.prerequisiteIds))) {
      const prerequisite = byId.get(id)
      if (!prerequisite || prerequisite.projectId !== item.projectId) detail.unavailable += 1
      else if (!string(prerequisite.data.status)) detail.unknownState += 1
      else if (prerequisite.data.status !== "done") detail.notDone += 1
    }
    return [item.id, detail] as const
  })), [items, byId])
  const query = surface.interaction.query
  const setQuery = (value: string): void => surface.actions.setInteraction(previous => ({ ...previous, query: value }))
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase(locale)
    return items.filter(item => conditions.every(condition => conditionMatches(condition, workItemValues(item, condition.field, today))) &&
      `${item.id} ${itemTitle(item)} ${string(projectById.get(item.projectId!)?.data.name)}`.toLocaleLowerCase(locale).includes(search))
  }, [items, conditions, query, locale, projectById, today])
  const projectRows = planning.data?.projects.filter(project => conditions.every(condition => conditionMatches(condition, projectValues(project.id, condition.field, projectById, today))) && (!query.trim() || `${project.id} ${project.title}`.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))))
  const visibleProjectIds = new Set(projectRows?.map(project => project.id))
  const selectedProjectId = surface.interaction.selectedProjectId
  const activeProjectId = selectedProjectId && visibleProjectIds.has(selectedProjectId) ? selectedProjectId : projectRows?.[0]?.id
  const selectProject = (id: string) => surface.actions.setInteraction(previous => ({ ...previous, selectedProjectId: id }))
  const scope = useMemo(() => new Set(rows.map(item => item.id)), [rows])
  const edges = useMemo<CanvasEdgeRecord[]>(() => rows.flatMap(item => [...new Set(strings(item.data.prerequisiteIds))].flatMap(prerequisiteId => {
    const prerequisite = byId.get(prerequisiteId)
    return prerequisite && prerequisite.projectId === item.projectId && scope.has(prerequisiteId)
      ? [{ id: JSON.stringify([prerequisiteId, item.id]), source: prerequisiteId, sourcePort: "dependent", target: item.id, targetPort: "prerequisite" }]
      : []
  })), [rows, byId, scope])
  const definitions = useMemo<CanvasNodeDefinition[]>(() => [{
    type: "service-work-item", label: text("工作项", "Work item"), category: text("项目交付", "Project delivery"), defaults: {},
    ports: [
      { id: "prerequisite", label: text("前置工作项", "Prerequisite"), direction: "input", type: "object" },
      { id: "dependent", label: text("依赖工作项", "Dependent"), direction: "output", type: "object" },
    ],
  }], [text])
  const document = useMemo<CanvasDocument>(() => ({
    schemaVersion: 1, id: "authorized-work-item-dependencies", revision: 0,
    nodes: rows.map((item, index) => ({ id: item.id, type: "service-work-item", title: itemTitle(item), position: { x: index % 3 * 336, y: Math.floor(index / 3) * 180 }, config: {} })),
    edges, frames: [], notes: [],
  }), [rows, edges])

  useEffect(() => {
    if (graphMode !== "work_items") return
    const controller = new AbortController()
    void layoutCanvasDAG(document, definitions, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setLayout({ source: document, document: result.ok ? { ...document, nodes: document.nodes.map(node => ({ ...node, position: result.positions[node.id] })) } : document, grid: !result.ok })
    }).catch(() => {
      if (!controller.signal.aborted) setLayout({ source: document, document, grid: true })
    })
    return () => controller.abort()
  }, [document, definitions, graphMode])
  useEffect(() => {
    const edgeIds = new Set(edges.map(edge => edge.id))
    setSelection(previous => previous.nodeIds.every(id => scope.has(id)) && previous.edgeIds.every(id => edgeIds.has(id)) ? previous : {
      nodeIds: previous.nodeIds.filter(id => scope.has(id)), edgeIds: previous.edgeIds.filter(id => edgeIds.has(id)),
    })
  }, [scope, edges])

  const currentSelection: CanvasSelection = { nodeIds: selection.nodeIds.filter(id => scope.has(id)), edgeIds: selection.edgeIds.filter(id => edges.some(edge => edge.id === id)) }
  const selectedEdge = edges.find(edge => edge.id === currentSelection.edgeIds[0])
  const selected = byId.get(currentSelection.nodeIds[0] ?? selectedEdge?.target ?? "")
  const distribution = useMemo(() => {
    const counts: Record<StateGroup, number> = { planned: 0, working: 0, done: 0, other: 0 }
    for (const item of rows) counts[stateGroup(item)] += 1
    return counts
  }, [rows])
  const statusOptions = useMemo(() => [...new Set((graphMode === "projects" ? [...projectById.values()] : items).map(item => string(item.data.status) || "unspecified"))].sort(), [graphMode, items, projectById])
  const attention = rows.filter(item => {
    const detail = facts.get(item.id)!
    return detail.notDone > 0 || detail.unknownState > 0 || detail.unavailable > 0 || detail.manual > 0
  })
  const unavailableCount = rows.reduce((total, item) => total + facts.get(item.id)!.unavailable, 0)
  const groupLabel = (group: StateGroup): string => ({
    planned: text("草稿 / 就绪", "Draft / ready"), working: text("进行中 / 审核中", "In progress / review"), done: text("已完成", "Done"), other: text("取消 / 其他", "Cancelled / other"),
  })[group]
  const statusLabel = useCallback((status: string): string => {
    const labels: Record<string, string> = {
      draft: text("草稿", "Draft"), ready: text("就绪", "Ready"), in_progress: text("进行中", "In progress"), in_review: text("审核中", "In review"), done: text("已完成", "Done"), cancelled: text("已取消", "Cancelled"), unspecified: text("未提供状态", "State not provided"),
    }
    return labels[status] ?? status
  }, [text])
  const priorityLabel = useCallback((priority: string): string => {
    const labels: Record<string, string> = {
      low: text("低", "Low"), normal: text("普通", "Normal"), high: text("高", "High"), urgent: text("紧急", "Urgent"), unspecified: text("未提供优先级", "Priority not provided"),
    }
    return labels[priority] ?? priority
  }, [text])
  const activeConditionCount = conditions.filter(condition => condition.values.length > 0).length
  const filterFields = useMemo<FilterField[]>(() => {
    const priorities = [...new Set(items.map(item => string(item.data.priority) || "unspecified"))].sort()
    const assignees = [...(members.data ?? []).filter(member => !member.revokedAt).map(member => ({ value: member.userId, label: member.name })), { value: "unassigned", label: text("未分配", "Unassigned") }]
    const fields: FilterField[] = [
      { id: "status", label: text("状态", "State"), options: statusOptions.map(status => ({ value: status, label: statusLabel(status) })) },
      ...(graphMode === "work_items" ? [
        { id: "priority", label: text("优先级", "Priority"), options: priorities.map(priority => ({ value: priority, label: priorityLabel(priority) })) },
        { id: "assignee", label: text("负责人", "Assignee"), options: assignees },
      ] : []),
      { id: "project", label: text("项目", "Project"), options: [...projectById.values()].map(project => ({ value: project.id, label: string(project.data.name) || project.id })) },
      { id: "due", label: text("截止日期", "Due date"), options: [
        { value: "overdue", label: text("已逾期", "Overdue") },
        { value: "week", label: text("未来 7 天", "Next 7 days") },
        { value: "later", label: text("7 天后", "Later than 7 days") },
        { value: "none", label: text("未排期", "Unscheduled") },
      ] },
    ]
    return fields
  }, [graphMode, items, members.data, projectById, statusLabel, statusOptions, priorityLabel, text])
  const switchGraphMode = (mode: "projects" | "work_items"): void => {
    setGraphMode(mode)
    setConditions(previous => previous.filter(condition => condition.field !== "status" && (mode === "work_items" || condition.field === "project" || condition.field === "due")))
  }
  const renderNode = useCallback(({ node, definition, selected: isSelected }: CanvasNodeProps) => {
    const item = byId.get(node.id)
    if (!item) return null
    const group = stateGroup(item)
    const detail = facts.get(item.id)!
    return <div className={`${d4.node} ${styles.workNode}`} data-canvas-node={node.id} data-selected={isSelected || undefined} data-state-group={group}>
      <p className={d4.nodeTitle} title={itemTitle(item)}>{itemTitle(item)}</p>
      <p className={d4.nodeSummary} title={string(projectById.get(item.projectId!)?.data.name)}>{text("工作项", "Work item")} · {string(projectById.get(item.projectId!)?.data.name) || text("已授权项目", "Authorized project")}</p>
      <div className={d4.nodeFooter}><span className={d4.bandLabel}><span className={d4.bandDot} style={{ background: stateColors[group] }} aria-hidden="true" />{statusLabel(string(item.data.status) || "unspecified")}</span><span>{strings(item.data.prerequisiteIds).length} {text("前置项", "prerequisites")}</span></div>
      {(detail.unavailable > 0 || detail.unknownState > 0 || detail.manual > 0 || detail.notDone > 0) && <span className={d4.nodeIssue} title={text("存在未完成前置项、手动阻塞或不可用信息；请查看关注面板。", "Unfinished prerequisites, manual blockers or unavailable information; see Needs attention.")}><AlertTriangle size={12} aria-hidden="true" /></span>}
      <div className={d4.ports}>{definition?.ports.map(port => <Handle key={port.id} id={port.id} type={port.direction === "input" ? "target" : "source"} position={port.direction === "input" ? Position.Top : Position.Right} isConnectable={false} />)}</div>
    </div>
  }, [byId, facts, projectById, text, statusLabel])
  function openCanvasMenu(target: CanvasContextMenuTarget) {
    if (target.kind === "node" && target.id && scope.has(target.id)) {
      const item = byId.get(target.id)
      if (!item) return false
      contextMenu.openAt({ x: target.x, y: target.y }, { kind: "node", item }, target.trigger)
      return true
    }
    const edge = target.kind === "edge" ? edges.find(edge => edge.id === target.id) : undefined
    const item = edge ? byId.get(edge.target) : undefined
    const prerequisite = edge ? byId.get(edge.source) : undefined
    if (!item || !prerequisite) return false
    contextMenu.openAt({ x: target.x, y: target.y }, { kind: "edge", item, prerequisite }, target.trigger)
    return true
  }
  function openDependencies(item: Entity, prerequisite?: Entity) {
    setDependencyTarget({ itemId: item.id, ...(prerequisite ? { prerequisiteId: prerequisite.id } : {}) })
    setShowRail(true)
    setDependencyOpen(true)
  }
  const menuItem = contextMenu.target && scope.has(contextMenu.target.item.id) ? byId.get(contextMenu.target.item.id) : undefined
  const menuEditable = !!menuItem && writable(menuItem) && allowed(workspace, "planning.edit", menuItem.projectId) && !command.pending && !command.unknownCommand

  function exportSnapshot(): void {
    if (graphMode === "projects" ? !planning.data : !available) return
    const snapshot = graphMode === "projects" ? {
      source: "Authorized formal project dependencies; current search and filter conditions",
      exportedAt: new Date().toISOString(),
      mayBeStale: !!planning.error || planning.isFetching,
      projects: projectRows?.map(project => ({ id: project.id, title: project.title, version: project.version })),
      dependencies: projectRows?.flatMap(project => project.dependsOn.filter(id => visibleProjectIds.has(id)).map(id => ({ prerequisiteProjectId: id, dependentProjectId: project.id }))),
      limitations: "Only project dependency endpoints in the authorized filtered snapshot are exported. Hidden identifiers and derived task critical paths are omitted.",
    } : {
      source: "Authorized service work-item snapshots; current search and filter conditions",
      exportedAt: new Date().toISOString(),
      mayBeStale: !!projects.error || !!issues.error || projects.isFetching || issues.isFetching,
      workItems: rows.map(item => ({ id: item.id, title: itemTitle(item), status: string(item.data.status) || null, projectId: item.projectId, projectName: string(projectById.get(item.projectId!)?.data.name) || null, dueDate: string(item.data.dueDate) || null, version: item.version })),
      dependencies: edges.map(edge => ({ prerequisiteId: edge.source, dependentId: edge.target })),
      unavailablePrerequisiteCount: unavailableCount,
      limitations: "Only same-project task links with both endpoints in the authorized, filtered snapshot are exported. Unavailable identifiers are omitted. Project dependencies and critical-path analysis are separate views.",
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }))
    const link = window.document.createElement("a")
    link.href = url
    link.download = graphMode === "projects" ? "authorized-project-dependencies.json" : "authorized-work-item-dependencies.json"
    link.click()
    URL.revokeObjectURL(url)
  }
  const readNotices = <div className={styles.readNotices}><QueryNotice query={projects} /><QueryNotice query={issues} />{(projects.isFetching && projects.data || issues.isFetching && issues.data) && <p role="status">{text("正在刷新；保留上次授权快照。", "Refreshing; the previous authorized snapshot is retained.")}</p>}</div>
  let ringOffset = 0

  return <><DashboardView {...surface}
    variant="dashboard4"
    navigation={<DashboardNavigation query={query} onQueryChange={setQuery} onPeople={surface.actions.openPeople} onActivity={openActivity} breadcrumb={<><span>{text("项目", "Projects")}</span><span aria-hidden="true">/</span><strong>{text("项目交付", "Project Delivery")}</strong></>} />}
    readModel={{ ...surface.readModel, title: graphMode === "projects" ? text("项目依赖地图", "Project Dependency Map") : text("工作项依赖地图", "Work-item Dependency Map"), description: text("项目依赖、任务前置关系和关键路径分别依据正式记录；健康评估不从任务完成率推算。", "Project dependencies, task prerequisites and critical paths use their own recorded facts. Health is not inferred from task completion."),
      // This outer region owns composition, while each card retains its source query state.
      data: { state: available ? "success" : "partial", partialDescription: text("各面板单独显示服务读取状态；未提供的数据不计为零。", "Each panel retains its service read state; unavailable data is not counted as zero.") },
    }}
    headerActions={<div className={d4.actions}>
      <Button variant={graphMode === "projects" ? "secondary" : "outline"} aria-pressed={graphMode === "projects"} onClick={() => switchGraphMode("projects")}>{text("项目依赖", "Project dependencies")}</Button>
      <Button variant={graphMode === "work_items" ? "secondary" : "outline"} aria-pressed={graphMode === "work_items"} onClick={() => switchGraphMode("work_items")}>{text("任务依赖", "Task prerequisites")}</Button>
      <Popover><PopoverTrigger render={<Button variant="outline" />}><Filter size={16} aria-hidden="true" />{text("筛选", "Filter")}{activeConditionCount > 0 && <Badge size="sm" tone={graphMode === "work_items" ? "info" : "neutral"}>{activeConditionCount}</Badge>}</PopoverTrigger><PopoverContent className={`${styles.filterPanel} p-0`} aria-label={text("筛选条件", "Filters")}>
        <FilterCard title={text("筛选条件", "Filters")} fields={filterFields} conditions={conditions} onChange={setConditions} emptyHint={text("添加条件以筛选记录。", "Add a condition to filter records.")} addLabel={text("添加条件", "Add")} clearLabel={text("清除全部", "Clear")} whereLabel={text("其中", "Where")} andLabel={text("并且", "and")} anyLabel={text("任意", "Any")} removeLabel={text("移除条件", "Remove filter")} />
      </PopoverContent></Popover>
      <Popover><PopoverTrigger render={<Button variant="outline" />}><SlidersHorizontal size={16} aria-hidden="true" />{text("视图选项", "View options")}<ChevronDown size={16} aria-hidden="true" /></PopoverTrigger><PopoverContent className={d4.viewOptions} aria-label={text("视图选项", "View options")}>
        <label><Checkbox checked={showRail} onCheckedChange={setShowRail} />{text("显示状态与依赖信息", "Show state and dependency details")}</label>
        <p>{text("筛选只影响展示和导出。项目模式来自正式 depends_on；任务模式展示同项目 prerequisiteIds。连线端点均须可访问且符合筛选，位置不产生依赖。", "Filters affect display and export only. Project mode uses formal depends_on; task mode shows same-project prerequisiteIds. Both endpoints must be authorized and visible. Positions never create dependencies.")}</p>
        <p>{text("选择节点后查看对应评估或关键路径；依赖编辑需要显式提交受版本保护的命令。", "Select a node to inspect its assessment or critical path. Dependency editing requires an explicit version-guarded command.")}</p>
      </PopoverContent></Popover>
      <Button variant="outline" disabled={graphMode === "projects" ? !planning.data : !available} onClick={exportSnapshot} title={text("导出当前筛选的授权快照；不包含不可访问的端点。", "Export the current authorized, filtered snapshot; unavailable endpoints are omitted.")}><Download size={16} aria-hidden="true" />{text("导出", "Export")}</Button>
    </div>}
    toolbar={<div data-pm-toolbar className={d4.shortcuts}><nav className={d4.quickActions} aria-label={text("项目交付入口", "Project delivery shortcuts")}>
      <Button variant="outline" disabled={!surface.capabilities.createIssue} onClick={event => surface.actions.createIssue(event.currentTarget)}><ListTodo size={18} aria-hidden="true" />{text("新建任务", "Create issue")}</Button>
      <MilestoneReschedule projectId={activeProjectId} />
      <SprintPlanner projects={projects.data} projectId={activeProjectId} />
      <Button variant="outline" disabled={!surface.capabilities.createProject} onClick={event => surface.actions.createProject(event.currentTarget)}><FolderKanban size={18} aria-hidden="true" />{text("新建项目", "Add project")}</Button>
    </nav></div>}
    showRail={showRail}
    regions={{
      timeline: graphMode === "projects" ? <section className={`${d4.canvasCard} min-h-96 p-4`} aria-label={text("授权项目依赖画布", "Authorized project dependency canvas")} data-pm-dashboard4="canvas-card"><ProjectDependenciesPanel projectId={activeProjectId} projectIds={projectRows?.map(project => project.id)} onSelectProject={selectProject} onOpenProject={surface.actions.openProject} /></section> : <section className={d4.canvasCard} aria-label={text("授权工作项依赖画布", "Authorized work-item dependency canvas")} data-pm-dashboard4="canvas-card">
        <div className={`${d4.canvas} ${styles.canvas}`} data-pm-dashboard4="canvas">
          {readNotices}
          {available && rows.length > 0 && layout?.source === document ? <WorkflowCanvas key={`${JSON.stringify(document.nodes.map(node => node.id))}:${JSON.stringify(edges.map(edge => edge.id))}`} document={layout.document} definitions={definitions} selection={currentSelection} onSelectionChange={setSelection} readOnly onOpenNode={id => { if (scope.has(id)) openEntity(id) }} onContextMenu={openCanvasMenu} renderNode={renderNode} showBackground showMiniMap={false} controlsVariant="minimal-vertical" defaultInteractionMode="pan" fitViewOptions={fitViewOptions} edgePath="smoothstep" showEdgeLabels={false} showEdgeArrows={false} /> : available && rows.length === 0 ? <p className={styles.canvasMessage} role="status">{items.length ? text("没有符合筛选条件的工作项。", "No work items match these filters.") : text("当前授权项目内没有工作项。", "No work items in the authorized projects.")}</p> : available ? <p className={styles.canvasMessage} role="status">{text("正在排列真实依赖节点…", "Arranging recorded dependency nodes…")}</p> : null}
          {layout?.source === document && layout.grid && <p className={styles.layoutNotice} role="status">{text("依赖无法进行分层布局；当前网格仅表示位置，不表示顺序。", "A layered layout is unavailable; grid positions do not represent ordering.")}</p>}
        </div>
        <div className={d4.legend}>{stateGroups.map(group => <span key={group} className={d4.bandLabel}><span className={d4.bandDot} style={{ background: stateColors[group] }} aria-hidden="true" />{groupLabel(group)}</span>)}<span className={d4.edgeLegend}>{text("已记录前置关系", "Recorded prerequisite")}</span></div>
      </section>,
      projects: graphMode === "projects" ? <section className={d4.tableCard} aria-label={text("项目与依赖", "Projects and dependencies")} data-pm-dashboard4="projects-table">
        <div className={d4.tableHeader}><h2>{text("授权项目", "Authorized Projects")} ({projectRows?.length ?? "—"})</h2><PmSearch value={query} onChange={setQuery} label={text("搜索项目…", "Search projects…")} /></div>
        <QueryNotice query={{ ...planning, data: planning.data?.projects }} />
        {projectRows && <DataTable rows={projectRows} getRowId={project => project.id} getRowLabel={project => project.title} caption={text("正式项目依赖；与任务阻塞关系分开管理。", "Formal project dependencies, managed separately from task blockers.")} activeRowId={activeProjectId ?? null} onActivateRow={project => selectProject(project.id)} columns={[
          { id: "project", header: text("项目", "Project"), primary: true, cell: project => <Button variant="ghost" onClick={() => selectProject(project.id)}><span className={d4.identifier}>{project.id}</span><span>{project.title}</span></Button> },
          { id: "state", header: text("状态", "State"), cell: project => string(projectById.get(project.id)?.data.status) || "—" },
          { id: "dependencies", header: text("可见前置项目", "Visible prerequisites"), cell: project => <span>{project.dependsOn.filter(id => visibleProjectIds.has(id)).length}{project.hasUnavailableDependencies && ` · ${text("部分端点不可访问", "Some endpoints unavailable")}`}</span> },
          { id: "tasks", header: text("已完成 / 总任务", "Done / total tasks"), cell: project => { const tasks = issues.data?.filter(issue => issue.projectId === project.id); return tasks ? `${tasks.filter(task => task.data.status === "done").length} / ${tasks.length}` : "—" } },
          { id: "due", header: text("截止日期", "Due date"), cell: project => string(projectById.get(project.id)?.data.dueDate) || text("未排期", "Unscheduled") },
          { id: "open", header: text("详情", "Details"), cell: project => <Button variant="ghost" size="sm" aria-label={`${text("打开项目", "Open project")} ${project.title}`} onClick={() => surface.actions.openProject(project.id)}><ArrowUpRight size={14} aria-hidden="true" /></Button> },
        ]} />}
      </section> : <section className={d4.tableCard} aria-label={text("工作项与依赖", "Work items and dependencies")} data-pm-dashboard4="projects-table">
        <div className={d4.tableHeader}><h2>{text("授权工作项", "Authorized Work Items")} ({available ? rows.length : "—"})</h2><div className={d4.tableTools}><PmSearch value={query} onChange={setQuery} label={text("搜索工作项或项目…", "Search work items or projects…")} /><Button variant="outline" onClick={() => surface.actions.openIssues()}>{text("查看全部", "View all")}</Button></div></div>
        {!available ? <div className={styles.tableNotice}>{readNotices}</div> : <DataTable rows={rows} getRowId={item => item.id} getRowLabel={itemTitle} caption={text("授权工作项；选择与依赖画布按真实工作项 ID 同步。", "Authorized work items; selection syncs with canvas nodes by work-item ID.")} selectedIds={currentSelection.nodeIds} onSelectionChange={nodeIds => setSelection({ nodeIds, edgeIds: [] })} activeRowId={selected?.id ?? null} onActivateRow={item => setSelection({ nodeIds: [item.id], edgeIds: [] })} data={{ state: rows.length ? "success" : "empty", emptyTitle: text("无匹配工作项", "No matching work items"), emptyDescription: text("调整搜索或筛选条件。", "Adjust the search or filter conditions.") }} columns={[
          { id: "item", header: text("工作项", "Work item"), primary: true, cell: item => <span className={d4.projectCell}><span className={d4.identifier} title={item.id}>{item.id}</span><span title={itemTitle(item)}>{itemTitle(item)}</span></span> },
          { id: "state", header: text("状态", "State"), cell: item => <Badge size="sm" tone={stateGroup(item) === "done" ? "success" : "neutral"} className={d4.bandLabel}><span className={d4.bandDot} style={{ background: stateColors[stateGroup(item)] }} aria-hidden="true" />{statusLabel(string(item.data.status) || "unspecified")}</Badge> },
          { id: "prerequisites", header: text("前置项", "Prerequisites"), cell: item => strings(item.data.prerequisiteIds).length },
          { id: "owner", header: text("负责人", "Assignee"), cell: item => { const id = string(item.data.assigneeId); return id ? members.data?.find(member => member.userId === id && !member.revokedAt)?.name ?? text("成员信息不可用", "Member unavailable") : text("未分配", "Unassigned") } },
          { id: "due", header: text("截止日期", "Due date"), cell: item => <span className={d4.dueDate}><CalendarDays size={14} aria-hidden="true" />{string(item.data.dueDate) || text("未排期", "Unscheduled")}</span> },
          { id: "open", header: text("详情", "Details"), cell: item => <Button variant="ghost" size="sm" onClick={() => openEntity(item.id)} aria-label={`${text("打开工作项", "Open work item")} ${itemTitle(item)}`}><ArrowUpRight size={14} aria-hidden="true" /></Button> },
        ]} />}
        {(members.error || members.isPending && !members.data) && <div className={styles.tableNotice}><QueryNotice query={members} /></div>}
      </section>,
      rail: <aside className={d4.rail}>
        {graphMode === "projects" ? <section className={d4.panel} data-pm-dashboard4="health"><PortfolioHealth projects={projects.data?.filter(project => visibleProjectIds.has(project.id))} projectId={activeProjectId} /></section> : <section className={d4.panel} aria-label={text("工作项状态分布", "Work-item state distribution")} data-pm-dashboard4="health"><h2>{text("工作项状态", "Work-item States")}</h2>
          <div className={d4.healthSummary}><div className={d4.donut}><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="42" fill="none" stroke="var(--surface-raised)" strokeWidth="18" />{available && stateGroups.map(group => { const length = rows.length ? distribution[group] / rows.length * 263.89 : 0; const offset = ringOffset; ringOffset += length; return <circle key={group} cx="60" cy="60" r="42" fill="none" stroke={stateColors[group]} strokeWidth="18" strokeDasharray={`${length} ${263.89 - length}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" /> })}</svg><div><strong><CountUp value={available ? rows.length : null} /></strong><span>{text("当前筛选", "Filtered total")}</span></div></div><ul data-pm-stagger className={d4.healthList}>{stateGroups.map(group => <li key={group} className={d4.healthRow}><span className={d4.bandLabel}><span className={d4.bandDot} style={{ background: stateColors[group] }} aria-hidden="true" />{groupLabel(group)}</span><strong>{available ? distribution[group] : "—"}</strong></li>)}</ul></div>
          <p className={`${d4.caption} ${styles.scopeNote}`}>{text("记录状态，不是项目健康度；未将 Run 状态推断为工作项完成。", "Recorded states, not project health. Run status is never treated as work-item completion.")}</p>
        </section>}
        <section className={`${d4.panel} ${styles.criticalPanel}`} aria-label={text("关键路径分析", "Critical path analysis")} data-pm-dashboard4="critical-path"><CriticalPathPanel projectId={graphMode === "work_items" ? selected?.projectId ?? activeProjectId : activeProjectId} /></section>
        {graphMode === "work_items" && <section className={d4.panel} aria-label={text("需要关注的前置关系", "Prerequisites needing attention")} data-pm-dashboard4="graph-issues"><h2>{text("需要关注", "Needs Attention")}</h2>
          {!available ? <p className={d4.caption}>{text("等待授权工作项快照，尚不能判断依赖情况。", "Waiting for authorized work-item snapshots; dependency conditions are not yet known.")}</p> : <>
            <div data-pm-stagger className={d4.attentionList}>{attention.slice(0, 4).map(item => { const detail = facts.get(item.id)!; return <article key={item.id} className={d4.attentionCard}><h3>{itemTitle(item)}</h3><p>{detail.notDone > 0 && <span>{detail.notDone} {text("个已记录前置项尚未完成。", "recorded prerequisites are not done.")} </span>}{detail.manual > 0 && <span>{detail.manual} {text("项手动阻塞原因。", "recorded manual blockers.")} </span>}{detail.unavailable > 0 && <span>{detail.unavailable} {text("个前置端点在当前授权快照中不可用；未披露标识或名称。", "prerequisite endpoints are unavailable in the authorized snapshot; identifiers and names are omitted.")} </span>}{detail.unknownState > 0 && <span>{detail.unknownState} {text("个前置项的完成状态未提供。", "prerequisites have no supplied completion state.")}</span>}</p><Button variant="ghost" size="sm" onClick={() => openEntity(item.id)}>{text("查看详情", "View details")}<ArrowUpRight size={14} aria-hidden="true" /></Button></article> })}</div>
            {attention.length > 4 && <p className={`${d4.caption} ${styles.scopeNote}`}>{text(`另有 ${attention.length - 4} 个工作项需要关注，可在任务工作区查看。`, `${attention.length - 4} additional work items need attention; inspect them in the issue workspace.`)}</p>}
            {attention.length === 0 && <p className={d4.caption}>{text("当前筛选内未记录未完成前置项、手动阻塞或不可用端点。", "No unfinished prerequisites, manual blockers or unavailable endpoints are recorded in this filtered snapshot.")}</p>}
          </>}
          {selectedEdge && <p className={`${d4.caption} ${styles.scopeNote}`}>{text("选中前置关系", "Selected prerequisite")}: {itemTitle(byId.get(selectedEdge.source)!)} → {itemTitle(byId.get(selectedEdge.target)!)}</p>}
          {selected && <Button variant="ghost" className={d4.selectedProject} onClick={() => openEntity(selected.id)}>{text("查看选中工作项", "Open selected work item")}<ArrowUpRight size={14} aria-hidden="true" /></Button>}
      <Dialog open={dependencyOpen} onOpenChange={setDependencyOpen}><DialogTrigger onClick={() => setDependencyTarget(undefined)} render={<Button variant="outline" />}><Network size={18} aria-hidden="true" />{text("管理真实依赖", "Manage dependencies")}</DialogTrigger><DialogContent className={styles.editorDialog}><DialogTitle>{text("工作项依赖编辑器", "Work-item dependency editor")}</DialogTitle><DialogDescription>{text("仅此编辑器提交现有受权限和版本保护的依赖命令。画布筛选不修改记录。", "Only this editor submits the existing permission- and version-guarded dependency commands. Canvas filters do not modify records.")}</DialogDescription><div className={styles.editor}>{renderDependencyEditor(dependencyTarget)}</div></DialogContent></Dialog>
        </section>}
      </aside>,
      metrics: null, distribution: null, cards: null, currentProject: null, issues: null, activity: null,
    }}
  />
    <ContextMenuPopup menu={contextMenu} aria-label={text("工作项依赖操作", "Work-item dependency actions")}>
      {menuItem && <>
        <ContextMenuLabel>{contextMenu.target?.kind === "edge" ? `${itemTitle(contextMenu.target.prerequisite)} → ${itemTitle(menuItem)}` : itemTitle(menuItem)}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => openEntity(menuItem.id)}>{text("打开工作项", "Open work item")}</ContextMenuItem>
        {contextMenu.target?.kind === "node" ? <>
          <ContextMenuItem onSelect={() => openDependencies(menuItem)}>{text("查看前置任务", "View prerequisites")}</ContextMenuItem>
          <ContextMenuItem disabled={!menuEditable} title={!menuEditable ? text("当前对象、权限或命令状态不允许编辑；仍可查看前置任务。", "This item, permission, or command state is read-only; prerequisites remain viewable.") : undefined} onSelect={() => openDependencies(menuItem)}>{text("管理前置任务", "Manage prerequisites")}</ContextMenuItem>
        </> : <ContextMenuItem onSelect={() => { const target = contextMenu.target; if (target?.kind === "edge") openDependencies(menuItem, target.prerequisite) }}>{text("在现有面板中定位依赖", "Locate dependency in existing panel")}</ContextMenuItem>}
      </>}
    </ContextMenuPopup>
  </>
}
