import { useMemo, useState } from "react"
import { Navigate, useLocation, useNavigate, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MessageContent } from "@/components/blocks/message-content"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { usePmEntities, usePmEntity, useProjectDirectory } from "./pm-service"
import { string, today, useText } from "./pm-ui"
import { ProjectFilesPage } from "./project-files"
import { ProjectAuditHistory } from "./project-audit"
import { ProjectCoverEditor, ProjectScopeEditor } from "./project-extras"
import { ProjectTeamAssignment } from "./project-directory"
import { ProjectFinancialRegion, ProjectHealthRegion, ProjectPortfolioSummary } from "./project-portfolio"

const issueViewByLegacyTab: Record<string, string> = {
  board: "kanban",
  kanban: "kanban",
  list: "list",
  table: "table",
  calendar: "calendar",
  timeline: "gantt",
  gantt: "gantt",
  tree: "tree",
  graph: "graph",
  relationships: "graph",
}

/** Old detail-tab URLs now enter the issues workbench; no query tab page remains. */
export function ServiceProjectEntry() {
  const { projectId = "", workspaceSlug = "" } = useParams<{ projectId: string; workspaceSlug: string }>()
  const location = useLocation()
  const projectTab = useWorkspaceStore(state => state.projectTab)
  const params = new URLSearchParams(location.search)
  const tab = params.get("tab")
  const root = `/pm/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}`
  if (tab === "overview") return <Navigate to={`${root}/overview`} replace />
  if (tab === "files") return <Navigate to={`${root}/files`} replace />
  if (tab === "activity") return <Navigate to={`${root}/activity`} replace />
  const taskView = params.get("taskView")
  const view = tab
    ? issueViewByLegacyTab[tab] ?? issueViewByLegacyTab[projectTab] ?? "kanban"
    : taskView === "list" || taskView === "table"
      ? taskView
      : issueViewByLegacyTab[projectTab] ?? "kanban"
  const search = new URLSearchParams({ view })
  const returnTo = params.get("returnTo")
  if (returnTo) search.set("returnTo", returnTo)
  return <Navigate to={`${root}/issues?${search}`} replace />
}

function ProjectMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0 rounded-module border bg-surface p-3"><span className="text-xs text-muted-foreground">{label}</span><strong className="mt-1 block text-xl font-semibold tabular-nums">{value}</strong><span className="mt-1 block text-xs text-muted-foreground">{detail}</span></div>
}

export function ServiceProjectOverview() {
  const { projectId = "", workspaceSlug = "" } = useParams<{ projectId: string; workspaceSlug: string }>()
  const projectQuery = usePmEntity(projectId)
  const items = usePmEntities("work_item", projectId)
  const milestones = usePmEntities("milestone", projectId)
  const directory = useProjectDirectory()
  const navigate = useNavigate()
  const t = useText()
  const display = useDisplayDateTime()
  const date = today()
  const project = projectQuery.data?.kind === "project" ? projectQuery.data : undefined
  const tasks = items.data ?? []
  const completed = tasks.filter(task => ["done", "completed", "cancelled", "canceled"].includes(string(task.data.status))).length
  const overdue = tasks.filter(task => {
    const due = string(task.data.dueDate) || string(task.data.due)
    return !!due && due < date && !["done", "completed", "cancelled", "canceled"].includes(string(task.data.status))
  }).length
  const members = useMemo(() => {
    const current = directory.data?.projects.find(entry => entry.projectId === projectId)
    return current ? new Set(current.teams.flatMap(team => team.members.map(member => member.id))).size : null
  }, [directory.data, projectId])
  const goal = string(project?.data.goal)
  const description = string(project?.data.description)
  if (projectQuery.isPending) return <p role="status" className="p-6">{t("正在加载项目…", "Loading project…")}</p>
  if (projectQuery.error) return <div role="alert" className="space-y-2 p-6"><p>{projectQuery.error.message}</p><Button variant="outline" onClick={() => { void projectQuery.refetch() }}>{t("重试读取", "Retry read")}</Button></div>
  if (!project) return <p role="alert" className="p-6">{t("项目不存在或不可访问。", "Project not found or unavailable.")}</p>
  const projectRoot = `/pm/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}`
  return <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3 sm:p-5">
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t("项目指标", "Project metrics")}>
          <ProjectMetric label={t("任务总数", "Issues")} value={String(tasks.length)} detail={t("当前项目任务快照", "Current project task snapshot")} />
          <ProjectMetric label={t("已完成", "Done")} value={String(completed)} detail={t("按工作流完成类别统计", "Workflow completed category")} />
          <ProjectMetric label={t("已逾期", "Overdue")} value={items.data ? String(overdue) : "—"} detail={t("未关闭的逾期任务", "Open overdue tasks")} />
          <ProjectMetric label={t("成员", "Members")} value={members === null ? "—" : String(members)} detail={t("有项目访问权限的团队成员", "Authorized project team members")} />
        </section>
        <section className="rounded-module border bg-surface p-4">
          <h2 className="text-base font-medium">{t("项目简报", "Project brief")}</h2>
          {description ? <MessageContent content={description} className="mt-3" /> : <p className="mt-3 text-sm text-muted-foreground">{t("尚无项目正文或目标。可在完整对象页编写 Markdown。", "No project body or goal has been written. Use the full entity page to edit Markdown.")}</p>}
          <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => navigate(`${projectRoot}/entities/${encodeURIComponent(projectId)}`)}>{t("打开 Markdown 源码", "Open Markdown source")}</Button><Button variant="outline" size="sm" onClick={() => navigate(`${projectRoot}/issues?view=kanban`)}>{t("打开任务看板", "Open task board")}</Button></div>
        </section>
        <section className="rounded-module border bg-surface p-4">
          <h2 className="text-base font-medium">{t("目标成果", "Outcomes")}</h2>
          {goal ? <MessageContent content={goal} className="mt-3" /> : <p className="mt-3 text-sm text-muted-foreground">{t("未设置独立目标；项目正文见上方简报。", "No separate goal is set; see the project brief above.")}</p>}
        </section>
        <section className="rounded-module border bg-surface p-4">
          <h2 className="text-base font-medium">{t("范围", "Scope")}</h2>
          <div className="mt-3"><ProjectScopeEditor project={project} /></div>
        </section>
        <section className="rounded-module border bg-surface p-4">
          <h2 className="text-base font-medium">{t("里程碑", "Milestones")}</h2>
          {milestones.data?.length ? <ul className="mt-3 space-y-2">{milestones.data.map(milestone => <li key={milestone.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><Button variant="ghost" size="sm" onClick={() => navigate(`${projectRoot}/entities/${encodeURIComponent(milestone.id)}`)}>{string(milestone.data.title) || milestone.id}</Button><span className="text-xs text-muted-foreground">{string(milestone.data.status)} · {display.date(string(milestone.data.due) || null)}</span></li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">{t("没有关联里程碑。", "No linked milestones.")}</p>}
        </section>
      </div>
      <aside className="min-w-0 space-y-4">
        <section className="rounded-module border bg-surface p-4"><h2 className="text-base font-medium">{t("项目属性", "Project properties")}</h2><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("编号", "Identifier")}</dt><dd className="font-mono">{project.id}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("状态", "Status")}</dt><dd>{string(project.data.status) || "—"}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("目标日期", "Target date")}</dt><dd>{display.date(string(project.data.dueDate) || null)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("更新时间", "Updated")}</dt><dd>{display.dateTime(project.updatedAt)}</dd></div></dl><Badge className="mt-3">{project.id}</Badge></section>
        <section className="rounded-module border bg-surface p-4"><ProjectPortfolioSummary projectId={projectId} /><details className="mt-3 space-y-3"><summary className="cursor-pointer text-sm font-medium">{t("评估、预算与历史", "Assessments, budget and history")}</summary><ProjectHealthRegion project={project} /><ProjectFinancialRegion project={project} /></details></section>
        <section className="rounded-module border bg-surface p-4"><h2 className="text-base font-medium">{t("项目团队", "Project teams")}</h2><div className="mt-3"><ProjectTeamAssignment project={project} /></div></section>
        <section className="rounded-module border bg-surface p-4"><details><summary className="cursor-pointer text-sm font-medium">{t("项目封面", "Project cover")}</summary><div className="mt-3"><ProjectCoverEditor project={project} /></div></details></section>
      </aside>
    </div>
  </div>
}

export function ServiceProjectFiles() {
  const { projectId = "" } = useParams<{ projectId: string }>()
  const project = usePmEntity(projectId)
  const t = useText()
  const [uploadOpen, setUploadOpen] = useState(false)
  if (project.isPending) return <p role="status" className="p-6">{t("正在加载项目…", "Loading project…")}</p>
  if (project.error) return <div role="alert" className="space-y-2 p-6"><p>{project.error.message}</p><Button variant="outline" onClick={() => { void project.refetch() }}>{t("重试读取", "Retry read")}</Button></div>
  if (project.data?.kind !== "project") return <p role="alert" className="p-6">{t("项目不存在或不可访问。", "Project not found or unavailable.")}</p>
  return <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3 sm:p-5"><ProjectFilesPage project={project.data} open={uploadOpen} onOpenChange={setUploadOpen} /></div>
}

export function ServiceProjectActivity() {
  const { projectId = "" } = useParams<{ projectId: string }>()
  return <ProjectAuditHistory key={projectId} projectId={projectId} />
}
