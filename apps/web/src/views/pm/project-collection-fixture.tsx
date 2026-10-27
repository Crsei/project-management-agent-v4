import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n-provider"
import { pmClock, type PmPageProps, type PmScenario } from "./model"
import { usePmScenarioState } from "./shared"
import { cycleCopy, statusCopy } from "./project-list-1-fixtures"
import { createProjectCollectionInteraction, emptyProjectDraft, projectDraftRecord, visibleProjects, type ProjectDraft, type ProjectCollectionInteraction } from "./project-list-1-controller"
import { usePmControlsReady, usePmNavigation } from "./domain-session"
import { useProjectWrites } from "./use-project-writes"
import { useIssueDomain } from "./use-issue-domain"
import { projectWriteFingerprint, type ProjectWriteResult } from "./project-write-domain"
import { ProjectCollectionView, ProjectSelect } from "./project-collection"
import type { ProjectCollectionRecord, ProjectCollectionViewInteraction, ProjectCollectionViewProps } from "./project-collection-contracts"
import { ProjectSummaryIssues, type ProjectSummaryIssue } from "./project-list-4-surface"
import styles from "./project-list-1.module.css"
import { ChevronsUpDown, Filter, MoreHorizontal, Plus, SlidersHorizontal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { PmSearch } from "./shared"
import { fixtureProjectProjection, useFixtureReadState } from "./fixture-projections"
import { usePmProjectDomain } from "./projects-views"
import { healthBand, healthBandLabel, projectMilestones, projectSortLabel, sortProjects, type HealthBandKey, type ProjectSortKey } from "./projects-domain"
import { issueCatalog, issueRecord, type PmIssue } from "./issue-domain"
import type { ProjectCardRecord } from "./project-list-1-fixtures"
import familyStyles from "./projects-views.module.css"

/** Lab-only adapter. Production callers import the controlled View, never this module. */
export function FixtureProjectCollection(props: PmPageProps & { variant: ProjectCollectionViewProps["variant"] }) {
  return props.variant === "table" || props.variant === "compact"
    ? <FixtureProjectRows scenario={props.scenario} variant={props.variant} />
    : <FixtureProjectCards scenario={props.scenario} variant={props.variant} />
}

function FixtureProjectCards({ scenario, variant }: PmPageProps & { variant: "cover" | "browse" }) {
  const interactive = usePmControlsReady()
  const { locale } = useI18n()
  const en = locale === "en"
  const browse = variant === "browse"
  const pageId = browse ? "pm-project-list-2" : "pm-project-list-1"
  const defaultArchiveScope = browse || scenario === "long-content" ? "all" : "current"
  const { navigate } = usePmNavigation()
  const writes = useProjectWrites(scenario, pageId)
  const [issueDomain] = useIssueDomain(scenario)
  const createOrigin = useRef<HTMLElement | null>(null)
  const completion = useMemo(() => {
    const counts = new Map<string, { closed: number; total: number }>()
    for (const issue of issueDomain.items) {
      if (!issue.projectId) continue
      const entry = counts.get(issue.projectId) ?? { closed: 0, total: 0 }
      entry.total += 1
      if (issue.stateId === "done") entry.closed += 1
      counts.set(issue.projectId, entry)
    }
    return counts
  }, [issueDomain.items])
  const [interaction, setState] = usePmScenarioState<ProjectCollectionInteraction>(
    "project-collection-state",
    () => ({ ...createProjectCollectionInteraction(), quickView: browse ? "active" : "all", archiveScope: defaultArchiveScope }),
    (cached) => ({ ...createProjectCollectionInteraction(), ...(cached as ProjectCollectionInteraction) }),
  )
  const [readingPosition, setReadingPosition] = usePmScenarioState(`${pageId}:reading`, () => 0)
  const [retried, setRetried] = usePmScenarioState("read-recovered", () => false)
  const state = projectDialogState(interaction, writes, locale)
  const readonly = scenario === "readonly" || scenario === "loading"
  const hasDraft = !!state.editingId || !!state.draft.title || !!state.draft.dueDate || state.draft.teamSize !== "4" || state.draft.cycle !== "improvement" || state.draft.status !== "active"
  const visible = visibleProjects(state.projects, state, locale)
  const projectRecords = useMemo(() => new Map(writes.projects.map((project) => {
    const record: ProjectCollectionRecord = {
      ...fixtureProjectProjection(project, issueDomain.items, locale),
      taskCounts: completion.get(project.id) ?? null,
    }
    return [project.id, record] as const
  })), [writes.projects, locale, completion, issueDomain.items])
  const selected = state.projects.find((project) => project.id === state.selectedId)
  const star = (id: string) => {
    const project = writes.projects.find((item) => item.id === id)
    if (!project || !writes.canWrite(id)) return
    writes.submit({ kind: "patch", projectId: id, baseFingerprint: projectWriteFingerprint(project), patch: { starred: !project.starred } }, "confirmed")
  }
  const resultText = projectResultText(state.result, locale)
  return <ProjectCollectionView
    interactive={interactive}
    variant={variant}
    readingPosition={readingPosition}
    onReadingPositionChange={setReadingPosition}
    interaction={state}
    readModel={{
      projects: scenario === "loading" ? [] : visible.map((project) => projectRecords.get(project.id)!),
      selectedProject: selected && scenario !== "loading" ? projectRecords.get(selected.id)! : null,
      data: {
        state: scenario === "loading" ? "loading" : scenario === "refresh-error" && !retried ? "error" : visible.length === 0 ? "empty" : "success",
        loadingLabel: en ? "Loading local scene" : "正在加载本地场景",
        error: { category: "network", message: en ? "The simulated refresh failed." : "模拟刷新失败。", reason: en ? "Your existing data and edits are retained." : "已有数据和编辑已保留。" },
        onRetry: scenario === "refresh-error" ? () => setRetried(true) : undefined,
      },
      defaultArchiveScope,
      statusOptions: (["active", "paused", "completed"] as const).map((value) => ({ value, label: statusCopy[value][locale] })),
      sourceDescription: scenario === "readonly" ? (en ? "Read only · inspection enabled" : "只读 · 可查看详情") : (en ? "Local collection · changes stay in memory" : "本地集合 · 修改仅保留在内存"),
      emptyDescription: readonly ? (en ? "Try another search or clear the filters. This scene is read only." : "试试其他搜索或清除筛选；当前场景只读。") : (en ? "Try another search or filter, or add a project in this local scene." : "试试其他搜索或筛选，或在当前本地场景添加项目。"),
      healthDescription: en ? "Timeline health is an independent fixture assessment; it is not task completion or runtime status." : "时间线健康度是独立的 fixture 评估值，与任务完成比例及运行状态分别表达。",
      unavailableHealthLabel: en ? "Not assessed" : "尚未评估",
      unavailableTasksLabel: en ? "No related issues in this scene" : "本场景暂无关联任务",
      unavailableDateLabel: en ? "Not scheduled" : "未排期",
      referenceDate: pmClock.slice(0, 10), dateContextLabel: "UTC",
      summaryLabel: scenario === "readonly" ? (en ? "Read only" : "只读") : visible.length > 0 && visible.every((project) => project.status === "active" && !project.archived) ? statusCopy.active[locale] : (en ? "All statuses" : "全部状态"),
    }}
    capabilities={{ create: !readonly, edit: (id) => !readonly && writes.canWrite(id) && !hasDraft, star: (id) => !readonly && writes.canWrite(id), openFullDetails: true, filters: { archive: true, updated: true, status: true, starred: true, teamSize: true } }}
    actions={{
      setInteraction: (action) => setState((previous) => {
        const next = typeof action === "function" ? action(previous) : action
        return { ...previous, ...next, status: next.status as ProjectCollectionInteraction["status"] }
      }),
      create: (trigger) => {
        createOrigin.current = trigger
        setState((previous) => ({ ...previous, formOpen: true }))
      },
      edit: (id, trigger) => {
        createOrigin.current = trigger
        const project = writes.projects.find((item) => item.id === id)
        if (!project || readonly || !writes.canWrite(id) || hasDraft) return
        setState((previous) => ({ ...previous, detailOpen: false, formOpen: true, editingId: id, editingFingerprint: projectWriteFingerprint(project), draft: { title: project.title[locale], dueDate: project.dueDate ?? "", teamSize: String(project.teamSize), cycle: project.cycle, status: project.status }, result: "none" }))
      },
      star,
      openFullDetails: (id) => navigate("project-detail-1", id),
    }}
    hasDraft={hasDraft}
    pendingRequestId={state.request?.id}
    editLabel={en ? "Edit locally" : "本地编辑"}
    feedback={resultText && !state.formOpen ? <p role="status" className={styles.result + " mb-4"}>
      {resultText}{state.request && <> <span>{state.request.id}</span> <Button variant="secondary" disabled={readonly} onClick={(event) => { createOrigin.current = event.currentTarget; setState((previous) => ({ ...previous, formOpen: true })) }}>{en ? "Review pending request" : "查看待确认请求"}</Button></>}
      {state.result === "confirmed" && selected && <> <Button variant="ghost" onClick={() => setState((previous) => ({ ...previous, selectedId: selected.id, detailOpen: true }))}>{en ? "Inspect project" : "查看项目"}</Button></>}
    </p> : null}
    createDialog={<ProjectCreateDialog scenario={scenario} consumer={pageId} open={state.formOpen} onOpenChange={(open) => setState((previous) => ({ ...previous, formOpen: open }))} interaction={interaction} setInteraction={setState} finalFocus={() => createOrigin.current?.isConnected ? createOrigin.current : null} />}
  />
}

type FixtureColumn = "owner" | "health" | "milestone" | "team" | "updated"
type FixtureRowsState = {
  search: string
  sortKey: ProjectSortKey
  sortDir: "asc" | "desc"
  health: HealthBandKey | "all"
  team: string
  hidden: FixtureColumn[]
  selectedId: string | null
  selectionEntity: string | null
}
const fixtureColumns: readonly FixtureColumn[] = ["owner", "health", "milestone", "team", "updated"]
const fixtureHealthOptions: readonly (HealthBandKey | "all")[] = ["all", "ontrack", "watching", "needsupdate", "unknown"]
const fixtureSortKeys: readonly ProjectSortKey[] = ["updated", "name", "due", "health"]
function fixtureRowsState(): FixtureRowsState {
  return { search: "", sortKey: "updated", sortDir: "desc", health: "all", team: "all", hidden: [], selectedId: null, selectionEntity: null }
}
function restoreFixtureRows(cached: unknown): FixtureRowsState {
  return { ...fixtureRowsState(), ...(cached as Partial<FixtureRowsState>) }
}

/** Original table/summary controllers project into the shared collection View. */
function FixtureProjectRows({ scenario, variant }: PmPageProps & { variant: "table" | "compact" }) {
  const interactive = usePmControlsReady()
  const { locale } = useI18n()
  const en = locale === "en"
  const table = variant === "table"
  const pageId = table ? "pm-project-list-3" : "pm-project-list-4"
  const { navigate, entityId } = usePmNavigation()
  const { projects, issues, family } = usePmProjectDomain(scenario)
  const writes = useProjectWrites(scenario, pageId)
  const [state, setState] = usePmScenarioState<FixtureRowsState>(table ? "list3-state" : "list4-state", () => ({ ...fixtureRowsState(), selectionEntity: entityId }), restoreFixtureRows)
  const [readingPosition, setReadingPosition] = usePmScenarioState(`${pageId}:reading`, () => 0)
  const [create, setCreate] = usePmScenarioState("project-collection-state", createProjectCollectionInteraction)
  const createOrigin = useRef<HTMLElement | null>(null)
  const data = useFixtureReadState(scenario, pageId)
  const readonly = scenario === "readonly" || scenario === "loading"
  const selectedId = table ? state.selectedId : state.selectionEntity === entityId ? state.selectedId ?? entityId : entityId ?? state.selectedId
  const selected = projects.find((project) => project.id === selectedId) ?? (table ? undefined : projects[0])
  const query = state.search.trim().toLocaleLowerCase(locale)
  const visible = sortProjects(projects.filter((project) => {
    const copy = table ? project.title.en + " " + project.title["zh-CN"] + " " + project.identifier : project.identifier + " " + project.title[locale] + " " + project.description[locale]
    return (!query || copy.toLocaleLowerCase(locale).includes(query)) && (!table || ((state.health === "all" || healthBand(project.health).key === state.health) && (state.team === "all" || project.teamId === state.team)))
  }), state.sortKey, table ? state.sortDir : state.sortKey === "name" ? "asc" : "desc", locale)
  const records = useMemo(() => new Map(projects.map((project) => {
    const milestones = projectMilestones(family, project.id)
    const upcoming = milestones.filter((milestone) => milestone.dueDate && milestone.dueDate >= pmClock.slice(0, 10)).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    const milestone = upcoming[0] ?? [...milestones].sort((a, b) => (b.dueDate ?? "").localeCompare(a.dueDate ?? ""))[0]
    const record: ProjectCollectionRecord = { ...fixtureProjectProjection(project, issues, locale), teamId: project.teamId, milestone: milestone ? { title: milestone.title[locale], date: milestone.dueDate } : null }
    if (record.taskCounts?.total === 0) record.taskCounts = null
    return [project.id, record] as const
  })), [projects, issues, family, locale])
  const setSort = (sortKey: ProjectSortKey) => setState((previous) => ({ ...previous, sortKey, sortDir: previous.sortKey === sortKey ? previous.sortDir === "asc" ? "desc" : "asc" : sortKey === "name" ? "asc" : "desc" }))
  const open = (id: string, slug: string) => {
    setState((previous) => ({ ...previous, selectedId: id, selectionEntity: entityId }))
    navigate(slug, id)
  }
  const interaction: ProjectCollectionViewInteraction = { ...createProjectCollectionInteraction(), quickView: "all", archiveScope: "all", search: state.search, sort: state.sortKey === "name" ? state.sortDir === "asc" ? "name" : "name-desc" : state.sortDir === "asc" ? "oldest" : "newest", selectedId: selected?.id ?? selectedId }
  const selectedHidden = !!selectedId && !visible.some((project) => project.id === selectedId)
  const clearFilters = () => setState((previous) => ({ ...previous, search: "", health: "all", team: "all" }))
  const dialog = projectDialogState(create, writes, locale)
  return <ProjectCollectionView
    interactive={interactive}
    variant={variant}
    readingPosition={readingPosition}
    onReadingPositionChange={setReadingPosition}
    interaction={interaction}
    readModel={{
      projects: scenario === "loading" ? [] : visible.map((project) => records.get(project.id)!), selectedProject: selected && scenario !== "loading" ? records.get(selected.id)! : null,
      data: { ...data, state: data.state === "success" && visible.length === 0 ? "empty" : data.state },
      defaultArchiveScope: "all", statusOptions: [],
      sourceDescription: readonly ? en ? "This scene is read-only; view controls keep working." : "当前场景为只读；视图控件仍可使用。" : en ? "Local collection · changes stay in memory" : "本地集合 · 修改仅保留在内存",
      emptyDescription: projects.length === 0 ? table ? en ? "This scene has no projects. Switch scenes to load fixtures." : "当前场景没有项目，切换场景可加载固定数据。" : en ? "This scene has no project summaries." : "当前场景没有项目摘要。" : table ? en ? "No projects match the current search and filters." : "没有项目符合当前搜索与筛选条件。" : en ? "No projects match your search." : "没有项目符合当前搜索条件。",
      unavailableHealthLabel: en ? "Unknown health" : "健康度未知", unavailableTasksLabel: en ? "No linked task snapshot" : "无关联任务快照", unavailableDateLabel: en ? "Date to be confirmed" : "日期待确认",
      referenceDate: pmClock.slice(0, 10), dateContextLabel: "UTC",
      selectedIssueSummary: !table && selected && scenario !== "loading" ? <FixtureSelectedProjectIssues project={selected} issues={issues.filter((issue) => issue.projectId === selected.id)} onOpenProject={() => open(selected.id, "project-detail-1")} onOpenIssues={() => navigate("issue-list-1", selected.id)} onOpenIssue={(id) => navigate("issue-detail-1", id)} /> : undefined,
    }}
    capabilities={{ create: table && !readonly, edit: () => false, star: () => false, openFullDetails: true, filters: { archive: false, updated: false, status: false, starred: false, teamSize: false } }}
    actions={{
      setInteraction: (action) => {
        const next = typeof action === "function" ? action(interaction) : action
        setState((previous) => ({ ...previous, search: next.search, selectedId: next.selectedId, selectionEntity: entityId, ...(next.sort !== interaction.sort ? { sortKey: next.sort === "name" || next.sort === "name-desc" ? "name" as const : "updated" as const, sortDir: next.sort === "name" || next.sort === "oldest" ? "asc" as const : "desc" as const } : {}) }))
      },
      create: (trigger) => { createOrigin.current = trigger; setCreate((previous) => ({ ...previous, formOpen: true, editingId: null })) },
      edit: () => { throw new Error("Table and summary fixtures edit project metadata in project details") },
      star: () => { throw new Error("Table and summary fixtures do not expose starring") },
      openFullDetails: (id) => open(id, "project-detail-1"),
    }}
    toolbarActions={<FixtureRowsToolbar table={table} state={state} setState={setState} teams={[...new Set(projects.map((project) => project.teamId))]} setSort={setSort} canCreate={!readonly} onCreate={(trigger) => { createOrigin.current = trigger; setCreate((previous) => ({ ...previous, formOpen: true, editingId: null })) }} />}
    summarySort={!table ? <ProjectSelect label={en ? "Sort by" : "排序方式"} displayLabel={en ? "Sort by" : "排序"} icon={<ChevronsUpDown aria-hidden="true" className="size-4" />} value={state.sortKey} options={fixtureSortKeys.map((value) => ({ value, label: projectSortLabel[value][locale] }))} onChange={(sortKey) => setState((previous) => ({ ...previous, sortKey, sortDir: sortKey === "name" ? "asc" : "desc" }))} /> : undefined}
    table={table ? {
      hiddenColumns: state.hidden, sortKey: state.sortKey, sortDir: state.sortDir,
      onSort: (key) => { if (key === "name" || key === "health" || key === "updated" || key === "due") setSort(key) },
      onOpen: (id) => open(id, "project-detail-1"),
      rowActions: (project) => <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={(en ? "Actions for" : "操作") + " " + project.title} onClick={(event) => event.stopPropagation()} />}><MoreHorizontal aria-hidden="true" /></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onClick={() => open(project.id, "project-detail-1")}>{en ? "Open brief" : "打开简报"}</DropdownMenuItem><DropdownMenuItem onClick={() => open(project.id, "project-detail-2")}>{en ? "Open workspace" : "打开工作区"}</DropdownMenuItem><DropdownMenuItem onClick={() => open(project.id, "project-list-4")}>{en ? "Open summary list" : "打开摘要列表"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>,
    } : undefined}
    pendingRequestId={dialog.request?.id}
    feedback={<>{table && selectedHidden && <Alert tone="info" className={familyStyles.notice} data-pm-selection-notice><AlertTitle>{en ? "Selected project is filtered out" : "选中的项目已被筛选隐藏"}</AlertTitle><AlertDescription>{en ? "The selection is retained by id and returns when filters change." : "选择已按 ID 保留，调整筛选后会恢复。"}</AlertDescription><Button variant="outline" size="sm" onClick={clearFilters}>{en ? "Clear filters" : "清除筛选"}</Button></Alert>}{readonly && <p className={familyStyles.muted} data-pm-readonly-note>{en ? "This scene is read-only; view controls keep working." : "当前场景为只读；视图控件仍可使用。"}</p>}</>}
    createDialog={table ? <ProjectCreateDialog scenario={scenario} consumer={pageId} open={create.formOpen} onOpenChange={(formOpen) => setCreate((previous) => ({ ...previous, formOpen }))} interaction={create} setInteraction={setCreate} finalFocus={() => createOrigin.current?.isConnected ? createOrigin.current : null} /> : undefined}
  />
}

function FixtureRowsToolbar({ table, state, setState, teams, setSort, canCreate, onCreate }: { table: boolean; state: FixtureRowsState; setState: Dispatch<SetStateAction<FixtureRowsState>>; teams: string[]; setSort: (key: ProjectSortKey) => void; canCreate: boolean; onCreate: (trigger: HTMLElement) => void }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [filterOpen, setFilterOpen] = useState(false)
  const [displayOpen, setDisplayOpen] = useState(false)
  const columnLabels: Record<FixtureColumn, string> = { owner: en ? "Owner" : "负责人", health: en ? "Health" : "健康度", milestone: en ? "Milestone" : "里程碑", team: en ? "Team" : "团队", updated: en ? "Updated" : "更新" }
  const activeFilters = Number(state.health !== "all") + Number(state.team !== "all")
  return <div className={familyStyles.toolbarGroup} data-pm-toolbar-actions>
    {!table && <PmSearch value={state.search} onChange={(search) => setState((previous) => ({ ...previous, search }))} label={en ? "Search projects..." : "搜索项目…"} />}
    {table && <>
      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <PopoverTrigger render={<Button variant="outline" data-pm-filter-button />}><Filter aria-hidden="true" />{en ? "Filter" : "筛选"}{activeFilters > 0 && <Badge size="sm" tone="info">{activeFilters}</Badge>}</PopoverTrigger>
        <PopoverContent align="start" className={familyStyles.filterPopover}>
          <PmSearch value={state.search} onChange={(search) => setState((previous) => ({ ...previous, search }))} label={en ? "Search projects..." : "搜索项目…"} />
          <div><p className={familyStyles.filterLabel}>{en ? "Delivery health" : "交付健康度"}</p><div className={familyStyles.filterOptions}>{fixtureHealthOptions.map((health) => <button key={health} type="button" className={familyStyles.chipToggle} aria-pressed={state.health === health} onClick={() => setState((previous) => ({ ...previous, health }))}>{health === "all" ? en ? "All health" : "全部健康度" : healthBandLabel[health][locale]}</button>)}</div></div>
          <div><p className={familyStyles.filterLabel}>{en ? "Owning team" : "所属团队"}</p><div className={familyStyles.filterOptions}>{["all", ...teams].map((team) => <button key={team} type="button" className={familyStyles.chipToggle} aria-pressed={state.team === team} onClick={() => setState((previous) => ({ ...previous, team }))}>{team === "all" ? en ? "All teams" : "全部团队" : team}</button>)}</div></div>
          <div><p className={familyStyles.filterLabel}>{en ? "Sort by" : "排序方式"}</p><div className={familyStyles.filterOptions}>{fixtureSortKeys.map((key) => <button key={key} type="button" className={familyStyles.chipToggle} aria-pressed={state.sortKey === key} onClick={() => setSort(key)}>{projectSortLabel[key][locale]}</button>)}</div></div>
          <Button variant="ghost" size="sm" onClick={() => setState((previous) => ({ ...previous, health: "all", team: "all" }))}>{en ? "Clear filters" : "清除筛选"}</Button>
        </PopoverContent>
      </Popover>
      <Popover open={displayOpen} onOpenChange={setDisplayOpen}>
        <PopoverTrigger render={<Button variant="outline" data-pm-display-button />}><SlidersHorizontal aria-hidden="true" />{en ? "Display" : "显示"}</PopoverTrigger>
        <PopoverContent align="start" className={familyStyles.filterPopover}><p className={familyStyles.filterLabel}>{en ? "Visible columns" : "可见列"}</p>{fixtureColumns.map((column) => <label key={column} className={familyStyles.inlineField}><input type="checkbox" checked={!state.hidden.includes(column)} onChange={() => setState((previous) => ({ ...previous, hidden: previous.hidden.includes(column) ? previous.hidden.filter((id) => id !== column) : [...previous.hidden, column] }))} /><span>{columnLabels[column]}</span></label>)}</PopoverContent>
      </Popover>
      <Button data-pm-create-project aria-label={en ? "Add Project" : "添加项目"} disabled={!canCreate} onClick={(event) => onCreate(event.currentTarget)}><Plus aria-hidden="true" /><span>{en ? "Add Project" : "添加项目"}</span></Button>
    </>}
  </div>
}

function FixtureSelectedProjectIssues({ project, issues, onOpenProject, onOpenIssues, onOpenIssue }: { project: ProjectCardRecord; issues: PmIssue[]; onOpenProject: () => void; onOpenIssues: () => void; onOpenIssue: (id: string) => void }) {
  const { locale } = useI18n()
  const catalog = issueCatalog(locale)
  const rows: ProjectSummaryIssue[] = issues.map((issue) => {
    const localized = issueRecord(issue, locale)
    return {
      id: issue.id, identifier: issue.identifier, title: localized.title, description: localized.description ?? null,
      state: { label: catalog.states.find((item) => item.id === issue.stateId)?.label ?? issue.stateId, tone: issue.stateId === "done" ? "success" : issue.stateId === "progress" ? "warning" : issue.stateId === "review" ? "info" : "neutral" },
      priorityTone: issue.priorityId === "urgent" ? "danger" : issue.priorityId === "high" ? "warning" : "neutral",
    }
  })
  return <ProjectSummaryIssues project={fixtureProjectProjection(project, issues, locale)} issues={rows} onOpenProject={onOpenProject} onOpenIssues={onOpenIssues} onOpenIssue={onOpenIssue} />
}


function projectDialogState(interaction: ProjectCollectionInteraction, writes: ReturnType<typeof useProjectWrites>, locale: "zh-CN" | "en") {
  const request = writes.request
  const requestProject =
    request?.change.kind === "patch"
      ? writes.projects.find((project) => project.id === request.projectId)
      : undefined
  const pendingProject =
    request?.change.kind === "create"
      ? request.change.project
      : request?.change.kind === "patch" && requestProject
        ? { ...requestProject, ...request.change.patch }
        : null
  return {
    ...interaction,
    projects: writes.projects,
    request,
    result: request ? ("unknown" as const) : interaction.result,
    ...(pendingProject
      ? {
          draft: {
            title: pendingProject.title[locale],
            dueDate: pendingProject.dueDate ?? "",
            teamSize: String(pendingProject.teamSize),
            cycle: pendingProject.cycle,
            status: pendingProject.status,
          },
          editingId:
            request?.change.kind === "patch" ? request.change.projectId : null,
          editingFingerprint:
            request?.change.kind === "patch"
              ? request.change.baseFingerprint
              : null,
        }
      : {}),
  }
}
function projectResultText(result: ProjectCollectionInteraction["result"], locale: "zh-CN" | "en") {
  const en = locale === "en"
  return {
    none: "",
    confirmed: en
      ? "Confirmed locally. The in-memory collection was updated; your filters are retained."
      : "本地结果已确认，内存集合已更新；原有筛选已保留。",
    rejected: en
      ? "The local simulation rejected this change. Your draft and collection are retained."
      : "本地模拟拒绝了此更改，草稿与原有集合均已保留。",
    unknown: en
      ? "Result unknown. Your draft and request identity are retained. Check the simulated result before submitting again."
      : "结果未知。草稿与请求标识已保留；再次提交前须显式检查模拟结果。",
    invalid: en
      ? "Enter a project name (1–160 characters), a team size from 1 to 99, and a valid optional due date."
      : "请填写 1–160 字的项目名称、1–99 人的团队规模，以及有效的可选截止日期。",
    stale: en
      ? "This project changed after the draft opened. Inspect the current project before acknowledging its revision; your draft is retained."
      : "草稿打开后项目已变更。草稿已保留；请查看当前项目，再确认已复核版本。",
    locked: en
      ? "A project write is awaiting explicit reconciliation. No change was submitted."
      : "存在待显式核对的项目写入，本次没有提交更改。",
  }[result]
}
export function ProjectCreateDialog({
  scenario, consumer, open, onOpenChange, interaction, setInteraction: setState, finalFocus,
}: {
  scenario: PmScenario
  consumer: string
  open: boolean
  onOpenChange: (open: boolean) => void
  interaction: ProjectCollectionInteraction
  setInteraction: Dispatch<SetStateAction<ProjectCollectionInteraction>>
  finalFocus?: () => HTMLElement | null
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const writes = useProjectWrites(scenario, consumer)
  const state = projectDialogState(interaction, writes, locale)
  const readonly = scenario === "readonly" || scenario === "loading"
  const selected = state.projects.find((project) => project.id === state.editingId)
  const update = <K extends keyof ProjectCollectionInteraction>(
    key: K,
    value: ProjectCollectionInteraction[K],
  ) => setState((previous) => ({ ...previous, [key]: value }))
  const draft = <K extends keyof ProjectDraft>(
    key: K,
    value: ProjectDraft[K],
  ) =>
    setState((previous) =>
      writes.request
        ? previous
        : {
            ...previous,
            draft: { ...previous.draft, [key]: value },
            result: "none",
          },
    )
  const statusOptions = (["active", "paused", "completed"] as const).map(
    (value) => ({ value, label: statusCopy[value][locale] }),
  )
  const cycleOptions = (
    ["improvement", "launch", "fix", "maintenance"] as const
  ).map((value) => ({ value, label: cycleCopy[value][locale] }))
  const resultText = projectResultText(state.result, locale)
  const finishWrite = (result: ProjectWriteResult) => {
    setState((previous) =>
      result.status === "confirmed"
        ? {
            ...previous,
            result: "confirmed",
            formOpen: false,
            selectedId: result.projectId,
            editingId: null,
            editingFingerprint: null,
            draft: emptyProjectDraft(),
          }
        : {
            ...previous,
            result: result.status,
            draft: state.draft,
            editingId: state.editingId,
            editingFingerprint: state.editingFingerprint,
          },
    )
    if (result.status === "confirmed") onOpenChange(false)
  }
  const submit = () => {
    if (readonly || !writes.canWrite(state.editingId)) return
    const project = projectDraftRecord(
      state.projects,
      state.draft,
      state.editingId,
      writes.sequence + 1,
    )
    if (!project) {
      update("result", "invalid")
      return
    }
    if (state.editingId && !state.editingFingerprint) {
      update("result", "stale")
      return
    }
    finishWrite(
      writes.submit(
        state.editingId
          ? {
              kind: "patch",
              projectId: state.editingId,
              baseFingerprint: state.editingFingerprint!,
              patch: {
                title: project.title,
                dueDate: project.dueDate,
                teamSize: project.teamSize,
                cycle: project.cycle,
                status: project.status,
                updatedAt: project.updatedAt,
              },
            }
          : { kind: "create", project },
        state.outcome,
      ),
    )
  }
  return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
      >
        <DialogContent finalFocus={finalFocus}>
          <DialogTitle>
            {state.editingId
              ? en
                ? "Edit project locally"
                : "本地编辑项目"
              : en
                ? "Add local project"
                : "添加本地项目"}
          </DialogTitle>
          <DialogDescription>
            {en
              ? "This form updates only the in-memory fixture. Cancel keeps your draft."
              : "此表单仅更新内存 fixture。取消会保留草稿。"}
          </DialogDescription>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <label className={styles.field} htmlFor="pm-project-name">
              {en ? "Project name" : "项目名称"}
              <Input
                id="pm-project-name"
                required
                maxLength={160}
                value={state.draft.title}
                disabled={readonly || !!state.request}
                onChange={(event) => draft("title", event.target.value)}
              />
            </label>
            <div className={styles.fieldRow}>
              <label className={styles.field} htmlFor="pm-project-date">
                {en ? "Due date (optional) · UTC" : "截止日期（可选）· UTC"}
                <Input
                  id="pm-project-date"
                  type="date"
                  value={state.draft.dueDate}
                  disabled={readonly || !!state.request}
                  onChange={(event) => draft("dueDate", event.target.value)}
                />
              </label>
              <label className={styles.field} htmlFor="pm-project-team-size">
                {en ? "Team size" : "团队规模"}
                <Input
                  id="pm-project-team-size"
                  type="number"
                  min={1}
                  max={99}
                  required
                  value={state.draft.teamSize}
                  disabled={readonly || !!state.request}
                  onChange={(event) => draft("teamSize", event.target.value)}
                />
              </label>
            </div>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label htmlFor="pm-project-cycle">
                  {en ? "Cycle" : "周期"}
                </label>
                <ProjectSelect
                  id="pm-project-cycle"
                  label={en ? "Project cycle" : "项目周期"}
                  value={state.draft.cycle}
                  options={cycleOptions}
                  disabled={readonly || !!state.request}
                  onChange={(value) => draft("cycle", value)}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="pm-project-status">
                  {en ? "Status" : "状态"}
                </label>
                <ProjectSelect
                  id="pm-project-status"
                  label={en ? "Draft project status" : "草稿项目状态"}
                  value={state.draft.status}
                  options={statusOptions}
                  disabled={readonly || !!state.request}
                  onChange={(value) => draft("status", value)}
                />
              </div>
            </div>
            <div className={styles.field}>
              <label htmlFor="pm-project-outcome">
                {en ? "Local fixture outcome" : "本地 fixture 结果"}
              </label>
              <ProjectSelect
                id="pm-project-outcome"
                label={en ? "Local fixture outcome" : "本地 fixture 结果"}
                value={state.outcome}
                onChange={(value) => update("outcome", value)}
                disabled={readonly || !!state.request}
                options={[
                  {
                    value: "confirmed",
                    label: en ? "Confirmed locally" : "本地确认",
                  },
                  { value: "rejected", label: en ? "Rejected" : "拒绝" },
                  {
                    value: "unknown",
                    label: en ? "Unknown result" : "结果未知",
                  },
                ]}
              />
            </div>
            {resultText && (
              <p role="status" className={styles.result}>
                {resultText}
                {state.request && (
                  <>
                    <br />
                    <code>{state.request.id}</code>
                  </>
                )}
              </p>
            )}
            {state.request && (
              <div className={styles.field}>
                <label htmlFor="pm-project-check">
                  {en ? "Simulated result-check response" : "模拟结果检查响应"}
                </label>
                <ProjectSelect
                  id="pm-project-check"
                  label={
                    en ? "Simulated result-check response" : "模拟结果检查响应"
                  }
                  value={state.checkOutcome}
                  disabled={readonly}
                  onChange={(value) => update("checkOutcome", value)}
                  options={[
                    {
                      value: "confirmed",
                      label: en ? "Confirmed locally" : "本地确认",
                    },
                    { value: "rejected", label: en ? "Rejected" : "拒绝" },
                  ]}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={readonly}
                  onClick={() => {
                    if (!readonly)
                      finishWrite(writes.reconcile(state.checkOutcome))
                  }}
                >
                  {en ? "Check simulated result" : "检查模拟结果"}
                </Button>
              </div>
            )}
            {state.result === "stale" && state.editingId && selected && (
              <Button
                type="button"
                variant="secondary"
                disabled={readonly || !!state.request}
                onClick={() => {
                  setState((previous) => ({
                    ...previous,
                    editingFingerprint: projectWriteFingerprint(selected),
                    result: "none",
                  }))
                }}
              >
                {en
                  ? "Acknowledge reviewed revision"
                  : "确认已复核当前项目版本"}
              </Button>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={readonly || !!state.request}
                onClick={() => {
                  setState((previous) => ({
                    ...previous,
                    draft: emptyProjectDraft(),
                    editingId: null,
                    editingFingerprint: null,
                    result: "none",
                    formOpen: false,
                  }))
                  onOpenChange(false)
                }}
              >
                {en ? "Discard draft" : "丢弃草稿"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => onOpenChange(false)}
              >
                {en ? "Cancel · keep draft" : "取消 · 保留草稿"}
              </Button>
              <Button
                type="submit"
                disabled={!writes.canWrite(state.editingId)}
              >
                {state.editingId
                  ? en
                    ? "Save locally"
                    : "本地保存"
                  : en
                    ? "Create locally"
                    : "本地创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
  )
}
