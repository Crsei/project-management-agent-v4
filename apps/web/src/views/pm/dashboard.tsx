import type { ReactNode } from "react"
import { FolderKanban, Plus, RefreshCw, SquareCheck, UserRoundCheck, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataRegion } from "@/components/ui/data-region"
import { DataTable } from "@/components/blocks/data-table"
import { WorkItemRow } from "@/components/blocks/work-item"
import { Timeline } from "@/components/blocks/timeline"
import { WorkflowCanvas } from "@/components/blocks/workflow-canvas"
import { addScheduleDays, startOfScheduleWeek } from "@/lib/schedule-date-utils"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage, PmSearch } from "./presentation-page"
import { AvailableMetric, ControlledActivity, ControlledFeedback, ControlledFocus } from "./controlled-presentation"
import type { DashboardViewProps } from "./controlled-contracts"
import d1 from "./dashboard-1.module.css"
import d2 from "./dashboard-2.module.css"
import d3 from "./dashboard-3.module.css"
import d4 from "./dashboard-4.module.css"
import sharedStyles from "./dashboards-views.module.css"

/** Shared geometry only. Counts, business strings, permissions, graph diagnostics
 * and execution belong to the caller. Fixture-only panels replace individual
 * regions; no scenario controller, finance, presence or simulator enters here.
 * An explicit null region hides that region rather than selecting its default. */
export function DashboardView(props: DashboardViewProps) {
  const { readModel: model, interaction, actions, variant } = props
  const { locale } = useI18n()
  const en = locale === "en"
  const text = (zh: string, english: string) => en ? english : zh
  const region = (name: keyof NonNullable<DashboardViewProps["regions"]>, fallback: ReactNode) => props.regions?.[name] === undefined ? fallback : props.regions[name]
  const labels = { projects: text("项目", "Projects"), issues: text("任务", "Issues"), completed: text("已完成", "Completed"), overdue: text("已逾期", "Overdue"), members: text("成员", "Members"), teams: text("团队", "Teams") }
  const selected = model.projects.find(project => project.id === interaction.selectedProjectId) ?? null
  const completeDistribution = model.stateCounts.length > 0 && model.stateCounts.every(entry => entry.count.value !== null)
  const totalStates = completeDistribution ? model.stateCounts.reduce((sum, entry) => sum + entry.count.value!, 0) : null
  const issueScope = interaction.selectedProjectId ? { projectId: interaction.selectedProjectId } : undefined
  const openIssues = (filter?: Parameters<typeof actions.openIssues>[0]) => actions.openIssues({ ...issueScope, ...filter })
  const metricAction = (key: keyof typeof labels) => key === "projects" ? undefined : key === "members" || key === "teams" ? actions.openPeople : () => openIssues(key === "overdue" ? { overdue: true } : key === "completed" ? { completed: true } : undefined)
  const commonMetricScope = model.counts.issues.description === model.counts.projects.description && model.counts.completed.description === model.counts.projects.description && model.counts.overdue.description === model.counts.projects.description ? model.counts.projects.description : null
  const commonStateScope = model.stateCounts.length > 0 && model.stateCounts.every(entry => entry.count.description === model.stateCounts[0].count.description) ? model.stateCounts[0].count.description : null
  const scopeCaption = (description: string | null) => description ? <p className={sharedStyles.scopeCaption}>{description}</p> : null
  const metrics = (keys: readonly (keyof typeof labels)[]) => {
    const first = keys[0]
    const commonScope = first && keys.every(key => model.counts[key].description === model.counts[first].description) ? model.counts[first].description : null
    return <>{keys.map(key => <AvailableMetric key={key} label={labels[key]} count={model.counts[key]} showDescription={!commonScope} onOpen={metricAction(key)} />)}{scopeCaption(commonScope)}</>
  }
  const heading = (title: string) => <h2 className="mb-3 text-base font-medium">{title}</h2>
  const quickActions = <><Button variant="outline" disabled={!props.capabilities.createProject} onClick={event => actions.createProject(event.currentTarget)}><FolderKanban aria-hidden="true" />{text("新建项目", "New project")}</Button><Button variant="outline" disabled={!props.capabilities.createIssue} onClick={event => actions.createIssue(event.currentTarget)}><Plus aria-hidden="true" />{text("新建任务", "New issue")}</Button><Button variant="outline" onClick={() => openIssues()}><SquareCheck aria-hidden="true" />{text("任务工作区", "Issue workspace")}</Button><Button variant="outline" onClick={actions.openPeople}><Users aria-hidden="true" />{text("成员与团队", "Members & teams")}</Button></>
  const issues = <div>{model.issues.map(item => <WorkItemRow key={item.id} item={item} catalog={model.catalog} visibleProperties={["state", "priority", "assignees", "dueDate"]} today={model.today} onOpen={() => actions.openIssue(item)} />)}</div>
  const projects = <DataTable rows={model.projects} getRowId={project => project.id} getRowLabel={project => project.title} caption={text("项目任务汇总", "Project issue summary")} activeRowId={interaction.selectedProjectId} onActivateRow={project => actions.openProject(project.id)} columns={[
    { id: "name", header: labels.projects, primary: true, cell: project => <span className="block min-w-0 truncate" title={project.title}><code className="mr-2 text-xs text-muted-foreground">{project.identifier}</code>{project.title}</span> },
    { id: "state", header: text("状态", "Status"), cell: project => <Badge tone={project.status?.tone ?? "neutral"}>{project.status?.label ?? "—"}</Badge> },
    { id: "tasks", header: text("已关闭 / 总任务", "Closed / total issues"), cell: project => project.taskCounts ? `${project.taskCounts.closed}/${project.taskCounts.total}` : "—" },
    { id: "date", header: text("目标日期", "Target date"), cell: project => <time>{project.dueDate ?? "—"}</time> },
    { id: "owner", header: text("负责人", "Owner"), cell: project => project.owner?.name ?? "—" },
  ]} />
  const distribution = <section className={sharedStyles.distribution}>{heading(text("任务状态分布", "Issue status distribution"))}{scopeCaption(commonStateScope)}<div className={sharedStyles.distributionList} tabIndex={0} aria-label={text("任务状态分布滚动区域", "Issue status distribution scroll area")}>{model.stateCounts.map(entry => <Button key={entry.id} variant="ghost" className={sharedStyles.distributionItem} onClick={() => openIssues({ stateId: entry.id })}><span className="flex justify-between gap-3 text-xs"><span className={sharedStyles.distributionLabel}>{entry.label}</span><strong className={`${sharedStyles.distributionCount} tabular-nums`}>{entry.count.value ?? "—"}</strong></span>{totalStates !== null && totalStates > 0 && <span className="block h-2 bg-surface-raised" aria-hidden="true"><span className="block h-2 bg-primary" style={{ width: `${entry.count.value! / totalStates * 100}%` }} /></span>}{!commonStateScope && <span className="text-xs text-muted-foreground">{entry.count.description}</span>}</Button>)}</div>{!completeDistribution && <p className={sharedStyles.scopeCaption}>{model.unavailableDescription}</p>}</section>
  const timelineStart = startOfScheduleWeek(model.today, 1)
  const timeline = <Timeline items={model.issues.map(item => ({ ...item, startDate: item.startDate ?? null, label: item.title, canShift: false, canResizeStart: false, canResizeEnd: false }))} viewport={{ anchorDate: model.today, rangeStart: timelineStart, rangeEnd: addScheduleDays(timelineStart, 27), timeZone: "UTC", weekStartsOn: 1 }} today={model.today} scale="month" queryKey={`dashboard:${variant}:${model.data.updatedAt ?? "unavailable"}`} dayWidth={20} renderSidebar={item => <Button variant="ghost" className="max-w-full justify-start truncate" title={item.title} onClick={() => actions.openIssue(item)}>{item.identifier} · {item.title}</Button>} onEdit={actions.openIssue} />
  const scheduleCoverage = <div className={d3.rowList}>{model.issues.map(item => <div key={item.id} className={d3.milestoneRow}><Button variant="ghost" className={d3.rowLink} onClick={() => actions.openIssue(item)}><span className={d3.rowTitle}>{item.title}</span><span className={d3.identifier}>{item.identifier}</span></Button><time>{item.dueDate ?? text("未排期", "Unscheduled")}</time></div>)}</div>
  const milestones = <section className={d3.card}>{heading(text("项目目标日期", "Project target dates"))}<div className={d3.rowList}>{model.projects.map(project => <div key={project.id} className={d3.milestoneRow}><Button variant="ghost" className={d3.rowLink} onClick={() => actions.openProject(project.id)}><span className={d3.rowTitle}>{project.title}</span><span className={d3.identifier}>{project.identifier}</span></Button><time>{project.dueDate ?? "—"}</time></div>)}</div></section>
  const projectCards = <section>{heading(labels.projects)}<div className={d2.projectCards}>{model.projects.map(project => <div key={project.id} className="min-w-0 rounded-lg border bg-surface p-4"><Button variant="ghost" className="max-w-full justify-start truncate" title={project.title} onClick={() => actions.openProject(project.id)}>{project.title}</Button><p className="mt-2 text-xs text-muted-foreground">{project.identifier} · {project.status?.label ?? "—"}</p><p className="mt-3 text-sm">{project.owner?.name ?? "—"}</p><time className="mt-2 block text-xs">{project.dueDate ?? "—"}</time></div>)}</div></section>
  const currentProject = <section>{heading(text("当前项目", "Current project"))}<div className="grid gap-2">{model.projects.map(project => <Button key={project.id} variant="ghost" className="justify-start truncate" title={project.title} aria-pressed={selected?.id === project.id} onClick={() => actions.setInteraction(previous => ({ ...previous, selectedProjectId: project.id }))}>{project.title}</Button>)}</div>{selected && <div className="mt-4 border-t pt-4"><Button variant="outline" onClick={() => actions.openProject(selected.id)}>{text("打开项目", "Open project")}</Button><p className="mt-3 whitespace-pre-wrap break-words text-sm">{selected.description ?? "—"}</p><p className="mt-3 text-xs text-muted-foreground">{text("负责人", "Owner")}: {selected.owner?.name ?? "—"}</p></div>}</section>
  const activity = <section>{heading(text("动态", "Activity"))}<ControlledActivity entries={model.activity} /></section>
  const people = <section>{heading(text("工作区成员", "Workspace people"))}<div className="grid gap-3">{metrics(["members", "teams"])}</div><p className="mt-3 text-xs text-muted-foreground">{model.unavailableDescription}</p></section>
  const defaultToolbar = <div className="flex items-center gap-3 py-3"><PmSearch value={interaction.query} onChange={query => actions.setInteraction(previous => ({ ...previous, query }))} label={text("搜索当前工作区", "Search this workspace")} /><span className="text-xs text-muted-foreground">{model.unavailableDescription}</span></div>
  const defaultHeaderActions = <Button variant="ghost" size="sm" disabled={model.data.refreshing || model.data.state === "loading"} onClick={actions.refresh}><RefreshCw aria-hidden="true" />{text("刷新", "Refresh")}</Button>
  const headerActions = props.headerActions === undefined ? defaultHeaderActions : props.headerActions
  const toolbar = props.toolbar === undefined ? (variant === "dashboard4" ? <div data-pm-toolbar className={d4.shortcuts}><nav className={d4.quickActions} aria-label={text("项目工作区入口", "Project workspace shortcuts")}>{quickActions}</nav></div> : defaultToolbar) : props.toolbar
  const pageClass = `${sharedStyles.page} ${variant === "dashboard1" ? d1.page : variant === "dashboard2" ? d2.page : variant === "dashboard3" ? d3.page : d4.page}`
  return <ControlledFocus surface={props}><PmPage interactive={props.interactive} pageId={props.pageId ?? `pm-controlled-${variant}`} title={model.title} titleIcon={variant === "dashboard1" ? <UserRoundCheck size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : undefined} description={model.description} className={pageClass} navigation={props.navigation} headerMode={variant === "dashboard4" ? "hidden" : "default"} headerPlacement={variant === "dashboard2" || variant === "dashboard3" ? "scroll" : "fixed"} readingPosition={props.readingPosition} onReadingPositionChange={props.onReadingPositionChange} actions={variant === "dashboard4" ? undefined : headerActions} toolbar={variant === "dashboard4" ? undefined : toolbar}>
    {variant === "dashboard4" && <><header className={d4.header} data-pm-header><div className={d4.heading}><p className={d4.eyebrow}><FolderKanban size={14} aria-hidden="true" />{text("工作区", "Workspace")} / {text("项目交付", "Project Delivery")}</p><h1 title={model.title}>{model.title}</h1><p>{model.description}</p></div>{headerActions}</header>{toolbar}</>}
    <ControlledFeedback surface={props} />
    <DataRegion {...model.data} hasContent={model.projects.length > 0 || model.issues.length > 0 || Object.values(model.counts).some(count => count.value !== null)}>
      {variant === "dashboard1" && <div className={d1.layout}><div className={d1.mainColumn}>
        {region("metrics", <section>{heading(text("概览", "Overview"))}<div className={d1.stats}>{metrics(["projects", "issues", "overdue"])}</div></section>)}
        {region("distribution", <section>{heading(text("任务状态", "Issue status"))}<div className={d1.statusStats}>{model.stateCounts.map(entry => <AvailableMetric key={entry.id} label={entry.label} count={entry.count} showDescription={!commonStateScope} onOpen={() => openIssues({ stateId: entry.id })} />)}{scopeCaption(commonStateScope)}</div></section>)}
        {region("timeline", <section>{heading(text("任务排期", "Issue schedule"))}{timeline}</section>)}
        {region("projects", <section>{heading(labels.projects)}{projects}</section>)}
        {region("cards", null)}
        {region("issues", <section>{heading(text("工作区任务", "Workspace issues"))}{issues}</section>)}
      </div>{region("rail", <aside className={d1.aside}><div className="space-y-6 p-5">{region("currentProject", currentProject)}{region("activity", activity)}</div></aside>)}</div>}
      {variant === "dashboard2" && <div className={d2.layout}><div className={d2.main}>
        {region("metrics", <><nav className={d2.quickActions}>{quickActions}</nav><div className={d2.stats}>{metrics(["projects", "issues", "completed", "overdue"])}</div></>)}
        {region("timeline", <section className={d2.panel}>{heading(text("任务排期", "Issue schedule"))}{timeline}</section>)}
        {region("cards", projectCards)}
        {region("projects", null)}
        {region("distribution", <div className={d2.lowerGrid}><section className={d2.panel}>{distribution}</section><section className={d2.panel}>{region("currentProject", currentProject)}</section></div>)}
        {region("issues", <section>{heading(labels.issues)}{issues}</section>)}
      </div>{region("rail", <aside className={d2.rail}><section className={d2.panel}>{region("activity", activity)}</section><section className={d2.panel}>{people}</section></aside>)}</div>}
      {variant === "dashboard3" && <div className={d3.layout}>
        {region("metrics", <section><div className={d3.summaryStrip}>{Object.entries(labels).map(([key, label]) => { const metricKey = key as keyof typeof labels; const count = model.counts[metricKey]; const content = <><p>{label}</p><strong>{count.value ?? "—"}</strong>{(!commonMetricScope || metricKey === "members" || metricKey === "teams") && <span>{count.description}</span>}</>; const onOpen = metricAction(metricKey); return onOpen ? <Button variant="ghost" className={d3.stat} key={key} onClick={onOpen}>{content}</Button> : <div className={d3.stat} key={key}>{content}</div> })}</div>{scopeCaption(commonMetricScope)}</section>)}
        <div className={d3.topGrid}>{region("timeline", <section className={d3.card}>{heading(text("排期覆盖", "Schedule coverage"))}{scheduleCoverage}</section>)}{region("cards", <section className={d3.card}>{distribution}</section>)}{region("currentProject", <section className={d3.card}><div className={d3.rowList}>{currentProject}</div></section>)}</div>
        <div className={d3.bottomGrid}>{region("projects", milestones)}{region("rail", <section className={d3.card}><div className={d3.rowList}>{people}</div></section>)}{region("activity", <section className={d3.card}><div className={d3.rowList}>{activity}</div></section>)}</div>
        {region("distribution", <section className={d3.detailsCard}>{heading(text("项目任务明细", "Project issue details"))}{projects}</section>)}
        {region("issues", <section className={d3.detailsCard}>{heading(labels.issues)}{issues}</section>)}
      </div>}
      {variant === "dashboard4" && <div className={d4.layout}><div className={d4.main}>
        {region("metrics", null)}
        {region("timeline", <section className={d4.canvasCard} aria-label={text("依赖画布", "Dependency canvas")} data-pm-dashboard4="canvas-card"><div className={d4.canvas} data-pm-dashboard4="canvas">{model.dependencyMap ? <WorkflowCanvas {...model.dependencyMap} /> : <p className="p-5 text-sm text-muted-foreground">{model.dependencyDescription}</p>}</div><p className="mt-3 text-xs text-muted-foreground">{model.dependencyDescription}</p></section>)}
        {region("projects", <section className={d4.tableCard}>{heading(text("项目任务汇总", "Project issue summary"))}{projects}</section>)}
        {region("cards", null)}{region("issues", null)}
      </div>{props.showRail !== false && region("rail", <aside className={d4.rail}><section className={d4.panel}>{region("distribution", distribution)}</section><section className={d4.panel}>{region("currentProject", currentProject)}</section><section className={d4.panel}>{region("activity", activity)}</section></aside>)}</div>}
    </DataRegion>
    {props.createDialog}
  </PmPage></ControlledFocus>
}
