import { useMemo, useRef, useState } from "react"
import { fieldRegistry, workflowFor, type FileRecord, type ProtocolConfiguration } from "@pm-schema"
import { createReferenceResolver } from "@pm-schema/relations"
import { useI18n } from "@/lib/i18n-provider"
import { ServiceCalendar } from "../components/service-calendar"
import { ServiceGantt, type TimelineMilestone } from "../components/service-gantt"
import { dateOnly, type ScheduleItem } from "../components/service-collection-shared"
import { taskStateLabel } from "../markdown/task-status-label"
import { usePmService } from "./pm-service"
import { useText } from "./pm-ui"
import { MilestoneReschedule } from "./dashboard-planning"

export type CoreScheduleViewProps = {
  files: FileRecord[]
  layout: "calendar" | "gantt"
  onSelect: (id: string) => void
  onPatch: (id: string, changes: Record<string, unknown>) => Promise<void>
  canEdit: (id: string) => boolean
  onCreate?: (due: string) => void
  today?: string | undefined
  showProject?: boolean
  contextFiles?: readonly FileRecord[]
  configuration?: ProtocolConfiguration
  projectId?: string
  toolbarTarget?: HTMLElement | null
}

const startDefinition = fieldRegistry.find(field => field.name === "start" && field.source === "yaml" && field.type === "date")
const dueDefinition = fieldRegistry.find(field => field.name === "due" && field.source === "yaml" && field.type === "date")

/** Schedule-only view data, not a fabricated PM business aggregate. */
type CoreScheduleItem = ScheduleItem & {
  source: FileRecord
  startField: "start" | "x-pm-start" | null
  scheduleFields: { start: boolean; due: boolean }
}

/** Only saved, authorized native files resolve Timeline labels and formal task blockers. */
export function createCoreTimelineMetadata({ files, contextFiles = files, configuration, projectId, en, actor }: {
  files: readonly FileRecord[]
  contextFiles?: readonly FileRecord[]
  configuration?: ProtocolConfiguration
  projectId?: string
  en: boolean
  actor: { id: string; name: string } | null
}) {
  const resolver = createReferenceResolver([...contextFiles])
  const projectIds = new Set(projectId ? [projectId] : files.flatMap(file => file.entity.entity === "project" ? [file.id] : file.entity.project ? [file.entity.project] : []))
  const usable = (file: FileRecord) => !file.stale && !file.error && !file.diagnostics?.some(diagnostic => diagnostic.severity === "error")
  function projectTitle(id: string | undefined) {
    const project = id ? resolver.resolveId(id).file : undefined
    return project?.entity.entity === "project" ? project.entity.title : undefined
  }
  function forFile(file: FileRecord): ScheduleItem["data"] {
    const entity = file.entity
    const id = entity.entity === "project" ? file.id : entity.project
    const state = configuration ? workflowFor(entity.entity, configuration)?.states.find(candidate => candidate.id === entity.status) : undefined
    const dependencies = entity.entity === "work_item" && usable(file) ? [...new Set(entity.blocked_by)].filter(targetId => {
      const target = resolver.resolveId(targetId).file
      return target && target.id !== file.id && target.entity.entity === "work_item" && usable(target)
    }) : []
    return {
      title: entity.title,
      status: entity.status,
      projectId: id,
      projectTitle: projectTitle(id),
      statusLabel: state ? taskStateLabel(state, en) : entity.status,
      statusCategory: state?.category,
      assigneeId: entity.assignee,
      assigneeName: entity.assignee && entity.assignee === actor?.id ? actor.name : undefined,
      dependencies,
    }
  }
  const milestones: TimelineMilestone[] = contextFiles.flatMap(file => {
    const entity = file.entity
    const date = dateOnly(entity.due)
    if (entity.entity !== "milestone" || entity.archived || !usable(file) || !date || !entity.project || !projectIds.has(entity.project) || resolver.resolveId(file.id).file !== file) return []
    return [{ id: file.id, title: entity.title, date, projectId: entity.project, projectTitle: projectTitle(entity.project) }]
  })
  return { forFile, milestones }
}

export function CoreScheduleView({ files, layout, onSelect, onPatch, canEdit, onCreate, today, showProject = false, contextFiles, configuration, projectId, toolbarTarget }: CoreScheduleViewProps) {
  const t = useText()
  const { locale } = useI18n()
  const { actor } = usePmService()
  const timeline = useMemo(() => layout === "gantt" ? createCoreTimelineMetadata({ files, contextFiles, configuration, projectId, en: locale === "en", actor }) : null, [files, contextFiles, configuration, projectId, locale, actor, layout])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [milestoneDateId, setMilestoneDateId] = useState("")
  const saving = useRef(false)
  const items = useMemo<CoreScheduleItem[]>(() => files.map(file => {
    const kind = file.entity.entity
    // Work items persist their PM start in an extension; other kinds use only registered dates.
    const startField = startDefinition?.entities.includes(kind) ? "start" : kind === "work_item" ? "x-pm-start" : null
    const hasDue = dueDefinition?.entities.includes(kind) === true
    const scheduleFields = {
      start: startField === "x-pm-start" || (startField === "start" && startDefinition?.editable === true),
      due: hasDue && dueDefinition?.editable === true,
    }
    return {
      id: file.id,
      version: file.revision,
      source: file,
      startField,
      scheduleFields,
      scheduleReadOnly: (!scheduleFields.start && !scheduleFields.due) || !canEdit(file.id) || file.entity.archived === true || !!file.stale || !!file.error || !!file.diagnostics?.some(diagnostic => diagnostic.severity === "error"),
      data: {
        ...(timeline ? timeline.forFile(file) : {
          title: showProject && file.entity.project ? `${file.entity.project} · ${file.entity.title}` : file.entity.title,
          status: file.entity.status,
        }),
        startDate: startField ? file.entity[startField] : undefined,
        dueDate: hasDue ? file.entity.due : undefined,
      },
    }
  }), [files, canEdit, showProject, timeline])

  async function schedule(item: CoreScheduleItem, startDate: string | null, dueDate: string | null) {
    if (saving.current) return
    setError(null)
    const current = items.find(candidate => candidate.id === item.id)
    if (!current || current.scheduleReadOnly || !canEdit(item.id)) {
      setError(t("此对象存在未保存草稿或当前不可编辑。请在同一对象中处理草稿、只读状态或权限。", "This entity has an unsaved draft or is not editable. Resolve its draft, read-only state, or permissions in the same entity."))
      return
    }
    if (current.version !== item.version || current.source.raw !== item.source.raw) {
      setError(t("源文件已变化；日期草稿未写入。请采用当前版本后重试。", "The source changed; the date draft was not written. Use the current version before retrying."))
      return
    }
    if ((!current.scheduleFields.start && startDate !== null) || (!current.scheduleFields.due && dueDate !== null)) {
      setError(t("此对象类型不支持所请求的日期字段。", "This entity type does not support the requested date field."))
      return
    }
    if ((startDate !== null && !dateOnly(startDate)) || (dueDate !== null && !dateOnly(dueDate)) || (startDate && dueDate && startDate > dueDate)) {
      setError(t("请输入有效的全天日期；截止日期不能早于开始日期。", "Enter valid all-day dates; the due date cannot precede the start date."))
      return
    }
    const changes: Record<string, unknown> = {}
    if (current.scheduleFields.start && current.startField && startDate !== (current.source.entity[current.startField] ?? null)) changes[current.startField] = startDate
    if (current.scheduleFields.due && dueDate !== (current.source.entity.due ?? null)) changes.due = dueDate
    if (!Object.keys(changes).length) return
    saving.current = true
    setPending(true)
    try {
      // The host owns revision/conflict handling and updates the same core cache.
      await onPatch(item.id, changes)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  const calendar = <ServiceCalendar<CoreScheduleItem> items={items} onOpen={item => onSelect(item.id)} onSchedule={items.some(item => !item.scheduleReadOnly) ? (item, start, due) => { void schedule(item, start, due) } : undefined} pending={pending} onCreate={onCreate} today={today} />
  return <div className={layout === "gantt" ? "flex min-h-0 min-w-0 flex-1 flex-col gap-3" : "min-w-0 space-y-3"}>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {layout === "calendar" ? calendar : <ServiceGantt<CoreScheduleItem> items={items} onOpen={item => onSelect(item.id)} onSchedule={items.some(item => !item.scheduleReadOnly) ? (item, start, due) => { void schedule(item, start, due) } : undefined} pending={pending} today={today} defaultGroupBy={projectId ? "status" : "project"} milestones={timeline?.milestones} onOpenMilestone={onSelect} onEditMilestoneDates={setMilestoneDateId} canEditMilestoneDates={canEdit} toolbarTarget={toolbarTarget} />}
    {milestoneDateId && <MilestoneReschedule milestoneId={milestoneDateId} open onOpenChange={open => { if (!open) setMilestoneDateId("") }} hideTrigger />}
  </div>
}
