import { FileText, Link2, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { pmClock, pmMembers, type PmPageProps } from "./model"
import { usePmScenarioState } from "./shared"
import { usePmControlsReady, usePmNavigation } from "./domain-session"
import { appendProjectComment, healthBand, projectComments, projectFiles, projectIssueStats } from "./projects-domain"
import { canMutatePmProject, ProjectBriefSection, ProjectCommentsPanel, ProjectFileList, ProjectIssueSummary, ProjectMetaChips, ProjectMetadataPanel, ProjectMetricsStrip, ProjectOverviewPanel, usePmProjectDomain } from "./projects-views"
import { ProjectActivityPanel, ProjectDependenciesPanel, ProjectDetailRail, ProjectIssuesPanel, ProjectTasksPanel, ProjectTimelinePanel } from "./project-detail-2-panels"
import { fixtureCatalogProjection, fixtureIssueProjection, fixtureProjectProjection, useFixtureReadState } from "./fixture-projections"
import { patchIssueDomain, reconcileIssueDomain } from "./issue-domain"
import { useIssueDomain } from "./use-issue-domain"
import { ProjectDetailView } from "./project-detail"
import type { ProjectDetailViewProps } from "./controlled-contracts"
import styles from "./projects-views.module.css"

type Tab = ProjectDetailViewProps["interaction"]["tab"]
type FixtureTabs = { active: Tab; visited: Tab[]; scrolls?: Partial<Record<Tab, number>> }
type FixtureDetailState = { metaOpen: boolean; copy: "idle" | "ok" | "fail" }

/** Local scenario/controller glue only; both showcases mount the controlled core. */
export function FixtureProjectDetail({ scenario, variant }: PmPageProps & { variant: "detail1" | "detail2" }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const interactive = usePmControlsReady()
  const brief = variant === "detail1"
  const { navigate, back, entityId } = usePmNavigation()
  const { projects, issues, issueActivity, family, setFamily } = usePmProjectDomain(scenario)
  const [issueDomain, setIssueDomain] = useIssueDomain(scenario)
  const data = useFixtureReadState(scenario, variant)
  const [view, setView] = usePmScenarioState<FixtureDetailState>(`${variant}-view`, () => ({ metaOpen: window.matchMedia("(min-width: 1280px)").matches, copy: "idle" }))
  const [tabs, setTabs] = usePmScenarioState<FixtureTabs>(brief ? "detail1-tabs" : "detail2-tab", () => ({ active: brief ? "timeline" : "overview", visited: [brief ? "timeline" : "overview"] }))
  const prefix = brief ? "pm-detail1" : "pm-detail2"
  const interaction = { tab: tabs.active, metadataOpen: view.metaOpen }
  const setInteraction: ProjectDetailViewProps["actions"]["setInteraction"] = (action) => {
    const next = typeof action === "function" ? action(interaction) : action
    if (next.metadataOpen !== view.metaOpen) setView((previous) => ({ ...previous, metaOpen: next.metadataOpen }))
    if (next.tab === tabs.active) return
    const scroll = document.getElementById(`${prefix}-panel-${tabs.active}`)?.closest<HTMLElement>("[data-pm-scroll]")
    setTabs((previous) => ({ active: next.tab, visited: previous.visited.includes(next.tab) ? previous.visited : [...previous.visited, next.tab], scrolls: { ...previous.scrolls, [previous.active]: scroll?.scrollTop ?? 0 } }))
  }
  const project = entityId ? projects.find((candidate) => candidate.id === entityId) : projects[0]
  const missing = !!entityId && projects.length > 0 && !project
  const stats = projectIssueStats(issues, project?.id ?? "")
  const ownIssues = issues.filter((issue) => issue.projectId === project?.id)
  const files = project ? projectFiles(family, project.id) : []
  const comments = project ? projectComments(family, project.id) : []
  const canMutate = canMutatePmProject(scenario)
  const band = healthBand(project?.health ?? null)
  const completedShare = stats.total > 0 ? Math.round(stats.done / stats.total * 100) : null
  const copyLink = () => {
    if (!navigator.clipboard) {
      setView((previous) => ({ ...previous, copy: "fail" }))
      return
    }
    navigator.clipboard.writeText(window.location.href)
      .then(() => setView((previous) => ({ ...previous, copy: "ok" })))
      .catch(() => setView((previous) => ({ ...previous, copy: "fail" })))
  }
  return <ProjectDetailView
    variant={variant}
    interactive={interactive}
    tabs={brief ? ["timeline", "tasks", "issues", "activity"] : undefined}
    interaction={interaction}
    readingPosition={tabs.scrolls?.[tabs.active] ?? 0}
    onReadingPositionChange={(top) => setTabs((previous) => ({ ...previous, scrolls: { ...previous.scrolls, [previous.active]: top } }))}
    readModel={{
      project: project && scenario !== "loading" ? { ...fixtureProjectProjection(project, issues, locale), teamId: project.teamId } : null,
      issues: scenario === "loading" ? [] : ownIssues.map((item) => fixtureIssueProjection(item, locale)),
      catalog: fixtureCatalogProjection(issues, projects, locale),
      activity: scenario === "loading" ? [] : [
        ...family.activity.filter((entry) => entry.projectId === project?.id).map((entry) => ({ id: entry.id, actor: pmMembers.find((member) => member.id === entry.actorId)?.name ?? "—", description: entry.title[locale], at: entry.at, kind: "update" as const })),
        ...comments.map((entry) => ({ id: entry.id, actor: pmMembers.find((member) => member.id === entry.authorId)?.name ?? "—", description: entry.body[locale], at: entry.createdAt, kind: "comment" as const })),
      ],
      attachments: scenario === "loading" ? [] : files.map((file) => ({ id: file.id, name: file.name, description: file.content[locale], sizeLabel: file.size })),
      counts: {
        total: { value: scenario === "loading" ? null : stats.total, description: en ? "Shared project issues" : "共享项目 Issue" },
        completed: { value: scenario === "loading" ? null : stats.done, description: en ? "Completed issues" : "已完成 Issue" },
        overdue: { value: scenario === "loading" ? null : ownIssues.filter((item) => item.dueDate && item.dueDate < pmClock.slice(0, 10) && item.stateId !== "done").length, description: en ? "Overdue open issues" : "已逾期的未完成 Issue" },
        members: { value: scenario === "loading" ? null : project?.teamSize ?? null, description: en ? "Project members" : "项目成员" },
      },
      data: { ...data, state: !project && data.state === "success" ? "empty" : data.state, emptyTitle: missing ? en ? "Unknown project reference" : "未知的项目引用" : undefined, emptyHeadingLevel: 2, emptyDescription: missing ? en ? `No shared project matches the entity id “${entityId}”. Nothing is fabricated for missing references.` : `共享项目中没有与实体 ID “${entityId}” 匹配的记录。缺失引用不会被伪造。` : en ? "This scene has no project to open." : "当前场景没有可打开的项目。" },
      today: pmClock.slice(0, 10),
    }}
    capabilities={{ edit: canMutate, createIssue: false, attach: false, dependency: false }}
    actions={{
      back: () => back("project-list-4"),
      edit: () => { setView((previous) => ({ ...previous, metaOpen: true })); document.querySelector<HTMLElement>("[data-pm-project-meta] [tabindex='-1']")?.focus() },
      setInteraction,
      openIssue: (item) => navigate("issue-detail-1", item.id),
      createIssue: (projectId) => navigate("issue-list-1", projectId),
      patchIssue: (item, patch) => {
        if (!canMutate) return
        const { moduleIds, cycleId, estimatePointId, ...fields } = patch
        if (moduleIds !== undefined || cycleId !== undefined || estimatePointId !== undefined) throw new Error("Project detail fixture panels do not edit issue catalog relations")
        setIssueDomain((previous) => patchIssueDomain(previous, item.id, fields, "confirmed", item.revision))
      },
      issueCapabilities: { canCreate: false, canEditField: () => false, canMove: () => false, canEditRelation: () => false, reason: en ? "Use the explicit fixture panels to inspect project issues." : "通过显式 fixture 面板查看项目 Issue。" },
      attach: () => { throw new Error("Project fixture file actions support preview and download, not upload") },
      openAttachment: (id) => {
        const file = files.find((candidate) => candidate.id === id)
        if (file?.status === "available") {
          const url = URL.createObjectURL(new Blob([file.content[locale]], { type: "text/markdown" }))
          const anchor = document.createElement("a")
          anchor.href = url
          anchor.download = file.name
          anchor.click()
          URL.revokeObjectURL(url)
        }
      },
      reconcile: (operationId) => {
        const request = Object.values(issueDomain.requests).find((entry) => entry?.operationId === operationId)
        if (request && canMutate) setIssueDomain((previous) => reconcileIssueDomain(previous, request.itemId))
      },
    }}
    headerActions={<>
      {project && <Button variant="outline" size="icon" aria-label={brief ? en ? "Open workspace" : "打开工作区" : en ? "Open brief" : "打开简报"} onClick={() => navigate(brief ? "project-detail-2" : "project-detail-1", project.id)}>{brief ? <Zap aria-hidden="true" /> : <FileText aria-hidden="true" />}</Button>}
      {brief && <Button variant="ghost" size="icon" aria-label={en ? "Copy link" : "复制链接"} onClick={copyLink}><Link2 aria-hidden="true" /></Button>}
    </>}
    feedback={view.copy !== "idle" ? <p role="status" className={styles.muted}>{view.copy === "ok" ? en ? "Link copied locally." : "已在本地复制链接。" : en ? "Copying is unavailable in this browser." : "此浏览器不支持复制链接。"}</p> : undefined}
    regions={project ? {
      chips: <ProjectMetaChips project={project} />,
      metadata: <>{brief && <ProjectMetadataPanel key={project.id} project={project} scenario={scenario} />}<ProjectDetailRail project={project} stats={stats} family={family} issues={ownIssues} variant={brief ? "brief" : "workspace"} onOpenComments={!brief ? () => setInteraction((previous) => ({ ...previous, tab: "comments" })) : undefined} /></>,
      metrics: <><ProjectMetricsStrip project={project} stats={stats} fileCount={files.length} />{!brief && <><p className={styles.confidence} data-pm-confidence><strong>{en ? "Delivery confidence:" : "交付信心："}</strong>{" "}{band.label[locale]} · {stats.total > 0 ? en ? `${completedShare}% completed` : `已完成 ${completedShare}%` : en ? "completion unknown without issues" : "无 Issue 时完成度未知"}{project.dueDate ? ` · ${en ? `target ${project.dueDate}` : `目标 ${project.dueDate}`}` : ` · ${en ? "no target date" : "无目标日期"}`}</p><ProjectIssueSummary stats={stats} onReview={() => setInteraction((previous) => ({ ...previous, tab: "dependencies" }))} /></>}</>,
      overview: brief ? <ProjectBriefSection project={project} /> : <ProjectOverviewPanel project={project} family={family} />,
      attachments: <ProjectFileList projectId={project.id} files={files} canMutate={canMutate} />,
      tasks: <ProjectTasksPanel issues={ownIssues} />,
      issues: <ProjectIssuesPanel issues={ownIssues} />,
      dependencies: <ProjectDependenciesPanel projectId={project.id} family={family} issues={issues} />,
      timeline: <ProjectTimelinePanel issues={ownIssues} variant={brief ? "brief" : "workspace"} />,
      activity: <ProjectActivityPanel projectId={project.id} family={family} issues={issues} activity={issueActivity} />,
      comments: <ProjectCommentsPanel key={project.id} projectId={project.id} comments={comments} canMutate={canMutate} onAppend={(comment) => setFamily((previous) => appendProjectComment(previous, comment))} />,
    } : undefined}
  />
}
