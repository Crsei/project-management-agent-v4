import { useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { Archive, ArrowDown, ArrowUp, ChevronsUpDown, Filter, Plus, SlidersHorizontal } from "lucide-react"
import type { Entity } from "@contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useWorkspaceStore } from "@/providers/app-providers"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { ProjectCollectionView, ProjectSelect } from "@/views/pm/project-collection"
import type { ProjectCollectionRecord, ProjectCollectionViewInteraction, ProjectCollectionViewProps } from "@/views/pm/project-collection-contracts"
import { ProjectSummaryIssues, type ProjectSummaryIssue } from "@/views/pm/project-list-4-surface"
import { PmSearch } from "@/views/pm/presentation-page"
import familyStyles from "@/views/pm/projects-views.module.css"
import { projectListViewAliases, projectListViews, projectListToCollection, resolveVariant, usePmDisplaySetting } from "./pm-display-settings"
import { usePmEntities, usePmService, usePortfolioDashboard, useProjectDirectory, useProjectExtras } from "./pm-service"
import { allowed, CommandNotice, issueRecord, projectRecord, queryData, ServiceGuard, string, today, useText, writable, type QueryState } from "./pm-ui"
import { ProjectCoverImage } from "./project-extras"
import { ProjectAgentAction } from "../agent/project-entry"
import { ProjectMenuButton, useProjectMenuActions } from "./project-menu"

type TableSettings = NonNullable<ProjectCollectionViewProps["table"]>
type SortKey = NonNullable<TableSettings["sortKey"]>
type Column = NonNullable<TableSettings["hiddenColumns"]>[number]
type CompletionFilter = "all" | "complete" | "started" | "not-started" | "unknown"
type RowControls = { sortKey: SortKey; sortDir: "asc" | "desc"; completion: CompletionFilter; hidden: Column[] }
const columns: readonly Column[] = ["owner", "health", "milestone", "team", "updated"]

function initialInteraction(): ProjectCollectionViewInteraction {
  return { quickView: "all", search: "", sort: "newest", teamSize: "all", updatedWithin: 0, archiveScope: "all", status: "all", starredOnly: false, filtersOpen: false, selectedId: null, detailOpen: false }
}

function projectSortValue(project: ProjectCollectionRecord, key: SortKey): string | number | null {
  switch (key) {
    case "name": return project.title
    case "owner": return project.owner?.name ?? null
    case "health": return project.healthAssessment ? { on_track: 0, at_risk: 1, off_track: 2 }[project.healthAssessment.status] : null
    case "milestone": return project.milestone?.date ?? project.milestone?.title ?? null
    case "team": return project.teams?.length ? project.teams.map(team => team.name).join(", ") : null
    case "updated": return project.updatedAt ?? null
    case "due": return project.dueDate
  }
}

function compareProjects(left: ProjectCollectionRecord, right: ProjectCollectionRecord, key: SortKey, direction: "asc" | "desc") {
  const a = projectSortValue(left, key)
  const b = projectSortValue(right, key)
  // Missing data stays last in either direction; it is never coerced into a real zero/date.
  if (a === null && b !== null) return 1
  if (b === null && a !== null) return -1
  const order = a === null || b === null ? 0 : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true })
  return order ? order * (direction === "asc" ? 1 : -1) : left.identifier.localeCompare(right.identifier, undefined, { numeric: true })
}

const teamSizeFilters = ["three", "larger", "small", "medium", "large"] as const
type TeamSizeFilter = ProjectCollectionViewInteraction["teamSize"]

function isTeamSizeFilter(value: string): value is TeamSizeFilter {
  return (teamSizeFilters as readonly string[]).includes(value)
}

function matchesTeamSize(project: ProjectCollectionRecord, filter: string) {
  if (filter === "all") return true
  if (project.teamSize === null) return false
  switch (filter) {
    case "three": return project.teamSize === 3
    case "larger": return project.teamSize >= 4
    case "small": return project.teamSize >= 1 && project.teamSize <= 5
    case "medium": return project.teamSize >= 6 && project.teamSize <= 10
    case "large": return project.teamSize >= 11
    default: return false
  }
}

/** Card conditions stay ANDed; values inside one condition are ORed and `isNot` negates. */
function matchesProjectCondition(project: ProjectCollectionRecord, condition: FilterCondition, now: number) {
  if (!condition.values.length) return true
  const matched = condition.values.some(value => {
    switch (condition.field) {
      case "status": return project.status?.value === value
      case "team": return matchesTeamSize(project, value)
      case "completion": return matchesCompletion(project, value as CompletionFilter)
      case "updated": {
        const days = Number(value)
        return days > 0 && !!project.updatedAt && Date.parse(project.updatedAt) >= now - days * 86400000
      }
      case "archive": return project.archived === (value === "archived")
      case "starred": return project.starred === true
      default: return false
    }
  })
  return condition.operator === "isNot" ? !matched : matched
}

function matchesCompletion(project: ProjectCollectionRecord, filter: CompletionFilter) {
  if (filter === "all") return true
  if (filter === "unknown") return project.health === null
  if (project.health === null) return false
  return filter === "complete" ? project.health === 100 : filter === "not-started" ? project.health === 0 : project.health > 0 && project.health < 100
}

export function ServiceProjects() {
  const { workspace } = usePmService()
  const t = useText()
  const navigate = useNavigate()
  return <ServiceGuard><div className="flex min-h-0 min-w-0 flex-1 flex-col"><CommandNotice />{workspace?.capabilities.includes("domain.read") ? <ServiceProjectList /> : workspace && allowed(workspace, "access.manage") ? <div className="p-6"><Button variant="outline" onClick={() => navigate(`/pm/${encodeURIComponent(workspace.id)}/members?tab=teams`)}>{t("团队管理", "Team management")}</Button></div> : <p role="alert" className="p-6">{t("当前无权读取项目。", "You do not have permission to read projects.")}</p>}</div></ServiceGuard>
}

function ServiceProjectList() {
  const projects = usePmEntities("project")
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode)
  const items = usePmEntities("work_item")
  const milestones = usePmEntities("milestone")
  const extras = useProjectExtras()
  const directory = useProjectDirectory()
  const portfolio = usePortfolioDashboard()
  const menu = useProjectMenuActions()
  const { workspace } = usePmService()
  const { workspaceSlug } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useText()
  const root = `/pm/${encodeURIComponent(workspaceSlug ?? "")}`
  const currentUrl = `${location.pathname}${location.search}${location.hash}`
  const configured = usePmDisplaySetting(workspace?.id, "projectListView")
  const view = resolveVariant(searchParams.get("view"), configured, projectListViews, projectListViewAliases)
  const variant = projectListToCollection[view]
  const rows = variant === "table" || variant === "compact"
  const [interaction, setInteraction] = useState(initialInteraction)
  const [controls, setControls] = useState<RowControls>({ sortKey: "updated", sortDir: "desc", completion: "all", hidden: [] })
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const archiveFromUrl = searchParams.get("archive")
  useEffect(() => {
    const archived = archiveFromUrl === "archived"
    setInteraction(previous => ({ ...previous, quickView: archived ? "archived" : "all", archiveScope: archived ? "archived" : "all" }))
    setConditions(previous => {
      const rest = previous.filter(condition => condition.field !== "archive")
      return archived ? [...rest, { field: "archive", operator: "is", values: ["archived"] }] : rest
    })
  }, [archiveFromUrl])
  const all = useMemo(() => {
    const extraById = new Map(extras.data?.projects.map(row => [row.projectId, row]))
    const directoryById = new Map(directory.data?.projects.map(row => [row.projectId, row]))
    const portfolioById = new Map(portfolio.data?.projects.map(row => [row.projectId, row]))
    const milestoneByProject = new Map<string, Entity>()
    for (const milestone of milestones.data ?? []) {
      if (!milestone.projectId || milestone.data.archivedAt || milestone.data.archived === true) continue
      const previous = milestoneByProject.get(milestone.projectId)
      const date = string(milestone.data.targetDate) || "9999-12-31"
      const previousDate = string(previous?.data.targetDate) || "9999-12-31"
      if (!previous || date < previousDate || date === previousDate && milestone.id.localeCompare(previous.id) < 0) milestoneByProject.set(milestone.projectId, milestone)
    }
    return (projects.data ?? []).map(project => {
      const record = projectRecord(project, items.data)
      const extra = extraById.get(project.id)
      const people = directoryById.get(project.id)
      const milestone = milestoneByProject.get(project.id)
      const members = people ? [...new Map(people.teams.flatMap(team => team.members).map(member => [member.id, member])).values()] : undefined
      return {
        ...record,
        owner: record.owner ? { ...record.owner, name: people?.identities.find(person => person.id === record.owner!.id)?.name ?? record.owner.name } : null,
        starred: extra ? extra.favorite?.data.favorite ?? false : null,
        coverVersionId: extra?.cover?.data.artifactVersionId ?? null,
        teams: people?.teams ?? null,
        members,
        teamSize: members?.length ?? null,
        healthAssessment: portfolioById.get(project.id)?.health?.data ?? null,
        milestone: milestone ? { title: string(milestone.data.name), date: string(milestone.data.targetDate) || null } : null,
      }
    })
  }, [projects.data, items.data, milestones.data, extras.data, directory.data, portfolio.data])
  const visible = useMemo(() => {
    const query = interaction.search.trim().toLocaleLowerCase()
    const archive = interaction.quickView === "archived" ? "archived" : interaction.quickView === "active" ? "current" : interaction.archiveScope
    const recentDays = interaction.quickView === "recent" ? interaction.updatedWithin || 7 : interaction.updatedWithin
    const cutoff = recentDays ? Date.now() - recentDays * 86400000 : null
    const sortKey = rows ? controls.sortKey : interaction.sort === "name" || interaction.sort === "name-desc" ? "name" : "updated"
    const sortDir = rows ? controls.sortDir : interaction.sort === "oldest" || interaction.sort === "name" ? "asc" : "desc"
    const teamSize = interaction.quickView === "three" || interaction.quickView === "larger" ? interaction.quickView : interaction.teamSize
    const now = Date.now()
    return all.filter(project => {
      const text = `${project.identifier} ${project.title} ${project.description ?? ""} ${project.owner?.name ?? ""}`.toLocaleLowerCase()
      return (!query || text.includes(query))
        && (interaction.status === "all" || project.status?.value === interaction.status)
        && (archive === "all" || project.archived === (archive === "archived"))
        && (interaction.quickView !== "active" || project.status?.value === "active")
        && (cutoff === null || !!project.updatedAt && Date.parse(project.updatedAt) >= cutoff)
        && (!interaction.starredOnly || project.starred === true)
        && matchesTeamSize(project, teamSize)
        && (!rows || matchesCompletion(project, controls.completion))
        && conditions.every(condition => matchesProjectCondition(project, condition, now))
    }).sort((a, b) => compareProjects(a, b, sortKey, sortDir))
  }, [all, interaction, rows, controls.sortKey, controls.sortDir, controls.completion, conditions])
  const selectedId = variant === "compact" ? searchParams.get("selected") ?? interaction.selectedId : interaction.selectedId
  const selected = all.find(project => project.id === selectedId) ?? visible[0] ?? null
  const selectedHidden = !!selected && !visible.some(project => project.id === selected.id)
  const resolvedInteraction = { ...interaction, selectedId: selected?.id ?? null }
  const canCreate = allowed(workspace, "planning.edit")
  const canEdit = (id: string) => allowed(workspace, "planning.edit", id) && writable(projects.data?.find(project => project.id === id))
  const canStar = menu.canFavorite
  const star = menu.toggleFavorite
  const projectHref = (id: string, detailView?: "detail1" | "detail2") => {
    const params = new URLSearchParams({ returnTo: currentUrl })
    if (detailView) params.set("view", detailView)
    return `${root}/projects/${encodeURIComponent(id)}?${params}`
  }
  const openProject = (id: string, detailView?: "detail1" | "detail2") => navigate(projectHref(id, detailView), { state: { returnTo: currentUrl } })
  const editProject = (id: string) => menu.openDialog(id, "settings")
  const createProject = () => navigate(`${root}/views?${new URLSearchParams({ kind: "project", create: "1", returnTo: currentUrl })}`, { state: { returnTo: currentUrl } })
  const clearFilters = () => {
    setInteraction(previous => ({ ...initialInteraction(), selectedId: previous.selectedId, sort: previous.sort }))
    setControls(previous => ({ ...previous, completion: "all" }))
    setConditions([])
    if (searchParams.has("archive")) {
      const next = new URLSearchParams(searchParams)
      next.delete("archive")
      setSearchParams(next, { replace: true, state: location.state })
    }
  }
  // The card is the single entry point for these filters; mirror them onto the
  // legacy interaction fields so the shared view and quick views stay coherent.
  const setFilterConditions = (next: FilterCondition[]) => {
    setConditions(next)
    const pick = (field: string) => [...next].reverse().find(condition => condition.field === field && condition.values.length > 0) ?? null
    const positive = (field: string) => {
      const condition = pick(field)
      return condition && condition.operator === "is" ? condition.values[0] : null
    }
    const status = positive("status")
    const teamSize = positive("team") ?? "all"
    const updated = positive("updated")
    const archive = positive("archive")
    const starred = pick("starred")
    const completion = positive("completion")
    setInteraction(previous => ({
      ...previous,
      status: status ?? "all",
      teamSize: isTeamSizeFilter(teamSize) ? teamSize : "all",
      updatedWithin: updated === "14" ? 14 : updated === "7" ? 7 : 0,
      archiveScope: archive === "current" || archive === "archived" ? archive : "all",
      starredOnly: !!starred && starred.operator === "is",
      quickView: "all",
    }))
    setControls(previous => ({ ...previous, completion: completion === "complete" || completion === "started" || completion === "not-started" || completion === "unknown" ? completion : "all" }))
  }
  const updateInteraction: ProjectCollectionViewProps["actions"]["setInteraction"] = change => {
    const next = typeof change === "function" ? change(variant === "compact" ? resolvedInteraction : interaction) : change
    if (variant !== "compact" && next.selectedId && (next.detailOpen || next.selectedId !== interaction.selectedId)) {
      openProject(next.selectedId)
      return
    }
    setInteraction({ ...next, detailOpen: false })
    if (variant === "compact" && next.selectedId !== resolvedInteraction.selectedId) {
      const params = new URLSearchParams(searchParams)
      if (next.selectedId) params.set("selected", next.selectedId)
      else params.delete("selected")
      setSearchParams(params, { replace: true, state: location.state })
    }
  }
  const selectedIssues: ProjectSummaryIssue[] = (items.data ?? []).filter(item => item.projectId === selected?.id).map(item => {
    const issue = issueRecord(item)
    return { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description ?? null, state: { label: issue.stateId, tone: issue.stateId === "done" ? "success" : issue.stateId === "in_progress" ? "warning" : issue.stateId === "in_review" ? "info" : "neutral" }, priorityTone: issue.priorityId === "urgent" ? "danger" : issue.priorityId === "high" ? "warning" : "neutral", updatedAt: item.updatedAt }
  })
  const sortKeys: SortKey[] = ["updated", "name", "owner", "health", "milestone", "team", ...(all.some(project => project.dueDate) ? ["due" as const] : [])]
  const statusOptions = [...new Set(["planning", "active", "completed", "cancelled", ...all.flatMap(project => project.status?.value ? [project.status.value] : [])])].map(value => ({ value, label: value }))
  return <ProjectCollectionView
    interactive
    variant={variant}
    readModel={{
      projects: visible,
      selectedProject: selected,
      selectedIssueSummary: selected ? <><div className="px-6 py-3"><Button variant="outline" size="sm" disabled={!canStar(selected.id)} aria-pressed={selected.starred ?? undefined} onClick={() => star(selected.id)}>{selected.starred ? t("取消收藏", "Unfavorite") : t("收藏项目", "Favorite project")}</Button></div><ProjectReadNotice query={items} label={t("项目任务", "Project tasks")} /><ProjectSummaryIssues project={selected} issues={selectedIssues} onOpenProject={() => openProject(selected.id)} onOpenIssues={() => navigate(`${root}/projects/${encodeURIComponent(selected.id)}/issues`)} onOpenIssue={id => navigate(taskOpenMode === "panel" ? `${root}/issues?${new URLSearchParams({ entity: id, returnTo: currentUrl })}` : `${root}/entities/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo: currentUrl })}`, { state: { returnTo: currentUrl } })} emptyLabel={items.data ? t("当前项目暂无关联任务。", "No tasks belong to this project.") : t("任务快照不可用。", "Task snapshot unavailable.")} /></> : undefined,
      data: queryData(projects, visible.length),
      defaultArchiveScope: "all",
      statusOptions,
      sourceDescription: t("真实服务 · 授权范围内全部分页", "Real service · all authorized pages"),
      emptyDescription: t("当前搜索和筛选下无项目。", "No projects match the current search and filters."),
      unavailableDateLabel: t("未排期", "Not scheduled"),
      unavailableHealthLabel: t("暂无统计", "Unavailable"),
      unavailableTasksLabel: t("任务快照不可用", "Task snapshot unavailable"),
      healthMetric: "completion",
      healthLabel: t("任务完成率", "Completion"),
      healthAssessmentLabel: t("健康度", "Health"),
      renderCover: (project, className) => <ProjectCoverImage projectId={project.id} className={className} />,
      referenceDate: today(),
      dateContextLabel: "UTC",
    }}
    interaction={resolvedInteraction}
    filters={{ conditions, onChange: setFilterConditions, onClear: clearFilters }}
    capabilities={{ create: canCreate, edit: canEdit, star: canStar, openFullDetails: true, filters: { archive: true, updated: true, status: true, starred: !!extras.data && !extras.error, teamSize: !!directory.data && !directory.error } }}
    actions={{ setInteraction: updateInteraction, create: createProject, edit: editProject, star, openFullDetails: openProject }}
    headerActions={<><Button variant={interaction.quickView === "archived" ? "secondary" : "outline"} size="sm" onClick={() => { const next = new URLSearchParams(searchParams); if (archiveFromUrl === "archived") next.delete("archive"); else next.set("archive", "archived"); setSearchParams(next) }}><Archive className="size-3.5" aria-hidden="true" />{t("已归档项目", "Archived projects")}</Button>{allowed(workspace, "access.manage") && <Button variant="outline" size="sm" onClick={() => navigate(`${root}/members?tab=teams`)}>{t("团队管理", "Team management")}</Button>}</>}
    renderProjectAction={project => <span className="inline-flex items-center gap-1"><ProjectAgentAction projectId={project.id} projectTitle={project.title} /><ProjectMenuButton projectId={project.id} /></span>}
    toolbarActions={rows ? <ProjectRowsToolbar table={variant === "table"} interaction={interaction} setInteraction={setInteraction} controls={controls} setControls={setControls} sortKeys={sortKeys} statusOptions={statusOptions} conditions={conditions} setConditions={setFilterConditions} clearFilters={clearFilters} canCreate={canCreate} onCreate={createProject} /> : undefined}
    summarySort={variant === "compact" ? <div className="flex items-center gap-1"><ProjectSortSelect controls={controls} sortKeys={sortKeys} onChange={sortKey => setControls(previous => ({ ...previous, sortKey, sortDir: sortKey === "name" || sortKey === "owner" ? "asc" : "desc" }))} /><SortDirection controls={controls} onToggle={() => setControls(previous => ({ ...previous, sortDir: previous.sortDir === "asc" ? "desc" : "asc" }))} /></div> : undefined}
    table={variant === "table" ? {
      hiddenColumns: controls.hidden,
      sortableKeys: sortKeys,
      sortKey: controls.sortKey,
      sortDir: controls.sortDir,
      onSort: sortKey => setControls(previous => ({ ...previous, sortKey, sortDir: previous.sortKey === sortKey ? previous.sortDir === "asc" ? "desc" : "asc" : sortKey === "name" || sortKey === "owner" ? "asc" : "desc" })),
      onOpen: openProject,
      rowActions: project => <ProjectMenuButton projectId={project.id} />,
    } : undefined}
    feedback={<div className={`space-y-2 text-xs text-muted-foreground ${variant === "table" ? "px-6 py-3 max-sm:px-4" : "mb-3"}`}>
      <ProjectReadNotice query={items} label={t("项目任务", "Project tasks")} />
      <ProjectReadNotice query={milestones} label={t("里程碑", "Milestones")} />
      <ProjectReadNotice query={extras} label={t("收藏与封面", "Favorites and covers")} />
      <ProjectReadNotice query={directory} label={t("项目身份与团队", "Project identities and teams")} />
      <ProjectReadNotice query={portfolio} label={t("健康评估", "Health assessments")} />
      {selectedHidden && <div role="status" className="flex flex-wrap items-center gap-2"><span>{t("所选项目被筛选隐藏，选择与任务侧栏仍按真实 ID 保留。", "The selected project is filtered out. Its selection and task rail remain attached to its real ID.")}</span><Button variant="outline" size="sm" onClick={clearFilters}>{t("清除筛选", "Clear filters")}</Button></div>}
    </div>}
  />
}

function ProjectReadNotice({ query, label }: { query: Pick<QueryState, "isPending" | "error" | "refetch"> & { data: unknown }; label: string }) {
  const t = useText()
  return <>{query.isPending && !query.data && <p role="status">{label} · {t("正在读取…", "Loading…")}</p>}{query.error && <div role="alert" className="flex flex-wrap items-center gap-2"><span>{label} · {query.data ? t("刷新失败，保留上次快照，可能已过期：", "Refresh failed; the retained snapshot may be stale: ") : t("读取失败：", "Read failed: ")}{query.error.message}</span><Button variant="outline" size="sm" onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>}</>
}

function ProjectSortSelect({ controls, sortKeys, onChange }: { controls: RowControls; sortKeys: readonly SortKey[]; onChange: (key: SortKey) => void }) {
  const t = useText()
  const labels: Record<SortKey, string> = { name: t("项目名称", "Project name"), owner: t("负责人", "Owner"), health: t("人工健康度", "Assessed health"), milestone: t("里程碑日期", "Milestone date"), team: t("团队", "Team"), updated: t("最近更新", "Last updated"), due: t("截止日期", "Due date") }
  return <ProjectSelect label={t("项目排序", "Sort projects")} displayLabel={t("排序", "Sort by")} icon={<ChevronsUpDown aria-hidden="true" className="size-4" />} value={controls.sortKey} options={sortKeys.map(value => ({ value, label: labels[value] }))} onChange={onChange} />
}

function SortDirection({ controls, onToggle }: { controls: RowControls; onToggle: () => void }) {
  const t = useText()
  return <Button variant="ghost" size="icon" aria-label={controls.sortDir === "asc" ? t("当前升序，切换为降序", "Ascending; switch to descending") : t("当前降序，切换为升序", "Descending; switch to ascending")} onClick={onToggle}>{controls.sortDir === "asc" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</Button>
}

function ProjectRowsToolbar({ table, interaction, setInteraction, controls, setControls, sortKeys, statusOptions, conditions, setConditions, clearFilters, canCreate, onCreate }: {
  table: boolean
  interaction: ProjectCollectionViewInteraction
  setInteraction: ProjectCollectionViewProps["actions"]["setInteraction"]
  controls: RowControls
  setControls: (update: (previous: RowControls) => RowControls) => void
  sortKeys: readonly SortKey[]
  statusOptions: readonly { value: string; label: string }[]
  conditions: readonly FilterCondition[]
  setConditions: (conditions: FilterCondition[]) => void
  clearFilters: () => void
  canCreate: boolean
  onCreate: () => void
}) {
  const t = useText()
  const [filterOpen, setFilterOpen] = useState(false)
  const [displayOpen, setDisplayOpen] = useState(false)
  const labels: Record<Column, string> = { owner: t("负责人", "Owner"), health: t("健康度", "Health"), milestone: t("里程碑", "Milestone"), team: t("团队", "Team"), updated: t("更新于", "Updated") }
  const fields: FilterField[] = [
    { id: "status", label: t("业务状态", "Status"), single: true, options: statusOptions },
    { id: "team", label: t("团队规模", "Team size"), single: true, options: [
      { value: "small", label: t("1–5 人", "1–5 members") },
      { value: "medium", label: t("6–10 人", "6–10 members") },
      { value: "large", label: t("11 人以上", "11+ members") },
    ] },
    { id: "completion", label: t("任务完成率", "Completion"), single: true, options: [
      { value: "complete", label: "100%" },
      { value: "started", label: t("1–99%", "1–99%") },
      { value: "not-started", label: "0%" },
      { value: "unknown", label: t("暂无统计", "Unavailable") },
    ] },
    { id: "updated", label: t("最近更新", "Updated"), single: true, options: [
      { value: "7", label: t("最近 7 天", "Last 7 days") },
      { value: "14", label: t("最近 14 天", "Last 14 days") },
    ] },
    { id: "archive", label: t("归档范围", "Archive"), single: true, options: [
      { value: "current", label: t("未归档", "Current") },
      { value: "archived", label: t("已归档", "Archived") },
    ] },
    { id: "starred", label: t("收藏", "Starred"), single: true, options: [
      { value: "starred", label: t("仅显示收藏", "Starred only") },
    ] },
  ]
  const quickFiltered = interaction.quickView === "active" || interaction.quickView === "recent" || interaction.quickView === "three" || interaction.quickView === "larger"
  const activeFilters = Number(!!interaction.search) + conditions.filter(condition => condition.values.length > 0).length + Number(quickFiltered)
  const update = <K extends keyof ProjectCollectionViewInteraction>(key: K, value: ProjectCollectionViewInteraction[K]) => setInteraction(previous => ({ ...previous, [key]: value, quickView: "all" }))
  return <div className={`${familyStyles.toolbarGroup} max-w-full`} data-pm-toolbar-actions>
    {!table && <PmSearch value={interaction.search} onChange={value => update("search", value)} label={t("搜索项目…", "Search projects...")} />}
    <Popover open={filterOpen} onOpenChange={setFilterOpen}>
      <PopoverTrigger render={<Button variant="outline" data-pm-filter-button />}><Filter aria-hidden="true" />{t("筛选", "Filter")}{activeFilters > 0 && <Badge size="sm" tone="info">{activeFilters}</Badge>}</PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] max-w-[calc(100vw-2rem)] p-0">
        {table && <div className="px-3 pt-3"><PmSearch value={interaction.search} onChange={value => update("search", value)} label={t("搜索项目…", "Search projects...")} /></div>}
        <FilterCard
          title={t("筛选项目", "Filter projects")}
          fields={fields}
          conditions={conditions}
          onChange={setConditions}
          emptyHint={t("尚未添加筛选条件。", "No conditions yet.")}
          addLabel={t("添加条件", "Add condition")}
          clearLabel={t("清除条件", "Clear conditions")}
          whereLabel={t("条件", "Where")}
          andLabel={t("并且", "and")}
          anyLabel={t("任意", "Any")}
          removeLabel={t("移除条件", "Remove condition")}
        />
        <div className="flex items-center gap-1 px-3 py-2"><ProjectSortSelect controls={controls} sortKeys={sortKeys} onChange={sortKey => setControls(previous => ({ ...previous, sortKey, sortDir: sortKey === "name" || sortKey === "owner" ? "asc" : "desc" }))} /><SortDirection controls={controls} onToggle={() => setControls(previous => ({ ...previous, sortDir: previous.sortDir === "asc" ? "desc" : "asc" }))} /></div>
        <div className="px-3 pb-3"><Button variant="ghost" size="sm" onClick={clearFilters}>{t("清除筛选", "Clear filters")}</Button></div>
      </PopoverContent>
    </Popover>
    {table && <Popover open={displayOpen} onOpenChange={setDisplayOpen}>
      <PopoverTrigger render={<Button variant="outline" data-pm-display-button />}><SlidersHorizontal aria-hidden="true" />{t("显示", "Display")}</PopoverTrigger>
      <PopoverContent align="start" className={familyStyles.filterPopover}><p className={familyStyles.filterLabel}>{t("可见列", "Visible columns")}</p>{columns.map(column => <label key={column} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!controls.hidden.includes(column)} onChange={() => setControls(previous => ({ ...previous, hidden: previous.hidden.includes(column) ? previous.hidden.filter(key => key !== column) : [...previous.hidden, column] }))} /><span>{labels[column]}</span></label>)}</PopoverContent>
    </Popover>}
    <Button data-pm-create-project size={table ? "default" : "icon"} aria-label={t("添加项目", "Add Project")} disabled={!canCreate} onClick={onCreate}><Plus aria-hidden="true" />{table && <span>{t("添加项目", "Add Project")}</span>}</Button>
  </div>
}
