import { useCallback, useEffect, useMemo } from "react"
import { Handle, Position } from "@xyflow/react"
import { AlertTriangle, ArrowUpRight, CalendarDays, ChevronDown, Download, Filter, Flag, FolderPlus, ListTodo, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import type { CanvasNodeProps } from "@/components/ui/canvas-node"
import { DataTable } from "@/components/blocks/data-table"
import { WorkflowCanvas } from "@/components/blocks/workflow-canvas"
import type { CanvasSelection } from "@/lib/canvas-model"
import { useI18n } from "@/lib/i18n-provider"
import { redactText } from "@/lib/redact"
import { DashboardView } from "./dashboard"
import { DashboardNavigation } from "./dashboard-navigation"
import { useFixtureDashboardSurface } from "./dashboard-fixture-surface"
import { useDashboard4State, analyzeDependencies, dependencyCanvasIssues, dependencyDefinitions, dependencyDocument, riskCounts, type Dashboard4Risk } from "./dashboard-4-controller"
import { dashboardMember, DependencyIssueList, healthBandColor, healthBandLabel, SectionTitle, usePmProjectDomain } from "./dashboards-views"
import { usePmNavigation } from "./domain-session"
import { pmClock, type PmPageProps } from "./model"
import { issueCatalog } from "./issue-domain"
import { formatProjectDate } from "./project-list-1-fixtures"
import { projectHealthBand, projectHealthBands, type ProjectHealthBand } from "./project-health"
import { PmMemberIdentity, PmSearch, usePmScenarioState } from "./shared"
import { useIssueDomain } from "./use-issue-domain"
import { usePeopleDomain } from "./use-people-domain"
import d4 from "./dashboard-4.module.css"

const bandTones: Record<ProjectHealthBand, "success" | "warning" | "danger" | "neutral"> = {
  "on-track": "success",
  "at-risk": "warning",
  "off-track": "danger",
  unknown: "neutral",
}

// Measured presentation widths only. Dependency facts remain in the stored edge records.
const nodeWidths: Readonly<Record<string, number>> = {
  "project-rev-241": 230,
  "project-mob-092": 225,
  "project-onb-118": 245,
  "project-kb-057": 220,
  "project-rtl-062": 230,
  "project-clm-084": 270,
  "project-sla-203": 225,
}
const fitViewOptions = { padding: 0.16, maxZoom: 0.7 }
type IssueFilterTarget = {
  stateId: string
  priorityId: string
  assigneeIds: readonly string[]
  projectId: string
  dueDate: string | null
}
function issueDueBucket(date: string | null, today: string, weekEnd: string) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "none"
  if (date < today) return "overdue"
  if (date === today) return "today"
  return date <= weekEnd ? "week" : "later"
}
function matchesIssueFilter(issue: IssueFilterTarget, condition: FilterCondition, today: string, weekEnd: string) {
  if (!condition.values.length) return true
  let hit = false
  if (condition.field === "status") hit = condition.values.includes(issue.stateId)
  else if (condition.field === "priority") hit = condition.values.includes(issue.priorityId)
  else if (condition.field === "assignee") hit = issue.assigneeIds.length ? issue.assigneeIds.some((id) => condition.values.includes(id)) : condition.values.includes("unassigned")
  else if (condition.field === "project") hit = condition.values.includes(issue.projectId)
  else if (condition.field === "due") hit = condition.values.includes(issueDueBucket(issue.dueDate, today, weekEnd))
  return condition.operator === "isNot" ? !hit : hit
}

export function DependencyDashboardFixture({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const text = useCallback((zh: string, english: string) => en ? english : zh, [en])
  const { navigate } = usePmNavigation()
  const [issueDomain] = useIssueDomain(scenario)
  const projects = usePmProjectDomain(scenario)
  const [fixturePeople] = usePeopleDomain(scenario)
  const [state, setState] = useDashboard4State()
  const [presentation, setPresentation] = usePmScenarioState("pm-dashboard-4-presentation", () => ({ query: "", showRail: true }))
  const [conditions, setConditions] = usePmScenarioState<FilterCondition[]>("pm-dashboard-4-issue-filters", () => [])
  const issueFilterToday = pmClock.slice(0, 10)
  const issueFilterWeekEnd = new Date(Date.parse(`${issueFilterToday}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10)
  const activeFilterCount = conditions.filter(condition => condition.values.length > 0).length
  const filteredDomainIssues = useMemo(() => issueDomain.items.filter(issue => conditions.every(condition => matchesIssueFilter(issue, condition, issueFilterToday, issueFilterWeekEnd))), [issueDomain.items, conditions, issueFilterToday, issueFilterWeekEnd])
  const issueFilterCatalog = issueCatalog(locale)
  const issueProjectOptions = projects.map(project => ({ value: project.id, label: `${project.identifier} ${project.title[locale]}` }))
  const filterFields: FilterField[] = [
    { id: "status", label: text("状态", "Status"), options: issueFilterCatalog.states.map(status => ({ value: status.id, label: status.label })) },
    { id: "priority", label: text("优先级", "Priority"), options: issueFilterCatalog.priorities.map(priority => ({ value: priority.id, label: priority.label })) },
    { id: "assignee", label: text("负责人", "Assignee"), options: [...issueFilterCatalog.assignees.map(assignee => ({ value: assignee.id, label: assignee.label })), { value: "unassigned", label: text("未分配", "Unassigned") }] },
    ...(issueProjectOptions.length ? [{ id: "project", label: text("项目", "Project"), options: issueProjectOptions }] : []),
    { id: "due", label: text("截止日期", "Due date"), options: [
      { value: "overdue", label: text("已逾期", "Overdue") },
      { value: "today", label: text("今天到期", "Due today") },
      { value: "week", label: text("未来 7 天", "Next 7 days") },
      { value: "later", label: text("更晚", "Later") },
      { value: "none", label: text("无到期日", "No due date") },
    ] },
  ]
  const analysis = useMemo(() => analyzeDependencies(projects), [projects])
  const dependencyProjects = useMemo(() => analysis.nodeIds.flatMap(id => {
    const project = projects.find(item => item.id === id)
    return project ? [project] : []
  }), [analysis.nodeIds, projects])
  const counts = riskCounts(dependencyProjects)
  const openIssues = useMemo(() => {
    const counts = new Map<string, number>()
    for (const issue of filteredDomainIssues) {
      counts.set(issue.projectId, (counts.get(issue.projectId) ?? 0) + (issue.stateId === "done" ? 0 : 1))
    }
    return counts
  }, [filteredDomainIssues])
  const rows = useMemo(() => dependencyProjects.filter(project =>
    (state.risk === "all" || projectHealthBand(project.health) === state.risk) &&
    `${project.identifier} ${project.title[locale]}`.toLocaleLowerCase(locale).includes(presentation.query.trim().toLocaleLowerCase(locale)),
  ), [dependencyProjects, state.risk, locale, presentation.query])
  const scopeNodeIds = useMemo(() => rows.map(project => project.id), [rows])
  const scope = useMemo(() => new Set(scopeNodeIds), [scopeNodeIds])
  const meta = useMemo(() => Object.fromEntries(dependencyProjects.map(project => [project.id, {
    title: `${project.identifier} ${project.title[locale]}`,
    summary: `${healthBandLabel(projectHealthBand(project.health), en)} · ${project.health ?? "—"}/100`,
  }])), [dependencyProjects, locale, en])
  const document = useMemo(() => dependencyDocument(scopeNodeIds, analysis, meta, state.viewport), [scopeNodeIds, analysis, meta, state.viewport])
  const definitions = useMemo(() => dependencyDefinitions({
    definition: text("项目依赖", "Project dependency"),
    dependsOn: text("依赖于", "depends on"),
    blocks: text("阻塞", "blocks"),
  }), [text])
  const canvasIssues = useMemo(() => dependencyCanvasIssues(analysis, scope), [analysis, scope])
  const renderableEdges = useMemo(() => analysis.chainEdges.concat(analysis.cycleEdges, analysis.selfLoopEdges), [analysis])
  const attentionProjects = dependencyProjects.filter(project => projectHealthBand(project.health) === "off-track")
  const riskOptions: { id: Dashboard4Risk; label: string; count: number }[] = [
    { id: "all", label: text("全部", "All"), count: dependencyProjects.length },
    ...projectHealthBands.map(band => ({ id: band, label: healthBandLabel(band, en), count: counts[band] })),
  ]

  useEffect(() => {
    const validEdgeIds = new Set(renderableEdges.map(edge => edge.id))
    if ((state.activeProjectId === null || analysis.nodeIds.includes(state.activeProjectId)) &&
      state.selection.nodeIds.every(id => analysis.nodeIds.includes(id)) &&
      state.selection.edgeIds.every(id => validEdgeIds.has(id))) return
    setState(previous => ({
      ...previous,
      activeProjectId: previous.activeProjectId && analysis.nodeIds.includes(previous.activeProjectId) ? previous.activeProjectId : null,
      selection: {
        nodeIds: previous.selection.nodeIds.filter(id => analysis.nodeIds.includes(id)),
        edgeIds: previous.selection.edgeIds.filter(id => validEdgeIds.has(id)),
      },
    }))
  }, [analysis.nodeIds, renderableEdges, state.activeProjectId, state.selection, setState])

  function selectFromTable(ids: string[]) {
    setState(previous => ({ ...previous, activeProjectId: ids.at(-1) ?? null, selection: { nodeIds: ids, edgeIds: [] } }))
  }
  function selectFromCanvas(selection: CanvasSelection) {
    const edge = renderableEdges.find(item => item.id === selection.edgeIds[0])
    setState(previous => ({ ...previous, selection, activeProjectId: selection.nodeIds[0] ?? edge?.target ?? null }))
  }
  function exportSnapshot() {
    const snapshot = {
      source: "local fixture snapshot; no remote service",
      projects: rows.map(project => ({ id: project.id, identifier: project.identifier, title: redactText(project.title[locale]), health: project.health, ownerId: project.ownerId, dueDate: project.dueDate })),
      dependencies: document.edges,
      issues: analysis.issues,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }))
    const link = window.document.createElement("a")
    link.href = url
    link.download = "local-project-dependencies.json"
    link.click()
    URL.revokeObjectURL(url)
  }
  const renderNode = useCallback(({ node, definition, selected, issues = [] }: CanvasNodeProps) => {
    const project = dependencyProjects.find(item => item.id === node.id)
    if (!project) return null
    const band = projectHealthBand(project.health)
    return <div className={d4.node} style={{ width: nodeWidths[node.id] ?? 230 }} data-canvas-node={node.id} data-selected={selected || undefined} data-band={band}>
      <p className={d4.nodeTitle} title={`${project.identifier} ${project.title[locale]}`}>{project.title[locale]}</p>
      <p className={d4.nodeSummary}>{text("项目 · 健康度", "Project · Health")} {project.health === null ? "—" : `${project.health}%`}</p>
      <div className={d4.nodeFooter}>
        <span className={d4.bandLabel}><span className={d4.bandDot} style={{ background: healthBandColor(band) }} aria-hidden="true" />{healthBandLabel(band, en)}</span>
        <span>{openIssues.has(node.id) ? `${openIssues.get(node.id)} ${text("个任务", "issues")}` : text("无记录", "No records")}</span>
      </div>
      {issues.length > 0 && <span className={d4.nodeIssue} title={issues.map(issue => issue.message).join("\n")}><AlertTriangle size={12} aria-hidden="true" />{issues.length} {text("校验问题", "validation issues")}</span>}
      <div className={d4.ports}>{definition?.ports.map(port => <Handle key={port.id} id={port.id} type={port.direction === "input" ? "target" : "source"} position={port.direction === "input" ? Position.Top : Position.Right} isConnectable={false} />)}</div>
    </div>
  }, [dependencyProjects, en, locale, openIssues, text])
  const ringOffsets: Record<ProjectHealthBand, number> = {
    "on-track": 0,
    "at-risk": counts["on-track"],
    "off-track": counts["on-track"] + counts["at-risk"],
    unknown: counts["on-track"] + counts["at-risk"] + counts["off-track"],
  }
  const surface = useFixtureDashboardSurface(scenario, "dashboard4", dependencyProjects, filteredDomainIssues.filter(issue => scope.has(issue.projectId)), fixturePeople, issueDomain.activity)
  const canvasProps = {
    document, definitions, readOnly: true, issues: canvasIssues, selection: state.selection,
    onSelectionChange: selectFromCanvas,
    onViewportChange: (viewport: NonNullable<typeof document.viewport>) => setState(previous => ({ ...previous, viewport })),
    onOpenNode: (nodeId: string) => navigate("project-detail-1", nodeId),
    renderNode, showBackground: true, showMiniMap: false,
    controlsVariant: "minimal-vertical" as const, defaultInteractionMode: "pan" as const, fitViewOptions,
    edgePath: "smoothstep" as const, showEdgeLabels: false, showEdgeArrows: true,
  }

  return <DashboardView {...surface}
    navigation={<DashboardNavigation query={presentation.query} onQueryChange={query => setPresentation(previous => ({ ...previous, query }))} onActivity={() => navigate("inbox-1")} breadcrumb={<><span>{text("项目", "Projects")}</span><span aria-hidden="true">/</span><strong>{text("项目交付", "Project Delivery")}</strong></>} />}
    readModel={{ ...surface.readModel, title: text("项目依赖地图", "Project Dependency Map"), dependencyMap: canvasProps,
      data: { ...surface.readModel.data, emptyDescription: text("当前本地场景没有项目。请选择其他场景查看示例。", "This local scene has no projects. Choose another scene to inspect the examples.") } }}
    headerActions={<div className={d4.actions}>
      {scenario === "readonly" && <Badge>{text("只读", "Read only")}</Badge>}
      <Popover><PopoverTrigger render={<Button variant="outline" />}><Filter size={16} aria-hidden="true" />{text("筛选", "Filter")}{activeFilterCount > 0 && <Badge size="sm" tone="info">{activeFilterCount}</Badge>}</PopoverTrigger>
        <PopoverContent className="w-[min(460px,calc(100vw-2rem))] p-0" aria-label={text("任务筛选", "Issue filters")}>
          <FilterCard title={text("任务筛选", "Issue filters")} fields={filterFields} conditions={conditions} onChange={setConditions} emptyHint={text("尚未添加筛选条件，显示当前范围内的全部任务。", "No filter conditions yet; every issue in scope is shown.")} addLabel={text("添加条件", "Add condition")} clearLabel={text("清除条件", "Clear conditions")} whereLabel={text("条件", "Where")} andLabel={text("并且", "and")} anyLabel={text("任意", "Any")} removeLabel={text("移除条件", "Remove filter")}/>
        </PopoverContent>
      </Popover>
      <Popover><PopoverTrigger render={<Button variant="outline" />}><AlertTriangle size={16} aria-hidden="true" />{text("风险", "Risk")}</PopoverTrigger>
        <PopoverContent className={d4.filter} aria-label={text("风险筛选", "Risk filter")}>
          {riskOptions.map(option => <Button key={option.id} variant="ghost" aria-pressed={state.risk === option.id} onClick={() => setState(previous => ({ ...previous, risk: option.id }))}>{option.label}<span>{option.count}</span></Button>)}
        </PopoverContent>
      </Popover>
      <Popover><PopoverTrigger render={<Button variant="outline" />}><SlidersHorizontal size={16} aria-hidden="true" />{text("视图选项", "View options")}<ChevronDown size={16} aria-hidden="true" /></PopoverTrigger>
        <PopoverContent className={d4.viewOptions} aria-label={text("视图选项", "View options")}>
          <label><Checkbox checked={presentation.showRail} onCheckedChange={showRail => setPresentation(previous => ({ ...previous, showRail }))} />{text("显示项目健康度与关键路径", "Show project health and critical path")}</label>
          <p>{text("视图与筛选只影响本地展示，不修改项目。", "Views and filters only change the local presentation, not project records.")}</p>
          <p>{text("依赖只来自存储的边，位置不产生依赖；没有依赖记录的项目不在图中。失效引用、环和自环始终保留在关注面板，且不参与关键路径计算。", "Dependencies come only from stored edges, never node positions. Projects without dependency records are not on the map. Dangling references, cycles and self-loops remain in the attention panel and are excluded from critical-path calculation.")}</p>
        </PopoverContent>
      </Popover>
      <Button variant="outline" disabled={scenario === "loading" || projects.length === 0} onClick={exportSnapshot} title={text("下载本地场景快照，不连接远端服务", "Download a local scene snapshot; no remote service")}><Download size={16} aria-hidden="true" />{text("导出", "Export")}</Button>
    </div>}
    toolbar={<div data-pm-toolbar className={d4.shortcuts}><nav className={d4.quickActions} aria-label={text("项目工作区入口", "Project workspace shortcuts")}>
      <Button variant="outline" onClick={() => navigate("issue-list-1")}><ListTodo size={18} aria-hidden="true" />{text("任务工作区", "Issue workspace")}</Button>
      <Button variant="outline" onClick={() => navigate("issue-calendar-1")}><Flag size={18} aria-hidden="true" />{text("里程碑排期", "Milestone schedule")}</Button>
      <Button variant="outline" onClick={() => navigate("issue-kanban-1")}><CalendarDays size={18} aria-hidden="true" />{text("迭代看板", "Sprint board")}</Button>
      <Button variant="outline" onClick={() => navigate("project-list-1")}><FolderPlus size={18} aria-hidden="true" />{text("项目工作区", "Project workspace")}</Button>
    </nav></div>}
    showRail={presentation.showRail}
    regions={{
      timeline: <section aria-label={text("依赖画布", "Dependency canvas")} className={d4.canvasCard} data-pm-dashboard4="canvas-card">
        <div className={d4.canvas} data-pm-dashboard4="canvas"><WorkflowCanvas {...canvasProps} /></div>
        <div className={d4.legend}>{projectHealthBands.map(band => <span key={band} className={d4.bandLabel}><span className={d4.bandDot} style={{ background: healthBandColor(band) }} aria-hidden="true" />{healthBandLabel(band, en)}</span>)}<span className={d4.edgeLegend}>{text("已记录依赖", "Stored dependency")}</span></div>
      </section>,
      projects: <section className={d4.tableCard} aria-label={text("活跃项目", "Active projects")} data-pm-dashboard4="projects-table">
        <div className={d4.tableHeader}><SectionTitle>{text("活跃项目", "Active Projects")} ({rows.length})</SectionTitle><div className={d4.tableTools}>
          <PmSearch value={presentation.query} onChange={query => setPresentation(previous => ({ ...previous, query }))} label={text("搜索项目…", "Search projects...")} />
          <Button variant="outline" onClick={() => navigate("project-list-1")}>{text("查看全部", "View all")}</Button>
        </div></div>
        <DataTable rows={rows} getRowId={project => project.id} getRowLabel={project => project.identifier} caption={text("按项目 ID 与画布同步选择的活跃项目", "Active projects; selection syncs with canvas nodes by project id")} activeRowId={state.activeProjectId} onActivateRow={project => selectFromTable([project.id])} columns={[
          { id: "project", header: text("项目", "Projects"), primary: true, cell: project => <span className={d4.projectCell}><span className={d4.identifier}>{project.identifier}</span><span title={project.title[locale]}>{project.title[locale]}</span></span> },
          { id: "status", header: text("状态", "Status"), cell: project => <Badge size="sm" tone={bandTones[projectHealthBand(project.health)]} className={d4.bandLabel}><span className={d4.bandDot} style={{ background: healthBandColor(projectHealthBand(project.health)) }} aria-hidden="true" />{healthBandLabel(projectHealthBand(project.health), en)}</Badge> },
          { id: "issues", header: text("未完成任务", "Open issues"), cell: project => openIssues.has(project.id) ? String(openIssues.get(project.id)) : <span className={d4.caption}>{text("无记录", "No records")}</span> },
          { id: "owner", header: text("负责人", "Owner"), cell: project => { const owner = dashboardMember(project.ownerId); return owner ? <PmMemberIdentity member={owner} /> : project.ownerId } },
          { id: "due", header: text("截止日期", "Due date"), cell: project => <span className={d4.dueDate}><CalendarDays size={14} aria-hidden="true" />{formatProjectDate(project.dueDate, locale)}</span> },
        ]} />
        {rows.length === 0 && <p className={d4.empty} role="status">{text("没有符合筛选条件的项目。", "No projects match these filters.")}</p>}
      </section>,
      rail: <aside className={d4.rail}>
        <section className={d4.panel} aria-label={text("项目健康度", "Project Health")} data-pm-dashboard4="health">
          <SectionTitle>{text("项目健康度", "Project Health")}</SectionTitle>
          <div className={d4.healthSummary}><div className={d4.donut}><svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="42" fill="none" stroke="var(--surface-raised)" strokeWidth="18" />
            {projectHealthBands.map(band => { const total = Math.max(dependencyProjects.length, 1); const length = counts[band] / total * 263.89; return <circle key={band} cx="60" cy="60" r="42" fill="none" stroke={healthBandColor(band)} strokeWidth="18" strokeDasharray={`${length} ${263.89 - length}`} strokeDashoffset={-ringOffsets[band] / total * 263.89} transform="rotate(-90 60 60)" /> })}
          </svg><div><strong>{dependencyProjects.length}</strong><span>{text("总计", "Total")}</span></div></div>
            <ul className={d4.healthList}>{projectHealthBands.map(band => <li key={band} className={d4.healthRow}><span className={d4.bandLabel}><span className={d4.bandDot} style={{ background: healthBandColor(band) }} aria-hidden="true" />{healthBandLabel(band, en)}</span><strong>{counts[band]}</strong></li>)}</ul>
          </div>
        </section>
        <section className={d4.panel} aria-label={text("关键路径", "Critical Path")} data-pm-dashboard4="critical-path">
          <SectionTitle>{text("关键路径", "Critical Path")}</SectionTitle>
          {analysis.criticalPath.length === 0 ? <p className={d4.caption}>{text("没有可计算的依赖链。", "No dependency chain is computable.")}</p> : <ol className={d4.pathList}>
            {analysis.criticalPath.map(step => { const project = dependencyProjects.find(item => item.id === step.projectId); const band = projectHealthBand(project?.health ?? null); return <li key={step.projectId} className={d4.pathRow}><span className={d4.bandDot} style={{ background: healthBandColor(band) }} aria-hidden="true" /><div><Button variant="ghost" className={d4.pathAction} title={project?.title[locale]} onClick={() => navigate("project-detail-1", step.projectId)}><span className={d4.pathTitle}>{project?.title[locale] ?? step.projectId}</span></Button><p style={{ color: healthBandColor(band) }}>{step.via || text("链路起点", "Chain start")} · {healthBandLabel(band, en)}</p></div></li> })}
          </ol>}
        </section>
        <section className={d4.panel} aria-label={text("需要关注", "Needs Attention")} data-pm-dashboard4="graph-issues">
          <SectionTitle>{text("需要关注", "Needs Attention")}</SectionTitle>
          <div className={d4.attentionList}>{attentionProjects.map(project => <article key={project.id} className={d4.attentionCard}>
            <h3>{text(`${project.identifier} 落后于计划`, `${project.identifier} is off track`)}</h3>
            <p>{text(`健康度 ${project.health}/100；${analysis.chainEdges.concat(analysis.cycleEdges).filter(edge => edge.target === project.id).length} 个下游项目依赖它。`, `Health ${project.health}/100; ${analysis.chainEdges.concat(analysis.cycleEdges).filter(edge => edge.target === project.id).length} downstream projects depend on it.`)}</p>
            <Button variant="ghost" size="sm" onClick={() => navigate("project-detail-1", project.id)}>{text("查看详情", "View details")}<ArrowUpRight size={14} aria-hidden="true" /></Button>
          </article>)}</div>
          {analysis.excludedFromCriticalPath > 0 && <p className={`${d4.caption} ${d4.exclusionNote}`}>{text(`${analysis.excludedFromCriticalPath} 条异常边不参与关键路径计算。`, `${analysis.excludedFromCriticalPath} anomalous edges are excluded from the critical path.`)}</p>}
          <DependencyIssueList issues={analysis.issues} emptyLabel={text("没有失效引用、环或自环。", "No dangling references, cycles or self-loops.")} />
          {state.activeProjectId && <Button variant="ghost" className={d4.selectedProject} onClick={() => navigate("project-detail-1", state.activeProjectId!)}>{text("查看选中项目", "View selected project")}<ArrowUpRight size={14} aria-hidden="true" /></Button>}
        </section>
      </aside>,
      metrics: null, distribution: null, cards: null, currentProject: null, issues: null, activity: null,
    }}
  />
}
