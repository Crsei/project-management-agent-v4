import { useLayoutEffect, useRef, useState } from "react"
import { ChevronRight, Clock3, FileText, FolderKanban, Layers, PanelRightClose, PanelRightOpen, Paperclip, Plus, Users, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataRegion } from "@/components/ui/data-region"
import { MessageContent } from "@/components/blocks/message-content"
import { WorkItemRow } from "@/components/blocks/work-item"
import { Timeline } from "@/components/blocks/timeline"
import { isMutationLocked } from "@/lib/work-items-model"
import { addScheduleDays, startOfScheduleWeek } from "@/lib/schedule-date-utils"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage } from "./presentation-page"
import { ControlledActivity, ControlledAttachments, ControlledFeedback, ControlledFocus, ControlledMutation } from "./controlled-presentation"
import type { ProjectDetailViewProps } from "./controlled-contracts"
import styles from "./projects-views.module.css"
import detailOneStyles from "./project-detail-1.module.css"
import detailTwoStyles from "./project-detail-2.module.css"

const workspaceTabs = ["overview", "tasks", "issues", "dependencies", "timeline", "activity", "comments"] as const

/** Presentation only: hosts supply authoritative records and every writing action. */
export function ProjectDetailView(props: ProjectDetailViewProps) {
  const { readModel: model, interaction, actions, capabilities, regions } = props
  const { locale } = useI18n()
  const en = locale === "en"
  const brief = props.variant === "detail1"
  const variantStyles = brief ? detailOneStyles : detailTwoStyles
  const project = model.project
  const locked = isMutationLocked(model.mutation) || !project
  const tabs = props.tabs ?? workspaceTabs
  const activeTab = tabs.includes(interaction.tab) ? interaction.tab : tabs[0] ?? interaction.tab
  const prefix = brief ? "pm-detail1" : "pm-detail2"
  const [visited, setVisited] = useState(() => ({ projectId: project?.id, tabs: new Set([activeTab]) }))
  if (visited.projectId !== project?.id) setVisited({ projectId: project?.id, tabs: new Set([activeTab]) })
  else if (!visited.tabs.has(activeTab)) setVisited({ ...visited, tabs: new Set([...visited.tabs, activeTab]) })
  const tabRefs = useRef<Partial<Record<ProjectDetailViewProps["interaction"]["tab"], HTMLButtonElement | null>>>({})
  const toggleRef = useRef<HTMLButtonElement>(null)
  const metadataRef = useRef<HTMLElement>(null)
  const previousMetadata = useRef(interaction.metadataOpen)
  useLayoutEffect(() => {
    if (previousMetadata.current === interaction.metadataOpen) return
    previousMetadata.current = interaction.metadataOpen
    if (interaction.metadataOpen) {
      const heading = metadataRef.current?.querySelector<HTMLElement>('[tabindex="-1"]')
      ;(heading ?? metadataRef.current)?.focus()
    } else toggleRef.current?.focus()
  }, [interaction.metadataOpen])
  const labels = { overview: en ? "Overview" : "概览", board: en ? "Board" : "看板", list: en ? "List" : "列表", table: en ? "Table" : "表格", calendar: en ? "Calendar" : "日历", timeline: en ? "Timeline" : "时间线", tree: en ? "Tree" : "树形图", graph: en ? "Graph" : "关系图", files: en ? "Files" : "文件", tasks: en ? "Tasks" : "任务", issues: en ? "Issues" : "Issue", dependencies: en ? "Dependencies" : "依赖", activity: en ? "Activity" : "动态", comments: en ? "Comments" : "评论" }
  const facts = project ? [
    [en ? "Identifier" : "编号", project.identifier],
    [en ? "Owner" : "负责人", project.owner?.name ?? "—"],
    [en ? "Status" : "状态", project.status?.label ?? "—"],
    [en ? "Health" : "健康度", project.health === null ? "—" : `${project.health}%`],
    [en ? "Budget" : "预算", project.budget === null ? "—" : String(project.budget)],
    [en ? "Start date" : "开始日期", project.startDate ?? "—"],
    [en ? "Target date" : "目标日期", project.dueDate ?? "—"],
    [en ? "Updated" : "最近更新", project.updatedAt ?? "—"],
  ] : []
  const metrics = [
    { label: en ? "Issues" : "任务", count: model.counts.total },
    { label: en ? "Completed" : "已完成", count: model.counts.completed },
    { label: en ? "Overdue" : "已逾期", count: model.counts.overdue },
    { label: en ? "Members" : "成员", count: model.counts.members },
  ]
  const timelineStart = startOfScheduleWeek(model.today, 1)
  const briefSection = <section className={styles.section} data-pm-project-brief>
    <h2 className={styles.sectionTitle}>{en ? "Project brief" : "项目简报"}</h2>
    {project?.description ? <MessageContent content={project.description} className={styles.brief} /> : <p className={styles.muted}>{en ? "No project description." : "暂无项目描述。"}</p>}
  </section>
  const attachments = regions?.attachments !== undefined ? regions.attachments : <section className={styles.section}>
    <div className="flex items-center justify-between gap-3"><h2 className={styles.sectionTitle}>{en ? "Files" : "文件"}</h2><Button variant="ghost" size="sm" disabled={!capabilities.attach || locked} onClick={(event) => actions.attach(event.currentTarget)}><Paperclip aria-hidden="true" />{en ? "Upload" : "上传"}</Button></div>
    <ControlledAttachments entries={model.attachments} onOpen={actions.openAttachment} />
  </section>
  const renderPanel = (tab: ProjectDetailViewProps["interaction"]["tab"]) => {
    if (regions?.[tab] !== undefined) return regions[tab]
    if (tab === "overview") return <div data-pm-overview-panel className={styles.panelStack}>
      {briefSection}
      <section className={styles.section}><h2 className={styles.sectionTitle}>{en ? "Issue completion ratio" : "任务完成率"}</h2><p className="text-sm">{model.counts.completed.value !== null && model.counts.total.value !== null && model.counts.total.value > 0 ? `${Math.round(model.counts.completed.value / model.counts.total.value * 100)}%` : "—"}</p><p className={styles.muted}>{model.counts.total.description}</p></section>
      {attachments}
    </div>
    if (tab === "tasks" || tab === "issues") return <>
      <div className="mb-3 flex justify-end"><Button disabled={!capabilities.createIssue || locked} onClick={(event) => project && actions.createIssue(project.id, event.currentTarget)}><Plus aria-hidden="true" />{en ? "Add issue" : "新建任务"}</Button></div>
      <div>{model.issues.map((item) => <WorkItemRow key={item.id} item={item} catalog={model.catalog} capabilities={actions.issueCapabilities} visibleProperties={["state", "priority", "assignees", "dueDate"]} today={model.today} onOpen={() => actions.openIssue(item)} onPatchItem={(_record, patch) => actions.patchIssue(item, patch)} />)}</div>
    </>
    if (tab === "dependencies") return props.dependencyPanel ?? <p className={styles.muted}>{en ? "No dependency projection is available." : "暂无可用的依赖数据。"}</p>
    if (tab === "board" || tab === "list" || tab === "table" || tab === "calendar" || tab === "tree" || tab === "graph") return <p className={styles.muted}>{en ? "This project view is unavailable." : "此项目视图暂不可用。"}</p>
    if (tab === "timeline") return <Timeline
      queryKey={`project:${project?.id}:${project?.version}`}
      items={model.issues.map((item) => ({ ...item, startDate: item.startDate ?? null, label: item.title, canShift: !locked && actions.issueCapabilities.canEditField(item, "startDate") && actions.issueCapabilities.canEditField(item, "dueDate"), canResizeStart: !locked && actions.issueCapabilities.canEditField(item, "startDate"), canResizeEnd: !locked && actions.issueCapabilities.canEditField(item, "dueDate") }))}
      viewport={{ anchorDate: model.today, timeZone: "UTC", weekStartsOn: 1, rangeStart: timelineStart, rangeEnd: addScheduleDays(timelineStart, 41) }}
      scale="week" today={model.today} dayWidth={32}
      renderSidebar={(item) => <Button variant="ghost" className="max-w-full justify-start truncate" onClick={() => actions.openIssue(item)}>{item.title}</Button>}
      onDateChange={(change) => { const item = model.issues.find((candidate) => candidate.id === change.id); if (item && !locked) actions.patchIssue(item, { startDate: change.nextDates.startDate, dueDate: change.nextDates.dueDate }) }}
    />
    if (tab === "activity") return <ControlledActivity entries={model.activity} />
    return <><ControlledActivity entries={model.activity.filter((entry) => entry.kind === "comment")} />{props.commentEditor}</>
  }
  return <ControlledFocus surface={props}>
    <PmPage interactive={props.interactive} pageId={brief ? "pm-project-detail-1" : "pm-project-detail-2"}
    title={project?.title ?? (en ? "Project" : "项目")}
    headerMode="hidden"
    className={`${brief ? styles.detail1Page : styles.detail2Page} ${variantStyles.page}`}
    contentClassName={`${styles.listContent} ${variantStyles.content}`}
    readingPosition={props.readingPosition}
    onReadingPositionChange={props.onReadingPositionChange}
    sidebarPlacement="right"
    sidebar={interaction.metadataOpen && project ? <aside ref={metadataRef} tabIndex={0} className={variantStyles.metadata} aria-label={en ? "Project metadata" : "项目元数据"}>
      <div data-pm-metadata-drawer-header><h2>{en ? "Project details" : "项目属性"}</h2></div>
      <Button variant="ghost" size="icon" className={variantStyles.metadataClose} aria-label={en ? "Close project details" : "关闭项目属性"} onClick={() => actions.setInteraction((previous) => ({ ...previous, metadataOpen: false }))}><X aria-hidden="true" /></Button>
      {regions?.metadata !== undefined ? regions.metadata : <div className={styles.metaPanel}>
        <h2 tabIndex={-1} className={styles.sectionTitle}>{en ? "Project metadata" : "项目元数据"}</h2>
        <dl className={styles.metaFields}>{facts.map(([label, value]) => <div key={label} className={styles.metaField}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm break-words">{value}</dd></div>)}</dl>
      </div>}
    </aside> : undefined}>
      <div className={`${styles.detailCrumb} ${variantStyles.crumb}`}>
        <nav aria-label={en ? "Breadcrumb" : "面包屑"} className={variantStyles.breadcrumb}><Button id="pm-project-back" variant="ghost" size="sm" aria-label={en ? "Back to projects" : "返回项目列表"} onClick={actions.back}>{en ? "Projects" : "项目"}</Button>{brief ? <ChevronRight aria-hidden="true" /> : <><span>{project?.teamId}</span><span>/</span></>}<span aria-current="page">{project?.title}</span></nav>
        <div className={`${styles.headerActions} ${variantStyles.actions}`}>
          {props.headerActions !== undefined ? props.headerActions : <Button id="pm-project-edit" variant="secondary" disabled={!capabilities.edit || locked} onClick={(event) => actions.edit(event.currentTarget)}>{en ? "Edit project" : "编辑项目"}</Button>}
          <Button ref={toggleRef} id="pm-project-metadata-toggle" variant="ghost" size="icon" aria-expanded={interaction.metadataOpen} aria-label={interaction.metadataOpen ? en ? "Collapse meta panel" : "收起元数据面板" : en ? "Expand meta panel" : "展开元数据面板"} onClick={() => actions.setInteraction((previous) => ({ ...previous, metadataOpen: !previous.metadataOpen }))}>{interaction.metadataOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}</Button>
        </div>
      </div>
      <div className={`${styles.detailBody} ${variantStyles.body}`}>
        <header data-pm-detail-header className={variantStyles.header}>
          <h1 className={`${styles.detailTitle} ${variantStyles.title} break-words`}>{project?.title ?? (en ? "Project" : "项目")}</h1>
          {project && (regions?.chips !== undefined ? regions.chips : <div className={variantStyles.chips} data-pm-meta-chips>
            <ul className={styles.chips} data-pm-project-badges>
              <li><Badge tone={project.status?.tone ?? "neutral"} size="sm">{project.status?.label ?? "—"}</Badge></li>
              <li><Badge tone="neutral" size="sm"><Users size={12} aria-hidden="true" />{model.counts.members.value ?? "—"} {en ? "members" : "名成员"}</Badge></li>
              {project.teamId && <li><Badge tone="neutral" size="sm"><FolderKanban size={12} aria-hidden="true" />{project.teamId}</Badge></li>}
            </ul>
            <ul className={styles.chips} data-pm-project-facts>
              <li><FileText size={14} aria-hidden="true" />{project.identifier}</li>
              {project.cycle && <li><Layers size={14} aria-hidden="true" />{project.cycle.label}{project.cycleWeeks !== null ? ` · ${project.cycleWeeks} ${en ? "weeks" : "周"}` : ""}</li>}
              <li><Clock3 size={14} aria-hidden="true" />{project.updatedAt ?? "—"}</li>
              {project.owner && <li>{project.owner.name}</li>}
            </ul>
          </div>)}
        </header>
        <ControlledFeedback surface={props} />
        <DataRegion {...model.data} hasContent={!!project}>
          {project && <>
            {!props.metricsInOverview && (regions?.metrics !== undefined ? regions.metrics : <div className={styles.metrics} data-pm-project-metrics>{metrics.map(({ label, count }) => <div key={label} className={styles.metricCard}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{count.value ?? "—"}</strong><span className={styles.metricSub}>{count.description}</span></div>)}</div>)}
            <ControlledMutation mutation={model.mutation} reconcile={actions.reconcile} />
            {brief && !tabs.includes("overview") && <>{regions?.overview !== undefined ? regions.overview : briefSection}{attachments}</>}
            <div role="tablist" aria-label={brief ? en ? "Project delivery views" : "项目交付视图" : en ? "Project sections" : "项目分区"} className={`${styles.tabStrip} ${variantStyles.tabs}`} data-pm-brief-tabs={brief || undefined} data-pm-detail-tabs={!brief || undefined} onKeyDown={(event) => {
              const index = tabs.findIndex((tab) => tabRefs.current[tab] === document.activeElement)
              const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null
              if (!next) return
              event.preventDefault()
              tabRefs.current[next]?.focus()
            }}>
              {tabs.map((tab) => <button key={tab} ref={(element) => { tabRefs.current[tab] = element }} id={`${prefix}-tab-${tab}`} type="button" role="tab" aria-selected={activeTab === tab} aria-controls={`${prefix}-panel-${tab}`} tabIndex={activeTab === tab ? 0 : -1} className={`${styles.tab} ${variantStyles.tab}`} onClick={() => actions.setInteraction((previous) => ({ ...previous, tab }))}>{labels[tab]}{tab === "comments" && model.activity.some((entry) => entry.kind === "comment") && <span className={styles.muted}> {model.activity.filter((entry) => entry.kind === "comment").length}</span>}</button>)}
            </div>
            {props.toolbar}
            {tabs.filter((tab) => visited.tabs.has(tab)).map((tab) => <div key={tab} role="tabpanel" id={`${prefix}-panel-${tab}`} aria-labelledby={`${prefix}-tab-${tab}`} hidden={activeTab !== tab} data-hidden={activeTab !== tab || undefined} data-pm-brief-panel={brief ? tab : undefined} data-pm-detail-panel={!brief ? tab : undefined} tabIndex={0} className={`${styles.panel} ${variantStyles.panel}`}>{renderPanel(tab)}</div>)}
          </>}
        </DataRegion>
      </div>
      {props.editDialog}
    </PmPage>
  </ControlledFocus>
}
