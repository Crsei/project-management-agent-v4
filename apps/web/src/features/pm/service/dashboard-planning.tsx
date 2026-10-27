import { useId, useState } from "react"
import type { PlanningDashboard } from "@contracts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { usePlanningDashboard } from "./pm-service"
import { Choice, CommandNotice, Field, Form, entitySchema, useAction, useDraftState, useText } from "./pm-ui"

type Project = PlanningDashboard["projects"][number]
type Task = PlanningDashboard["tasks"][number]
type Milestone = PlanningDashboard["milestones"][number]

function ReadNotice({ pending, error, retry }: { pending: boolean; error: Error | null; retry: () => unknown }) {
  const t = useText()
  return <>{pending && <p role="status">{t("加载规划数据…", "Loading planning data…")}</p>}{error && <div role="alert" className="space-y-2 text-sm"><p>{error.message}</p><Button variant="outline" size="sm" onClick={() => { void retry() }}>{t("重试读取", "Retry read")}</Button></div>}</>
}

function DependencyEditor({ project, projects }: { project: Project; projects: Project[] }) {
  const t = useText(); const action = useAction()
  const [base, setBase] = useDraftState(`project-dependencies:${project.id}`, "base", project)
  const [selected, setSelected] = useDraftState(`project-dependencies:${project.id}`, "selected", project.dependsOn)
  const canEdit = project.editable && !project.hasUnavailableDependencies
  return <Dialog><DialogTrigger render={<Button size="sm" variant="outline" disabled={!canEdit} />}>{t("编辑项目依赖", "Edit project dependencies")}</DialogTrigger><DialogContent><DialogTitle>{project.title}</DialogTitle><DialogDescription>{t("箭头指向前置项目。每个关联端点都需要规划权限；不会更改任务依赖。", "Arrows point to prerequisite projects. Every endpoint requires planning permission; task blockers remain unchanged.")}</DialogDescription>
    <Form disabled={action.locked || !canEdit} onSubmit={async () => {
      const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "SetProjectDependencies", targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: base.version }, payload: { dependsOn: selected } })
      if (receipt.status !== "committed") throw new Error(receipt.error.message)
      const saved = entitySchema.parse(receipt.result); setBase({ ...project, version: saved.version, dependsOn: selected })
    }}>
      <div className="max-h-64 space-y-2 overflow-auto">{projects.filter(item => item.id !== project.id).map(item => <label key={item.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selected.includes(item.id)} disabled={!item.editable && !selected.includes(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span className="break-words">{item.title} <small>{item.id}</small></span></label>)}</div>
      {base.version !== project.version && <div role="status" className="space-y-2 text-sm"><p>{t("服务器版本已变化。保留草稿，旧版本保存会被拒绝。", "The server version changed. Your draft is retained; a stale save will be rejected.")}</p><Button type="button" variant="outline" onClick={() => setBase(project)}>{t("保留草稿并采用当前版本", "Keep draft and use current version")}</Button></div>}
    </Form><CommandNotice />
  </DialogContent></Dialog>
}

/** Formal project graph only. A → B means A depends on B; this is not the task blocker graph. */
export function ProjectDependenciesPanel({ projectId, projectIds, onSelectProject }: { projectId?: string; projectIds?: string[]; onSelectProject?: (id: string) => void }) {
  const query = usePlanningDashboard(); const t = useText(); const [selected, setSelected] = useState(""); const markerId = useId().replace(/:/g, "")
  const select = (id: string) => { if (onSelectProject) onSelectProject(id); else setSelected(id) }
  const allProjects = query.data?.projects ?? []
  const displayIds = projectIds ? new Set(projectIds) : null
  const projects = displayIds ? allProjects.filter(project => displayIds.has(project.id)) : allProjects
  const current = projectId ? projects.find(item => item.id === projectId) : projects.find(item => item.id === selected) ?? projects[0]
  const columns = projects.length > 1 ? 2 : 1
  const height = Math.max(120, Math.ceil(projects.length / columns) * 86)
  const positions = new Map(projects.map((project, index) => [project.id, { x: 12 + index % columns * 300, y: 16 + Math.floor(index / columns) * 86 }]))
  const currentDependencies = current?.dependsOn.filter(id => positions.has(id)) ?? []
  return <section className="min-w-0 space-y-3" aria-label={t("项目依赖图", "Project dependency graph")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-medium">{t("项目依赖", "Project dependencies")}</h3><p className="text-xs text-muted-foreground">{t("A → B：A 依赖 B；与任务阻塞图区分。", "A → B: A depends on B; separate from task blockers.")}</p></div>{current && <DependencyEditor key={current.id} project={current} projects={allProjects} />}</div>
    <ReadNotice pending={query.isPending} error={query.error} retry={query.refetch} />
    {query.data && !projects.length && <p className="text-sm text-muted-foreground">{t("尚无可见项目。", "No visible projects yet.")}</p>}
    {!!projects.length && <div className="max-h-96 overflow-y-auto rounded-lg border bg-muted/20"><svg viewBox={`0 0 ${columns * 300} ${height}`} className="block h-auto w-full min-w-0" role="img" aria-label={t("项目前置关系", "Project prerequisite relationships")}>
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {projects.flatMap(project => project.dependsOn.map(id => {
        const start = positions.get(project.id)!; const end = positions.get(id)
        if (!end || id === project.id) return null
        const dx = end.x - start.x; const dy = end.y - start.y
        const edge = Math.min(dx ? 140 / Math.abs(dx) : Infinity, dy ? 28 / Math.abs(dy) : Infinity)
        return <line key={`${project.id}:${id}`} x1={start.x + 136 + dx * edge} y1={start.y + 24 + dy * edge} x2={end.x + 136 - dx * edge} y2={end.y + 24 - dy * edge} stroke="currentColor" strokeOpacity=".5" strokeWidth="1.5" markerEnd={`url(#${markerId})`} />
      }))}
      {projects.map(project => {
        const point = positions.get(project.id)!
        return <g key={project.id} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={project.title} aria-pressed={project.id === current?.id} onClick={() => select(project.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(project.id) } }} className="cursor-pointer outline-none focus:stroke-primary">
          <rect width="272" height="48" rx="8" fill="var(--color-surface, Canvas)" stroke="currentColor" strokeWidth={project.id === current?.id ? 2 : 1} opacity={project.id === current?.id ? 1 : .75} /><text x="12" y="19" fontSize="12" fill="currentColor">{project.title.length > 32 ? `${project.title.slice(0, 31)}…` : project.title}</text><text x="12" y="36" fontSize="10" fill="currentColor" opacity=".65">{project.id} · {project.dependsOn.filter(id => positions.has(id)).length} {t("个前置", "prerequisites")}</text>
        </g>
      })}
    </svg></div>}
    {current && <div className="flex flex-wrap items-start gap-2 text-sm"><span className="font-medium break-words">{current.title}</span><span className="text-muted-foreground">{currentDependencies.length ? currentDependencies.map(id => projects.find(item => item.id === id)!.title).join(" · ") : t("没有可见前置项目", "No visible prerequisites")}</span>{current.dependsOn.length > currentDependencies.length && <p className="w-full text-xs text-muted-foreground">{t("部分前置项目不在当前显示筛选中。", "Some prerequisites are outside the current display filter.")}</p>}{current.hasUnavailableDependencies && <p role="status" className="w-full text-amber-700">{t("部分前置项目不可用或不可见；不能将此图视为完整，也不能覆盖依赖。", "Some prerequisites are unavailable or hidden; this graph is incomplete and dependencies cannot be overwritten.")}</p>}</div>}
  </section>
}

function DurationEditor({ task }: { task: Task }) {
  const t = useText(); const action = useAction()
  const [base, setBase] = useDraftState(`task-duration:${task.id}`, "base", task)
  const [value, setValue] = useDraftState(`task-duration:${task.id}`, "duration", task.estimatedDurationDays === null ? "" : String(task.estimatedDurationDays))
  return <Form title={task.title} disabled={action.locked || !task.editable} onSubmit={async () => {
    const duration = value.trim() ? Number(value) : null
    if (duration !== null && (!Number.isFinite(duration) || duration < 0)) throw new Error(t("请输入非负有限日数。", "Enter a finite nonnegative number of days."))
    const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "UpdateTaskDuration", targetId: task.id, projectId: task.projectId, expectedVersions: { [task.id]: base.version }, payload: { estimatedDurationDays: duration } })
    if (receipt.status !== "committed") throw new Error(receipt.error.message)
    const saved = entitySchema.parse(receipt.result); setBase({ ...task, version: saved.version, estimatedDurationDays: duration })
  }}><Field label={t("预计工期（日；留空清除）", "Estimated duration (days; blank clears)")} value={value} onChange={setValue} />{base.version !== task.version && <Button type="button" variant="outline" onClick={() => setBase(task)}>{t("保留草稿并采用当前版本", "Keep draft and use current version")}</Button>}</Form>
}

export function CriticalPathPanel({ projectId }: { projectId?: string }) {
  const query = usePlanningDashboard(); const t = useText(); const [selection, setSelection] = useState("")
  const projects = query.data?.projects ?? []; const project = projectId ? projects.find(item => item.id === projectId) : projects.find(item => item.id === selection) ?? projects[0]
  const analysis = project?.criticalPath
  const tasks = query.data?.tasks.filter(task => task.projectId === project?.id) ?? []
  return <section className="min-w-0 space-y-3" aria-label={t("关键路径分析", "Critical-path analysis")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t("关键路径", "Critical path")}</h3>{!!tasks.length && <Dialog><DialogTrigger render={<Button variant="outline" size="sm" />}>{t("设置工期", "Set durations")}</DialogTrigger><DialogContent><DialogTitle>{t("任务预计工期", "Task duration estimates")}</DialogTitle><DialogDescription>{t("连续日历日、零延迟完成到开始依赖；不自动排期或改变生命周期。", "Continuous calendar days and finish-to-start zero-lag dependencies; no automatic scheduling or lifecycle changes.")}</DialogDescription><div className="space-y-5 py-3">{tasks.map(task => <DurationEditor key={task.id} task={task} />)}</div><CommandNotice /></DialogContent></Dialog>}</div>
    <ReadNotice pending={query.isPending} error={query.error} retry={query.refetch} />
    {!projectId && !!projects.length && <Choice label={t("分析项目", "Analyze project")} value={project?.id ?? ""} onChange={setSelection} options={projects.map(item => ({ value: item.id, label: item.title }))} />}
    {query.data && !project && <p className="text-sm text-muted-foreground">{t("尚无可分析项目。", "No project inputs available.")}</p>}
    {analysis?.status === "unavailable" && <div role="status" className="space-y-2 text-sm"><p>{t("当前不可计算；不推测工期或隐藏的依赖。", "Currently unavailable; durations and hidden dependencies are not guessed.")}</p><ul className="list-disc space-y-1 pl-4">{analysis.reasons.slice(0, 3).map((reason, index) => <li key={`${reason.code}:${reason.taskId}:${index}`} className="break-words">{reason.taskId ? `${reason.taskId}: ` : ""}{reason.message}</li>)}</ul>{analysis.reasons.length > 3 && <details><summary>{t("全部原因", "All reasons")} ({analysis.reasons.length})</summary><ul>{analysis.reasons.slice(3).map((reason, index) => <li key={index}>{reason.taskId}: {reason.message}</li>)}</ul></details>}</div>}
    {analysis?.status === "available" && <><p className="text-2xl font-semibold tabular-nums">{analysis.durationDays.toLocaleString()} <span className="text-sm font-normal">{t("日", "days")}</span></p><p className="text-sm text-muted-foreground">{analysis.criticalPaths.length} {t("条同长关键路径", "equal-length critical paths")} · {analysis.tasks.filter(task => task.critical).length} {t("个关键任务", "critical tasks")}</p><details className="space-y-2 text-sm"><summary className="cursor-pointer">{t("路径与浮动时间", "Paths and float")}</summary><ol className="list-decimal space-y-2 pl-5">{analysis.criticalPaths.map((ids, index) => <li key={index} className="break-words">{ids.map(id => analysis.tasks.find(task => task.id === id)?.title ?? id).join(" → ")}</li>)}</ol><div className="space-y-2">{analysis.tasks.map(task => <div key={task.id} className="rounded border p-2"><p className="break-words font-medium">{task.title} {task.critical ? "●" : ""}</p><p className="text-xs tabular-nums">ES {task.earlyStart} · EF {task.earlyFinish} · LS {task.lateStart} · LF {task.lateFinish}</p><p className="text-xs">{t("总浮动", "Total float")} {task.totalFloat} · {t("自由浮动", "Free float")} {task.freeFloat}</p></div>)}</div></details><p className="text-xs text-muted-foreground">{t("明确工期、连续日历日、FS 零延迟；不使用资源平衡、日期约束或状态推算。", "Explicit durations, continuous calendar days, FS zero lag; no resource leveling, date constraints, or status-derived estimates.")}</p></>}
  </section>
}

function MilestoneDateForm({ milestone }: { milestone: Milestone }) {
  const t = useText(); const action = useAction()
  const [base, setBase] = useDraftState(`milestone-reschedule:${milestone.id}`, "base", milestone)
  const [date, setDate] = useDraftState(`milestone-reschedule:${milestone.id}`, "date", milestone.targetDate ?? "")
  return <Form title={milestone.title} disabled={action.locked || !milestone.editable} onSubmit={async () => {
    const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "UpdateMilestone", targetId: milestone.id, projectId: milestone.projectId, expectedVersions: { [milestone.id]: base.version }, payload: { targetDate: date || null } })
    if (receipt.status !== "committed") throw new Error(receipt.error.message)
    const saved = entitySchema.parse(receipt.result); setBase({ ...milestone, version: saved.version, targetDate: date || null })
  }}><Field label={t("目标日期（留空清除）", "Target date (blank clears)")} type="date" value={date} onChange={setDate} />{base.version !== milestone.version && <div className="space-y-2 text-sm"><p>{t("服务器版本已变化；日期草稿仍保留。", "The server version changed; the date draft is retained.")}</p><Button type="button" variant="outline" onClick={() => setBase(milestone)}>{t("保留草稿并采用当前版本", "Keep draft and use current version")}</Button></div>}</Form>
}

/** Compact quick-action trigger; only targetDate is submitted, preserving Markdown prose and criteria. */
export function MilestoneReschedule({ projectId, milestoneId }: { projectId?: string; milestoneId?: string }) {
  const query = usePlanningDashboard(); const t = useText()
  const milestones = query.data?.milestones.filter(item => (!projectId || item.projectId === projectId) && (!milestoneId || item.id === milestoneId)) ?? []
  return <Dialog><DialogTrigger render={<Button variant="outline" size="sm" />}>{t("里程碑改期", "Reschedule milestone")}</DialogTrigger><DialogContent><DialogTitle>{t("里程碑改期", "Reschedule milestone")}</DialogTitle><DialogDescription>{t("只更新日期，不替换正文或达成标准；旧版本不会覆盖新版本。", "Updates dates only, preserving prose and achievement criteria; stale versions cannot overwrite newer edits.")}</DialogDescription><ReadNotice pending={query.isPending} error={query.error} retry={query.refetch} />{query.data && !milestones.length && <p className="py-3 text-sm text-muted-foreground">{t("没有可见里程碑。", "No visible milestones.")}</p>}<div className="space-y-5 py-3">{milestones.map(item => <MilestoneDateForm key={item.id} milestone={item} />)}</div><CommandNotice /></DialogContent></Dialog>
}
