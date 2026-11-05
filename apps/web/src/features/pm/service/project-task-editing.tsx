import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { diagnosticsOf, workflowFor, type Diagnostic, type FileRecord, type ProtocolConfiguration, type WorkspaceSnapshot } from "@pm-schema"
import { patchMarkdown } from "@pm-markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"
import type { WorkItemsBoardMove } from "@/components/blocks/work-items-views"
import type { ControlledIssueCatalog, ControlledIssuePatch, ControlledIssueRecord } from "@/views/pm/controlled-contracts"
import { ApiError as CoreApiError } from "../markdown/api"
import { useCoreSession, useCreationDrafts, useSessionDrafts, type Draft } from "../markdown/session"
import { ServiceGantt } from "../components/service-gantt"
import { ServiceCalendar } from "../components/service-calendar"
import type { ScheduleItem } from "../components/service-collection-shared"
import { usePlanningDashboard, usePmCommand, usePmService } from "./pm-service"
import { allowed, useText } from "./pm-ui"
import { adoptProjectTaskDraft, hasUncertainProjectTaskDraft, observeProjectTaskDraft, prepareProjectTaskPatch, projectTaskChangesSchema, projectTaskDraftValue, projectTaskWriteProblem, readProjectTaskDraft, type ProjectTaskChanges, type ProjectTaskDraft, type ProjectTaskField, type ProjectTaskWriteContext } from "./project-task-editing-model"
import { hasUncertainCreationDrafts } from "../markdown/creation-model"
import { createCoreTimelineMetadata } from "./pm-core-schedule"
import { RadixSelect } from "@/components/ui/radix-select"
import { MilestoneReschedule } from "./dashboard-planning"

export type { ProjectTaskChanges, ProjectTaskDraft, ProjectTaskField } from "./project-task-editing-model"
export interface ProjectTaskEditing {
  projectId: string
  files: FileRecord[]
  contextFiles: readonly FileRecord[]
  configuration: ProtocolConfiguration | null
  pending: boolean
  locked: boolean
  error: string | null
  diagnostics: Diagnostic[]
  drafts: Readonly<Record<string, ProjectTaskDraft | undefined>>
  unknown: readonly string[]
  canEdit: (id: string) => boolean
  canMove: (id: string, target: string) => boolean
  problem: (id: string) => string | null
  present: (items: readonly ControlledIssueRecord[]) => ControlledIssueRecord[]
  change: (id: string, changes: ProjectTaskChanges) => void
  save: (id: string) => Promise<void>
  patch: (item: ControlledIssueRecord, changes: ControlledIssuePatch) => Promise<void>
  move: (intent: WorkItemsBoardMove) => Promise<void>
  schedule: (item: ProjectTimelineItem, startDate: string | null, dueDate: string | null) => Promise<void>
  adoptCurrent: (id: string) => void
  discardDraft: (id: string) => void
  reconcile: (id: string) => Promise<void>
}
export interface ProjectTimelineItem extends ScheduleItem { version: string; source: FileRecord }
export interface ProjectTimelineProps {
  projectId: string
  items: readonly ControlledIssueRecord[]
  onOpen: (item: { id: string }) => void
  editing?: ProjectTaskEditing
  visibleIds?: ReadonlySet<string>
}

/** Writes use the scoped native API and its source revision, never PM status commands.
 * Recovery metadata travels with the existing CoreSession source draft backup. */
export function useProjectTaskEditing(projectId: string): ProjectTaskEditing {
  const session = useCoreSession()
  const client = useQueryClient()
  const service = usePmService()
  const command = usePmCommand()
  const [sourceDrafts, setSourceDrafts] = useSessionDrafts()
  const [creationDrafts] = useCreationDrafts()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [blockedAccess, setBlockedAccess] = useState(false)
  const writing = useRef(false)
  const revisionSequence = useRef(0)
  const revisions = useRef(new Map<number, FileRecord>())
  const currentTokens = useRef(new Map<string, { revision: string; token: number; previousToken?: number }>())
  const query = useQuery({ queryKey: session.queryKey, queryFn: ({ signal }) => session.api.workspace(signal), retry: false, enabled: !blockedAccess, refetchOnWindowFocus: true })
  const accessError = query.error instanceof CoreApiError && [401, 403, 404].includes(query.error.status)
  const snapshot = blockedAccess || accessError ? undefined : query.data
  const files = snapshot?.files.filter(file => file.entity.entity === "work_item" && file.entity.project === projectId) ?? []
  const configuration = snapshot?.configuration ?? null
  const drafts: Record<string, ProjectTaskDraft> = {}
  for (const [id, backup] of Object.entries(sourceDrafts)) {
    const draft = readProjectTaskDraft(backup)
    if (draft?.projectId === projectId) drafts[id] = draft
  }
  const unknown = Object.entries(drafts).filter(([, draft]) => draft.phase === "unknown" || draft.phase === "observed").map(([id]) => id)
  const locked = pending || command.pending || !!command.unknownCommand || hasUncertainProjectTaskDraft(sourceDrafts) || hasUncertainCreationDrafts(creationDrafts)
  const canWrite = service.capabilities?.business.enabled === true && allowed(service.workspace, "planning.edit", projectId)

  useEffect(() => {
    if (!accessError || blockedAccess) return
    setBlockedAccess(true)
    void client.cancelQueries({ queryKey: session.queryKey, exact: true }).then(() => client.removeQueries({ queryKey: session.queryKey, exact: true }))
    void session.onAccessFailure().catch(() => {})
  }, [accessError, blockedAccess, client, session])

  function context(ignoreUncertain = false): ProjectTaskWriteContext {
    return {
      projectId, snapshot: blockedAccess || accessError ? undefined : client.getQueryData<WorkspaceSnapshot>(session.queryKey),
      canWrite, locked: writing.current || command.pending || !!command.unknownCommand || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || (!ignoreUncertain && hasUncertainProjectTaskDraft(session.drafts.getSnapshot())),
      readError: !!query.error || !!service.error, sourceDrafts: session.drafts.getSnapshot(),
    }
  }
  function report(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause))
    setDiagnostics(cause instanceof CoreApiError ? cause.diagnostics : diagnosticsOf(cause))
    if (cause instanceof CoreApiError && [401, 403, 404].includes(cause.status)) {
      setBlockedAccess(true)
      void client.cancelQueries({ queryKey: session.queryKey, exact: true }).then(() => client.removeQueries({ queryKey: session.queryKey, exact: true }))
      void session.onAccessFailure().catch(() => {})
    }
  }
  function retain(id: string, draft: ProjectTaskDraft) {
    let raw = draft.baseRaw
    try { raw = patchMarkdown(draft.baseRaw, draft.changes, configuration ?? undefined) } catch { /* Invalid fields are retained in validated draft metadata until corrected. */ }
    const backup: Draft & { projectTaskEditing: ProjectTaskDraft } = { raw, revision: draft.revision, projectTaskEditing: draft }
    setSourceDrafts(previous => ({ ...previous, [id]: backup }))
  }
  function accept(file: FileRecord) {
    client.setQueryData<WorkspaceSnapshot>(session.queryKey, previous => previous ? { ...previous, files: previous.files.map(candidate => candidate.id === file.id ? file : candidate), unsupportedFiles: previous.unsupportedFiles.filter(candidate => candidate.path !== file.path) } : previous)
  }
  function remove(id: string) {
    setSourceDrafts(previous => {
      if (!readProjectTaskDraft(previous[id])) return previous
      const next = { ...previous }; delete next[id]; return next
    })
  }
  function problem(id: string) { return projectTaskWriteProblem(context(), id) }
  function canEdit(id: string) { return !projectTaskWriteProblem(context(), id) }
  function canMove(id: string, target: string) {
    const file = files.find(candidate => candidate.id === id)
    const workflow = configuration && workflowFor("work_item", configuration)
    return canEdit(id) && !session.drafts.getSnapshot()[id] && !!file && file.entity.status !== target && !!workflow?.transitions.some(transition => transition.from === file.entity.status && transition.to === target)
  }
  function change(id: string, input: ProjectTaskChanges) {
    try {
      const blocked = projectTaskWriteProblem(context(), id)
      if (blocked) throw new Error(blocked)
      const changes = projectTaskChangesSchema.parse(input)
      const file = files.find(candidate => candidate.id === id)
      if (!file) throw new Error("The task source is unavailable.")
      const previous = readProjectTaskDraft(session.drafts.getSnapshot()[id])
      retain(id, { projectId, baseRaw: previous?.baseRaw ?? file.raw, revision: previous?.revision ?? file.revision, changes: { ...previous?.changes, ...changes }, phase: "editing", message: "" })
      setError(null); setDiagnostics([])
    } catch (cause) { report(cause) }
  }
  async function save(id: string): Promise<void> {
    const draft = readProjectTaskDraft(session.drafts.getSnapshot()[id])
    if (!draft) return
    try {
      const state = context()
      const blocked = projectTaskWriteProblem(state, id)
      if (blocked) throw new Error(blocked)
      const file = state.snapshot?.files.find(candidate => candidate.id === id)
      if (!file || !state.snapshot) throw new Error("The task source is unavailable.")
      if (draft.revision !== file.revision) {
        retain(id, { ...draft, phase: "conflict", message: "The source changed. Review it and explicitly adopt its revision before saving this draft." })
        throw new Error("The source revision changed; the task draft is retained.")
      }
      const prepared = prepareProjectTaskPatch(file, draft, state.snapshot.configuration, state.snapshot.files)
      if (!Object.keys(prepared.changes).length) { remove(id); return }
      retain(id, { ...draft, phase: "unknown", message: "Native PATCH dispatched or pending. Read the authoritative source before any replacement write if its response is lost." })
      if (session.drafts.persistenceError()) {
        retain(id, { ...draft, phase: "rejected", message: "Local source draft backup is unavailable. No write was sent." })
        throw new Error("Local source draft backup is unavailable. No write was sent; keep this tab open.")
      }
      writing.current = true; setPending(true); setError(null); setDiagnostics([])
      try {
        const saved = await session.api.patch(id, prepared.changes, draft.revision)
        accept(saved)
        remove(id)
        void client.invalidateQueries({ queryKey: session.queryKey.slice(0, 4) })
      } catch (cause) {
        const definite = cause instanceof CoreApiError && cause.status < 500 && cause.status !== 408
        const conflict = cause instanceof CoreApiError && cause.status === 409 && cause.diagnostics.some(issue => issue.code === "REVISION_CONFLICT")
        if (conflict && cause.current && "entity" in cause.current) accept(cause.current)
        retain(id, { ...draft, phase: definite ? conflict ? "conflict" : "rejected" : "unknown", message: cause instanceof Error ? cause.message : String(cause) })
        if (definite) void client.invalidateQueries({ queryKey: session.queryKey })
        throw cause
      } finally { writing.current = false; setPending(false) }
    } catch (cause) { report(cause); throw cause }
  }
  async function patch(item: ControlledIssueRecord, input: ControlledIssuePatch) {
    try {
      const changes: ProjectTaskChanges = {}
      for (const key of Object.keys(input)) if (!["title", "stateId", "priorityId", "assigneeIds", "startDate", "dueDate"].includes(key)) throw new Error("Use the full editor for this task field.")
      if (input.title !== undefined) changes.title = input.title
      if (input.stateId !== undefined) changes.status = input.stateId
      if (input.priorityId !== undefined) changes.priority = projectTaskChangesSchema.shape.priority.parse(input.priorityId || null)
      if (input.assigneeIds !== undefined) {
        if (input.assigneeIds.length > 1) throw new Error("The native task supports one assignee.")
        changes.assignee = input.assigneeIds[0] ?? null
      }
      if (input.startDate !== undefined) changes["x-pm-start"] = input.startDate
      if (input.dueDate !== undefined) changes.due = input.dueDate
      const file = revisions.current.get(item.revision)
      if (!file || file.id !== item.id || file.revision !== item.version) throw new Error("The task presentation changed. Read the current source before editing.")
      const blocked = projectTaskWriteProblem(context(), item.id, false)
      if (blocked) throw new Error(blocked)
      retain(item.id, { projectId, baseRaw: file.raw, revision: file.revision, changes: projectTaskChangesSchema.parse(changes), phase: "editing", message: "" })
      await save(item.id)
    } catch (cause) { report(cause); throw cause }
  }
  async function move(intent: WorkItemsBoardMove) {
    try {
      if (intent.queryKey !== `project:${projectId}:tasks`) throw new Error("The board scope changed. Read the current project before moving tasks.")
      const file = intent.baseRevision === undefined ? undefined : revisions.current.get(intent.baseRevision)
      if (!file || file.id !== intent.itemId || file.entity.status !== intent.sourceGroup) throw new Error("The dragged task snapshot is no longer available.")
      const blocked = projectTaskWriteProblem(context(), file.id, false)
      if (blocked) throw new Error(blocked)
      retain(file.id, { projectId, baseRaw: file.raw, revision: file.revision, changes: { status: intent.targetGroup }, phase: "editing", message: "" })
      await save(file.id)
    } catch (cause) { report(cause); throw cause }
  }
  async function schedule(item: ProjectTimelineItem, startDate: string | null, dueDate: string | null) {
    try {
      const blocked = projectTaskWriteProblem(context(), item.id, false)
      if (blocked) throw new Error(blocked)
      retain(item.id, { projectId, baseRaw: item.source.raw, revision: item.version, changes: projectTaskChangesSchema.parse({ "x-pm-start": startDate, due: dueDate }), phase: "editing", message: "" })
      await save(item.id)
    } catch (cause) { report(cause); throw cause }
  }
  function adoptCurrent(id: string) {
    try {
      const draft = readProjectTaskDraft(session.drafts.getSnapshot()[id])
      if (!draft || draft.phase === "unknown") throw new Error("Read the authoritative source before resolving an uncertain write.")
      const blocked = projectTaskWriteProblem(context(true), id)
      if (blocked) throw new Error(blocked)
      const file = client.getQueryData<WorkspaceSnapshot>(session.queryKey)?.files.find(candidate => candidate.id === id)
      if (!file) throw new Error("The task source is unavailable.")
      retain(id, adoptProjectTaskDraft(file, draft))
      setError(null); setDiagnostics([])
    } catch (cause) { report(cause) }
  }
  function discardDraft(id: string) {
    const draft = readProjectTaskDraft(session.drafts.getSnapshot()[id])
    if (writing.current || command.pending || command.unknownCommand || draft?.phase === "unknown") return
    remove(id); setError(null); setDiagnostics([])
  }
  async function reconcile(id: string) {
    const draft = readProjectTaskDraft(session.drafts.getSnapshot()[id])
    if (!draft || draft.phase !== "unknown" || writing.current || command.pending || command.unknownCommand) return
    writing.current = true; setPending(true); setError(null); setDiagnostics([])
    try {
      const observed = await session.api.file(id)
      if (!("entity" in observed) || observed.entity.entity !== "work_item" || observed.entity.project !== projectId) throw new Error("The current source is unavailable or unsupported; the uncertain write remains locked.")
      accept(observed)
      retain(id, observeProjectTaskDraft(observed, draft))
    } catch (cause) { report(cause); throw cause }
    finally { writing.current = false; setPending(false) }
  }
  function present(items: readonly ControlledIssueRecord[]): ControlledIssueRecord[] {
    return items.flatMap(item => {
      const file = files.find(candidate => candidate.id === item.id)
      if (!file) return []
      let stamp = currentTokens.current.get(file.id)
      if (stamp?.revision !== file.revision) {
        if (stamp?.previousToken !== undefined) revisions.current.delete(stamp.previousToken)
        stamp = { revision: file.revision, token: ++revisionSequence.current, previousToken: stamp?.token }
        currentTokens.current.set(file.id, stamp); revisions.current.set(stamp.token, file)
      }
      return [{ ...item, title: file.entity.title, stateId: file.entity.status ?? "", priorityId: file.entity.priority ?? "", assigneeIds: file.entity.assignee ? [file.entity.assignee] : [], startDate: typeof file.entity["x-pm-start"] === "string" ? file.entity["x-pm-start"] : null, dueDate: file.entity.due ?? null, version: file.revision, revision: stamp.token }]
    })
  }
  return { projectId, files, contextFiles: snapshot?.files ?? [], configuration, pending, locked, error: error ?? query.error?.message ?? null, diagnostics: [...(snapshot?.configurationErrors ?? []), ...diagnostics], drafts, unknown, canEdit, canMove, problem, present, change, save, patch, move, schedule, adoptCurrent, discardDraft, reconcile }
}

export function ProjectTaskEditingNotice({ editing, onOpen }: { editing: ProjectTaskEditing; onOpen: (item: { id: string }) => void }) {
  const t = useText()
  const readOnlyProblem = editing.files.map(file => editing.problem(file.id)).find(Boolean)
  return <div className="space-y-2 text-sm" data-pm-task-editing-notice>
    {editing.error && <p role="alert" className="text-destructive">{editing.error}</p>}
    {!editing.locked && readOnlyProblem && <p role="status">{readOnlyProblem}</p>}
    {editing.diagnostics.length > 0 && <ul>{editing.diagnostics.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.field ? `${issue.field}: ` : ""}{issue.message}</li>)}</ul>}
    {editing.locked && <p role="status">{t("写入已锁定；先等待当前操作或核对未知结果，不会自动重试。", "Writes are locked. Wait for the pending operation or reconcile its uncertain result; nothing is retried automatically.")}</p>}
    {Object.entries(editing.drafts).map(([id, draft]) => draft && <div key={id} className="space-y-2 rounded border p-3" role={draft.phase === "rejected" || draft.phase === "conflict" ? "alert" : "status"}>
      <strong>{id} · {draft.phase}</strong><p>{draft.message || t("任务字段草稿已保留，尚未保存。", "Task field draft retained; not saved yet.")}</p>
      <pre className="max-w-full overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(draft.changes, null, 2)}</pre>
      <div className="flex flex-wrap gap-2">
        {draft.phase === "unknown" && <Button size="sm" variant="outline" disabled={editing.pending} onClick={() => { void editing.reconcile(id).catch(() => {}) }}>{t("读取权威源核对", "Read authoritative source")}</Button>}
        {draft.phase !== "unknown" && draft.phase !== "observed" && <Button size="sm" disabled={!editing.canEdit(id) || draft.revision !== editing.files.find(file => file.id === id)?.revision} onClick={() => { void editing.save(id).catch(() => {}) }}>{t("保存保留的字段草稿", "Save retained field draft")}</Button>}
        {draft.phase !== "unknown" && <><Button size="sm" variant="outline" disabled={editing.pending} onClick={() => editing.adoptCurrent(id)}>{t("采用当前版本并保留字段草稿", "Adopt current revision, retain fields")}</Button><Button size="sm" variant="outline" disabled={editing.pending} onClick={() => editing.discardDraft(id)}>{t("放弃任务字段草稿", "Discard task field draft")}</Button></>}
        <Button size="sm" variant="ghost" disabled={editing.pending || draft.phase === "unknown" || draft.phase === "observed"} onClick={() => onOpen({ id })}>{t("查看完整源文件", "Inspect full source")}</Button>
      </div>
    </div>)}
  </div>
}

export function ProjectTaskInlineField({ editing, item, field, catalog }: { editing: ProjectTaskEditing; item: Pick<ControlledIssueRecord, "id" | "identifier">; field: Exclude<ProjectTaskField, "x-pm-estimate">; catalog: ControlledIssueCatalog }) {
  const t = useText()
  const file = editing.files.find(candidate => candidate.id === item.id)
  if (!file) return <span>—</span>
  const draft = editing.drafts[item.id]
  const value = projectTaskDraftValue(file, draft, field)
  const disabled = !editing.canEdit(item.id)
  const title = editing.problem(item.id) ?? undefined
  const label = { title: t("任务标题", "Task title"), status: t("任务状态", "Task status"), priority: t("任务优先级", "Task priority"), assignee: t("任务负责人", "Task assignee"), "x-pm-start": t("开始日期", "Start date"), due: t("截止日期（含当天）", "Due date (inclusive)") }[field]
  if (field === "status" || field === "priority") {
    const workflow = editing.configuration && workflowFor("work_item", editing.configuration)
    const options = field === "status" ? workflow?.states ?? [] : [{ id: "low", label: t("低", "Low") }, { id: "medium", label: t("中", "Medium") }, { id: "high", label: t("高", "High") }, { id: "urgent", label: t("紧急", "Urgent") }]
    return <RadixSelect className="min-h-9 max-w-full rounded border bg-background px-2 text-sm" aria-label={`${label} ${item.identifier}`} value={typeof value === "string" ? value : ""} disabled={disabled} title={title} onChange={event => editing.change(item.id, field === "status" ? { status: event.target.value } : { priority: projectTaskChangesSchema.shape.priority.parse(event.target.value || null) })}>
      {!value && <option value="">—</option>}{options.map(option => <option key={option.id} value={option.id} disabled={field === "status" && option.id !== file.entity.status && !workflow?.transitions.some(transition => transition.from === file.entity.status && transition.to === option.id)}>{option.label}</option>)}
    </RadixSelect>
  }
  if (field === "assignee") return <span className="inline-grid gap-1"><Input list={`project-task-assignees-${item.id}`} aria-label={`${label} ${item.identifier}`} title={title} value={typeof value === "string" ? value : ""} disabled={disabled} placeholder={t("未分配", "Unassigned")} onChange={event => editing.change(item.id, { assignee: event.target.value || null })} /><datalist id={`project-task-assignees-${item.id}`}>{catalog.assignees.map(person => <option key={person.id} value={person.id}>{person.label}</option>)}</datalist></span>
  return <Input type={field === "title" ? "text" : "date"} aria-label={`${label} ${item.identifier}`} title={title} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={event => editing.change(item.id, field === "title" ? { title: event.target.value } : field === "due" ? { due: event.target.value || null } : { "x-pm-start": event.target.value || null })} />
}

export function ProjectTaskInlineActions({ editing, item }: { editing: ProjectTaskEditing; item: Pick<ControlledIssueRecord, "id" | "identifier"> }) {
  const t = useText()
  const draft = editing.drafts[item.id]
  const current = editing.files.find(file => file.id === item.id)
  return <span className="flex flex-wrap gap-1"><Button size="sm" variant="outline" disabled={!draft || !editing.canEdit(item.id) || draft.revision !== current?.revision} onClick={() => { void editing.save(item.id).catch(() => {}) }}>{t("保存任务", "Save task")}</Button>{draft && draft.revision !== current?.revision && <Button size="sm" variant="outline" disabled={editing.locked} onClick={() => editing.adoptCurrent(item.id)}>{t("采用当前版本", "Adopt revision")}</Button>}</span>
}

export function ProjectTimeline({ projectId, items, onOpen, editing }: ProjectTimelineProps) {
  const { locale } = useI18n()
  const { actor } = usePmService()
  const planning = usePlanningDashboard()
  const [milestoneDateId, setMilestoneDateId] = useState("")
  const matching = editing?.projectId === projectId ? editing : undefined
  const visibleIds = new Set(items.map(item => item.id))
  const timelineFiles = matching?.files.filter(file => visibleIds.has(file.id)) ?? []
  const timeline = matching ? createCoreTimelineMetadata({ files: timelineFiles, contextFiles: matching.contextFiles, configuration: matching.configuration ?? undefined, projectId, en: locale === "en", actor }) : undefined
  const timelineItems: ProjectTimelineItem[] = matching && timeline ? timelineFiles.map(file => ({ id: file.id, version: file.revision, source: file, scheduleFields: { start: true, due: true }, scheduleReadOnly: !matching.canEdit(file.id) || !!matching.drafts[file.id], data: { ...timeline.forFile(file), startDate: file.entity["x-pm-start"], dueDate: file.entity.due } })) : []
  if (!matching) return <ServiceGantt items={items.map(item => ({ id: item.id, version: item.version, scheduleReadOnly: true, data: { title: item.title, status: item.stateId, projectId, assigneeId: item.assigneeIds[0], assigneeName: item.assigneeIds[0] === actor?.id ? actor.name : undefined, startDate: item.startDate, dueDate: item.dueDate } }))} onOpen={onOpen} defaultGroupBy="status" />
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-pm-project-timeline>
    <ProjectTaskEditingNotice editing={matching} onOpen={onOpen} />
    <ServiceGantt<ProjectTimelineItem> items={timelineItems} onOpen={onOpen} onSchedule={(item, start, due) => { void matching.schedule(item, start, due).catch(() => {}) }} pending={matching.pending} defaultGroupBy="status" milestones={timeline?.milestones} onOpenMilestone={id => onOpen({ id })} onEditMilestoneDates={setMilestoneDateId} canEditMilestoneDates={id => !matching.locked && planning.data?.milestones.some(milestone => milestone.id === id && milestone.editable) === true} />
    {milestoneDateId && <MilestoneReschedule projectId={projectId} milestoneId={milestoneDateId} open onOpenChange={open => { if (!open) setMilestoneDateId("") }} hideTrigger />}
  </div>
}

export interface ProjectCalendarProps extends ProjectTimelineProps {
  today: string
  visibleIds?: ReadonlySet<string>
}

/** Calendar dates use the same core revision and schedule write path as the gantt view. */
export function ProjectCalendar({ projectId, items, onOpen, editing, visibleIds, today }: ProjectCalendarProps) {
  const t = useText()
  const matching = editing?.projectId === projectId ? editing : undefined
  const calendarItems: (ScheduleItem & { source?: FileRecord })[] = matching
    ? matching.files.filter(file => !visibleIds || visibleIds.has(file.id)).map(file => ({ id: file.id, version: file.revision, source: file, scheduleFields: { start: true, due: true }, scheduleReadOnly: !matching.canEdit(file.id) || !!matching.drafts[file.id], data: { title: file.entity.title, status: file.entity.status, startDate: file.entity["x-pm-start"], dueDate: file.entity.due } }))
    : items.map(item => ({ id: item.id, version: item.version, scheduleFields: { start: true, due: true }, scheduleReadOnly: true, data: { title: item.title, status: item.stateId, startDate: item.startDate, dueDate: item.dueDate } }))
  return <div className="min-w-0 space-y-3" data-pm-project-calendar>
    {matching && <ProjectTaskEditingNotice editing={matching} onOpen={onOpen} />}
    <p className="text-sm text-muted-foreground">{t("日历日期直接写入同一 Markdown 核心任务；已有字段草稿请先保存或放弃。冲突和未知结果不会自动重试。", "Calendar dates write to the same Markdown task. Save or discard an existing field draft first; conflicts and uncertain results are never retried automatically.")}</p>
    <ServiceCalendar items={calendarItems} onOpen={item => onOpen(item)} onSchedule={matching ? (item, start, due) => {
      // Keep the editor's original source, not the latest refetched revision.
      if (item.source) void matching.schedule({ ...item, version: item.source.revision, source: item.source }, start, due).catch(() => {})
    } : undefined} pending={matching?.pending} today={today} />
  </div>
}
