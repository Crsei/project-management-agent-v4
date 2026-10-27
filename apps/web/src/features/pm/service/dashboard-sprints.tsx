import { useState } from "react"
import { CalendarRange } from "lucide-react"
import type { Entity, SprintSummary, SprintTask } from "@contracts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { usePmEntities, usePmService, useSprintsDashboard } from "./pm-service"
import { allowed, Choice, CommandNotice, Field, Form, string, useAction, useDraftState, useText } from "./pm-ui"

function SprintReadNotice({ loading, error, stale, retry }: { loading: boolean; error: Error | null; stale: boolean; retry: () => unknown }) {
  const t = useText()
  return <>{loading && <p role="status" className="text-sm text-muted-foreground">{t("加载 Sprint…", "Loading sprints…")}</p>}{error && <div role="alert" className="space-y-2 text-sm"><p>{stale ? t("刷新失败；显示的快照可能过期：", "Refresh failed; the displayed snapshot may be stale: ") : ""}{error.message}</p><Button variant="outline" size="sm" onClick={() => { void retry() }}>{t("重试读取", "Retry read")}</Button></div>}</>
}

/** Quick-action trigger owns its dialog so dashboard card geometry remains unchanged. */
export function SprintPlanner({ projects, projectId }: { projects?: Entity[]; projectId?: string }) {
  const [open, setOpen] = useState(false)
  const query = useSprintsDashboard()
  const projectQuery = usePmEntities("project")
  const { workspace } = usePmService()
  const t = useText()
  const availableProjects = (projects ?? projectQuery.data ?? []).filter(project => !projectId || project.id === projectId)
  const editableProjects = availableProjects.filter(project => allowed(workspace, "planning.edit", project.id) && !project.data.archivedAt)
  const sprints = (query.data?.sprints ?? []).filter(sprint => !projectId || sprint.projectId === projectId)
  return <Dialog open={open} onOpenChange={setOpen}><Button size="sm" variant="outline" onClick={() => setOpen(true)}><CalendarRange className="size-3.5" aria-hidden="true" />{t("Sprint 计划", "Sprint planner")}</Button><DialogContent className="max-w-2xl"><DialogTitle>{t("Sprint 计划", "Sprint planner")}</DialogTitle><DialogDescription>{t("直接修改原生 cycle 与单个任务的 cycle 字段；每个任务单独保存，不提供多文件原子批量分配。", "Edits native cycles and each task's cycle field. Tasks save individually; there is no multi-file atomic batch assignment.")}</DialogDescription><DialogBody><div className="min-w-0 space-y-4"><CommandNotice /><SprintReadNotice loading={query.isPending} error={query.error} stale={!!query.data} retry={query.refetch} />{!projects && <SprintReadNotice loading={projectQuery.isPending} error={projectQuery.error} stale={!!projectQuery.data} retry={projectQuery.refetch} />}
    {query.data?.history.error && <p role="alert" className="text-sm text-destructive">{query.data.history.error}</p>}
    {query.data && <><details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t("创建 Sprint", "Create sprint")}</summary><div className="pt-3">{editableProjects.length ? <SprintCreate projects={editableProjects} /> : <p className="text-sm text-muted-foreground">{t("没有可编辑的项目。", "No editable project is available.")}</p>}</div></details>
      {!sprints.length && <p className="text-sm text-muted-foreground">{t("尚无 Sprint。现有原生 cycles 会显示在这里。", "No sprints yet. Existing native cycles appear here.")}</p>}
      <div className="space-y-2">{sprints.map(sprint => <SprintEditor key={sprint.id} sprint={sprint} />)}</div>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t("逐任务分配", "Assign one task at a time")}</summary><div className="space-y-3 pt-3">{query.data.tasks.filter(task => !task.archived && (!projectId || task.projectId === projectId)).map(task => <TaskSprintEditor key={task.id} task={task} sprints={sprints} />)}</div></details></>}
  </div></DialogBody></DialogContent></Dialog>
}

function SprintCreate({ projects }: { projects: Entity[] }) {
  const action = useAction()
  const t = useText()
  const [draft, setDraft] = useDraftState(`sprint-create:${projects.map(project => project.id).join(",")}`, "draft", { projectId: projects[0]?.id ?? "", title: "", startDate: "", dueDate: "" })
  return <Form disabled={action.locked || !projects.some(project => project.id === draft.projectId)} onSubmit={async () => {
    await action.execute({ commandId: crypto.randomUUID(), commandType: "CreateSprint", projectId: draft.projectId, payload: { projectId: draft.projectId, title: draft.title, startDate: draft.startDate || null, dueDate: draft.dueDate || null } })
    setDraft({ ...draft, title: "", startDate: "", dueDate: "" })
  }} label={t("创建 Sprint", "Create sprint")}><Choice label={t("项目", "Project")} value={draft.projectId} onChange={projectId => setDraft({ ...draft, projectId })} options={projects.map(project => ({ value: project.id, label: string(project.data.name) || project.id }))} /><Field label={t("Sprint 标题", "Sprint title")} value={draft.title} onChange={title => setDraft({ ...draft, title })} required /><div className="grid gap-3 sm:grid-cols-2"><Field type="date" label={t("开始日期", "Start date")} value={draft.startDate} onChange={startDate => setDraft({ ...draft, startDate })} /><Field type="date" label={t("截止日期（含当天）", "Due date (inclusive)")} value={draft.dueDate} onChange={dueDate => setDraft({ ...draft, dueDate })} /></div></Form>
}

function SprintEditor({ sprint }: { sprint: SprintSummary }) {
  const action = useAction()
  const { workspace } = usePmService()
  const t = useText()
  const [draft, setDraft] = useDraftState(`sprint:${sprint.id}`, "draft", { title: sprint.title, startDate: sprint.startDate ?? "", dueDate: sprint.dueDate ?? "", version: sprint.version })
  const editable = allowed(workspace, "planning.edit", sprint.projectId) && !sprint.archived && !sprint.readOnly
  const lifecycle = allowed(workspace, "planning.lifecycle", sprint.projectId) && !sprint.readOnly
  const conflict = draft.version !== sprint.version
  const commands = sprint.archived ? [{ type: "RestoreSprint" as const, label: t("恢复", "Restore") }] : [
    ...(sprint.category === "unstarted" || sprint.category === "backlog" ? [{ type: "StartSprint" as const, label: t("开始", "Start") }] : []),
    ...(sprint.category === "started" ? [{ type: "CompleteSprint" as const, label: t("完成", "Complete") }] : []),
    ...(sprint.category === "completed" || sprint.category === "canceled" ? [{ type: "ReopenSprint" as const, label: t("重开", "Reopen") }] : [{ type: "CancelSprint" as const, label: t("取消", "Cancel") }]),
    { type: "ArchiveSprint" as const, label: t("归档", "Archive") },
  ]
  return <details className="min-w-0 rounded-lg border p-3"><summary className="cursor-pointer break-words text-sm"><strong>{sprint.title}</strong> · {sprint.status ?? "—"} · {sprint.completed}/{sprint.total}{sprint.archived ? ` · ${t("已归档", "Archived")}` : ""}</summary><div className="space-y-3 pt-3"><p className="break-all text-xs text-muted-foreground">{sprint.id} · {sprint.startDate ?? "—"} → {sprint.dueDate ?? "—"}</p>{sprint.readOnly && <p role="alert" className="text-sm text-destructive">{t("原生文件存在校验错误；请先在源码中修复。", "The native file has validation errors. Repair its source before editing.")}</p>}
    {conflict && <div role="status" className="space-y-2 rounded border p-2 text-sm"><p>{t("服务端已更新，草稿和原版本已保留。", "The server changed; your draft and original version are retained.")}</p><p className="break-words text-xs">{t("服务端", "Saved")}: {sprint.title} · {sprint.startDate ?? "—"} → {sprint.dueDate ?? "—"}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, version: sprint.version })}>{t("保留草稿，采用最新版本", "Keep draft, use latest version")}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ title: sprint.title, startDate: sprint.startDate ?? "", dueDate: sprint.dueDate ?? "", version: sprint.version })}>{t("放弃草稿", "Discard draft")}</Button></div></div>}
    <Form disabled={action.locked || !editable || conflict} onSubmit={async () => {
      const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "UpdateSprint", targetId: sprint.id, ...(sprint.projectId ? { projectId: sprint.projectId } : {}), expectedVersions: { [sprint.id]: draft.version }, payload: { sprintId: sprint.id, title: draft.title, startDate: draft.startDate || null, dueDate: draft.dueDate || null } })
      if (receipt.status !== "committed") throw new Error(receipt.error.message)
      const saved = receipt.result as SprintSummary
      setDraft({ title: saved.title, startDate: saved.startDate ?? "", dueDate: saved.dueDate ?? "", version: saved.version })
    }}><Field label={t("Sprint 标题", "Sprint title")} value={draft.title} onChange={title => setDraft({ ...draft, title })} required /><div className="grid gap-3 sm:grid-cols-2"><Field type="date" label={t("开始日期", "Start date")} value={draft.startDate} onChange={startDate => setDraft({ ...draft, startDate })} /><Field type="date" label={t("截止日期", "Due date")} value={draft.dueDate} onChange={dueDate => setDraft({ ...draft, dueDate })} /></div></Form>
    <div className="flex flex-wrap gap-2">{commands.map(command => <Button type="button" key={command.type} size="sm" variant="outline" disabled={action.locked || !lifecycle} onClick={() => { void action.run(() => action.execute({ commandId: crypto.randomUUID(), commandType: command.type, targetId: sprint.id, ...(sprint.projectId ? { projectId: sprint.projectId } : {}), expectedVersions: { [sprint.id]: sprint.version }, payload: { sprintId: sprint.id } })) }}>{command.label}</Button>)}</div>{action.localError && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}
  </div></details>
}

function TaskSprintEditor({ task, sprints }: { task: SprintTask; sprints: SprintSummary[] }) {
  const action = useAction()
  const { workspace } = usePmService()
  const t = useText()
  const [draft, setDraft] = useDraftState(`task-sprint:${task.id}`, "draft", { sprintId: task.sprintId ?? "", version: task.version })
  const choices = sprints.filter(sprint => sprint.projectId === task.projectId && !sprint.archived && !sprint.readOnly)
  const options = [{ value: "", label: t("未分配", "Unassigned") }, ...(draft.sprintId && !choices.some(sprint => sprint.id === draft.sprintId) ? [{ value: draft.sprintId, label: `${t("原分配", "Current assignment")}: ${draft.sprintId}` }] : []), ...choices.map(sprint => ({ value: sprint.id, label: sprint.title }))]
  const conflict = task.version !== draft.version
  return <div className="min-w-0 space-y-2 rounded border p-3"><p className="break-words text-sm font-medium">{task.title} <small className="text-muted-foreground">{task.id}</small></p>{conflict && <div className="space-y-1 text-xs" role="status"><p>{t("任务已变化；草稿未覆盖服务器。", "The task changed; your draft has not overwritten the server.")}</p><Button type="button" variant="outline" size="sm" onClick={() => setDraft({ sprintId: task.sprintId ?? "", version: task.version })}>{t("读取最新分配", "Load current assignment")}</Button></div>}<Form label={t("保存此任务分配", "Save this task assignment")} disabled={action.locked || task.readOnly || conflict || !allowed(workspace, "planning.edit", task.projectId)} onSubmit={async () => {
    const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "SetTaskSprint", targetId: task.id, ...(task.projectId ? { projectId: task.projectId } : {}), expectedVersions: { [task.id]: draft.version }, payload: { workItemId: task.id, sprintId: draft.sprintId || null } })
    if (receipt.status !== "committed") throw new Error(receipt.error.message)
    const saved = receipt.result as { version: number; sprintId: string | null }
    setDraft({ sprintId: saved.sprintId ?? "", version: saved.version })
  }}><Choice label="Sprint" value={draft.sprintId} onChange={sprintId => setDraft({ ...draft, sprintId })} options={options} /></Form></div>
}

/** Discrete scan observations, not invented daily burn-down or interpolated offline history. */
export function SprintProgress({ projectId, sprintId }: { projectId?: string; sprintId?: string }) {
  const query = useSprintsDashboard()
  const t = useText()
  const [selected, setSelected] = useState("")
  const sprints = (query.data?.sprints ?? []).filter(sprint => !projectId || sprint.projectId === projectId)
  const choices = new Map<string, { id: string; title: string }>()
  for (const observation of query.data?.history.observations ?? []) for (const row of observation.sprints) if (!projectId || row.projectId === projectId) choices.set(row.id, { id: row.id, title: row.title })
  for (const row of sprints) choices.set(row.id, { id: row.id, title: row.title })
  const currentId = sprintId ?? (choices.has(selected) ? selected : sprints.find(sprint => query.data?.currentSprintIds.includes(sprint.id))?.id ?? sprints[0]?.id ?? choices.values().next().value?.id)
  const sprint = sprints.find(row => row.id === currentId)
  const observations = (query.data?.history.observations ?? []).map(observation => ({ ...observation, sprint: observation.sprints.find(row => row.id === currentId) }))
  const points = observations.filter(observation => observation.complete && observation.sprint)
  const hasHistory = observations.some(observation => !!observation.sprint)
  const start = points.length ? Date.parse(points[0]!.observedAt) : 0
  const span = Math.max(1, points.length ? Date.parse(points.at(-1)!.observedAt) - start : 1)
  const maximum = Math.max(1, ...points.map(point => point.sprint!.remaining))
  return <section className="min-w-0 space-y-3" aria-label={t("Sprint 进展", "Sprint progress")}><div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("Sprint 进展", "Sprint progress")}</h3>{!sprintId && choices.size > 0 && <select aria-label={t("查看 Sprint", "View sprint")} value={currentId} onChange={event => setSelected(event.target.value)} className="min-h-8 min-w-0 max-w-full rounded border bg-background px-2 text-xs">{[...choices.values()].map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select>}</div><SprintReadNotice loading={query.isPending} error={query.error} stale={!!query.data} retry={query.refetch} />
    {query.data?.history.error && <p role="alert" className="text-sm text-destructive">{query.data.history.error}</p>}{query.data && !sprint && !hasHistory && <p className="text-sm text-muted-foreground">{t("没有可查看的 Sprint。", "No sprint is available.")}</p>}
    {(sprint || hasHistory) && <>{sprint ? <><div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-muted/50 p-2"><strong>{sprint.total}</strong><p className="text-xs text-muted-foreground">{t("任务", "Tasks")}</p></div><div className="rounded-lg bg-muted/50 p-2"><strong>{sprint.completed}</strong><p className="text-xs text-muted-foreground">{t("已完成", "Completed")}</p></div><div className="rounded-lg bg-muted/50 p-2"><strong>{sprint.remaining}</strong><p className="text-xs text-muted-foreground">{t("未完成", "Not completed")}</p></div></div><p className="text-xs text-muted-foreground">{sprint.startDate ?? "—"} → {sprint.dueDate ?? "—"} · {sprint.status ?? "—"}</p></> : <p className="text-xs text-muted-foreground">{t("此 cycle 当前已不存在；以下仅为保留的历史观测，不代表当前任务数。", "This cycle no longer exists. These retained observations do not represent current task counts.")}</p>}
      {points.length > 0 ? <div className="min-w-0"><svg viewBox="0 0 600 160" role="img" aria-label={t("各观测时刻的未完成任务数；空档不连线", "Not-completed task counts at observed times; gaps are not connected")} className="h-40 w-full text-foreground"><line x1="30" y1="130" x2="575" y2="130" stroke="currentColor" opacity="0.15" />{points.map((point, index) => {
        const x = 30 + (Date.parse(point.observedAt) - start) / span * 545
        const y = 125 - point.sprint!.remaining / maximum * 105
        const previous = points[index - 1]
        const interveningGap = previous && (point.previousObservedAt !== previous.observedAt || observations.some(observation => observation.sequence > previous.sequence && observation.sequence <= point.sequence && (!observation.complete || !observation.sprint || observation.gap !== null)))
        return <g key={point.sequence}>{previous && !interveningGap && <line x1={30 + (Date.parse(previous.observedAt) - start) / span * 545} y1={125 - previous.sprint!.remaining / maximum * 105} x2={x} y2={y} stroke="currentColor" strokeWidth="2" opacity="0.65" />}<circle cx={x} cy={y} r="3.5" fill="currentColor"><title>{new Date(point.observedAt).toLocaleString()} · {point.source} · {point.sprint!.remaining}</title></circle></g>
      })}<text x="30" y="151" fontSize="10" fill="currentColor">{new Date(points[0]!.observedAt).toLocaleString()}</text><text x="575" y="151" textAnchor="end" fontSize="10" fill="currentColor">{new Date(points.at(-1)!.observedAt).toLocaleString()}</text></svg></div> : <p className="text-sm text-muted-foreground">{t("尚无有效观测点。", "No valid observation points yet.")}</p>}
      <p className="text-xs text-muted-foreground">{t("仅显示当前有权读取的真实观测快照，不补造过去每日数据。未完成包含取消任务；成员变化会改变总量。重启、无效扫描及离线期间的中间状态未知。", "Only currently authorized genuine observations are shown; no past daily data is fabricated. Not completed includes cancelled tasks; membership changes alter totals. Intermediate states during restarts, invalid scans and offline gaps are unknown.")}</p>
      <details><summary className="cursor-pointer text-xs text-muted-foreground">{t("观测历史与来源", "Observation history and sources")} · {observations.length}</summary><ol className="max-h-64 space-y-2 overflow-y-auto pt-2 text-xs">{observations.map(observation => <li key={observation.sequence} className="break-words rounded border p-2"><time dateTime={observation.observedAt}>{new Date(observation.observedAt).toLocaleString()}</time> · {observation.source} / {observation.reason}{observation.gap && <span> · {t("观测空档", "Observation gap")}: {observation.gap}</span>}{!observation.complete ? <span className="text-destructive"> · {t("无效扫描；未计入趋势", "Invalid scan; excluded from trend")}</span> : observation.sprint ? <span> · {observation.sprint.completed}/{observation.sprint.total} · {t("未完成", "Not completed")}: {observation.sprint.remaining}</span> : <span> · {t("当时尚无此 Sprint", "Sprint not present in this snapshot")}</span>}</li>)}</ol></details></>}
  </section>
}
