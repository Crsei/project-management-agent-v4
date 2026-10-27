import { useCallback, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n-provider"
import { usePmControlsReady } from "./domain-session"
import {
  addScheduleDays,
} from "@/lib/schedule-date-utils"
import { isMutationLocked } from "@/lib/work-items-model"
import type { PmPageProps } from "./model"
import type { PmIssue } from "./issue-domain"
import { PmDataBoundary, usePmScenarioState } from "./shared"
import { HourCalendarView, HOUR_HEIGHT, formatHourDuration as formatDuration } from "./hour-calendar"
import type { HourCalendarEvent, HourCalendarInteraction, HourCalendarMove, HourCalendarResize } from "./hour-calendar-contracts"
import {
  ScheduleAddIssueDialog,
  ScheduleOutcomeField,
  emptyAddIssueDraft,
  useScheduleIssuePage,
  type AddIssueDraft,
} from "./schedule-views"
import styles from "./schedule-views.module.css"

const today = "2026-01-12"
const displayZones = ["UTC", "Asia/Shanghai", "America/New_York"] as const
type DisplayZone = (typeof displayZones)[number]

type HourDraft = {
  /** Timed: display-zone "YYYY-MM-DDTHH:mm" exactly as requested.
   * All-day: "YYYY-MM-DD", end inclusive. Raw walls are never normalized away. */
  startWall: string
  endWall: string
  allDay: boolean
  baseRevision: number
  zone: DisplayZone
}

type WallResolution =
  { status: "ok"; iso: string } | { status: "invalid" } | { status: "gap" }

/** Wall time (display zone) <-> UTC instant. Storage stays UTC; display never mutates values. */
function zoneOffsetMs(instantMs: number, zone: DisplayZone): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantMs))
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value)
  return (
    Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    ) - instantMs
  )
}


/** Strict wall -> instant for commit paths. Round-trip validation rejects DST gap
 * walls (a local time that never exists) instead of silently normalizing them.
 * Ambiguous fall-back walls resolve deterministically to the first, pre-transition
 * occurrence (two-pass offset keeps the offset in effect before the jump). */
function resolveWall(wall: string, zone: DisplayZone): WallResolution {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(wall))
    return { status: "invalid" }
  const naive = Date.parse(`${wall}:00Z`)
  if (!Number.isFinite(naive)) return { status: "invalid" }
  const offset1 = zoneOffsetMs(naive, zone)
  const offset2 = zoneOffsetMs(naive - offset1, zone)
  const iso = new Date(naive - offset2).toISOString().replace(/\.\d{3}Z$/, "Z")
  return instantToWall(iso, zone) === wall
    ? { status: "ok", iso }
    : { status: "gap" }
}

/** Draft walls for an entity: all-day keeps pure UTC date semantics (end inclusive,
 * matching the lane); timed captures the display-zone wall exactly as displayed. */
function createDraft(
  item: PmIssue,
  anchor: string,
  zone: DisplayZone,
): HourDraft {
  if (item.allDay) {
    const startDay = (item.startAt ?? "").slice(0, 10) || anchor
    const endDay = item.endAt
      ? addScheduleDays(item.endAt.slice(0, 10), -1)
      : startDay
    return {
      startWall: startDay,
      endWall: endDay,
      allDay: true,
      baseRevision: item.revision,
      zone,
    }
  }
  return {
    startWall: item.startAt
      ? instantToWall(item.startAt, zone)
      : `${anchor}T09:00`,
    endWall: item.endAt ? instantToWall(item.endAt, zone) : `${anchor}T10:00`,
    allDay: false,
    baseRevision: item.revision,
    zone,
  }
}

/** Resolve draft walls to commit-ready instants without ever rewriting the walls.
 * A DST gap wall reports `gap` so the editor can reject instead of normalizing. */
function resolveDraft(
  draft: HourDraft,
  zone: DisplayZone,
): {
  gap: boolean
  invalid: boolean
  startIso: string
  endIso: string
} {
  if (draft.allDay) {
    const valid =
      /^\d{4}-\d{2}-\d{2}$/.test(draft.startWall) &&
      /^\d{4}-\d{2}-\d{2}$/.test(draft.endWall)
    return valid
      ? {
          gap: false,
          invalid: false,
          startIso: `${draft.startWall}T00:00:00Z`,
          endIso: `${addScheduleDays(draft.endWall, 1)}T00:00:00Z`,
        }
      : { gap: false, invalid: true, startIso: "", endIso: "" }
  }
  const start = resolveWall(draft.startWall, zone)
  const end = resolveWall(draft.endWall, zone)
  return {
    gap: start.status === "gap" || end.status === "gap",
    invalid: start.status === "invalid" || end.status === "invalid",
    startIso: start.status === "ok" ? start.iso : "",
    endIso: end.status === "ok" ? end.iso : "",
  }
}

function instantToWall(iso: string, zone: DisplayZone): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(Date.parse(iso)))
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00"
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`
}

export function IssueCalendar2FixtureView({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const interactive = usePmControlsReady()
  const en = locale === "en"
  const page = useScheduleIssuePage(scenario, "issue-calendar-2")
  const [anchor, setAnchor] = usePmScenarioState<string>(
    "issue-calendar-2:anchor",
    () => today,
  )
  const [zone, setZone] = usePmScenarioState<DisplayZone>(
    "issue-calendar-2:zone",
    () => "UTC",
  )
  const [selectedId, setSelectedId] = usePmScenarioState<string | null>(
    "issue-calendar-2:selected",
    () => null,
  )
  const [drafts, setDrafts] = usePmScenarioState<
    Record<string, HourDraft | undefined>
  >(
    "issue-calendar-2:drafts",
    () => ({}),
    (cached) => {
      // Old live drafts used the current display zone at commit. Capture it once
      // when upgrading the cache, without discarding walls or base revisions.
      const previous = cached as Record<string, HourDraft | undefined>
      let restored = previous
      for (const id in previous) {
        const draft = previous[id]
        if (draft && draft.zone === undefined) {
          if (restored === previous) restored = { ...previous }
          restored[id] = { ...draft, zone }
        }
      }
      return restored
    },
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [addDraft, setAddDraft] = usePmScenarioState<AddIssueDraft | null>(
    "issue-calendar-2:add-draft",
    () => null,
  )
  const [addOpen, setAddOpen] = usePmScenarioState<boolean>(
    "issue-calendar-2:add-open",
    () => false,
  )
  const editorTrigger = useRef<HTMLElement | null>(null)
  const [hourScroll, setHourScroll] = usePmScenarioState<number>("issue-calendar-2:hour-scroll", () => 8 * HOUR_HEIGHT)
  const [extraInteraction, setExtraInteraction] = usePmScenarioState<Pick<HourCalendarInteraction, "mode" | "filters" | "secondaryOpen">>("issue-calendar-2:extra-interaction", () => ({ mode: "week", filters: { query: "", projectIds: [] }, secondaryOpen: false }))

  const editing = editingId
    ? page.items.find((item) => item.id === editingId)
    : undefined
  const editingDraft = editingId ? drafts[editingId] : undefined
  const editingLocked =
    !!editing && isMutationLocked(page.mutationFor(editing.id))
  const editingResolution = editingDraft
    ? resolveDraft(editingDraft, editingDraft.zone)
    : null
  const wallProblem = !editingDraft
    ? null
    : editingResolution?.gap
      ? en
        ? "This local time does not exist in the display zone (DST gap). Pick another time."
        : "该本地时间在显示时区不存在（时区跳变），请另选时间。"
      : editingResolution?.invalid
        ? en
          ? "Invalid local time value."
          : "本地时间无效。"
        : null
  const fieldInvalid = !!wallProblem || (!!editorError && !!editingResolution && editorError === draftError(editingResolution))
  const fieldErrorId = wallProblem ? "pm-hour-wall-error" : editorError ? "pm-hour-editor-error" : undefined

  const openEditor = useCallback(
    (item: PmIssue, trigger?: HTMLElement | null) => {
      if (page.loading) return
      editorTrigger.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      setSelectedId(item.id)
      setEditorError(null)
      setDrafts((previous) => ({
        ...previous,
        [item.id]: previous[item.id] ?? createDraft(item, anchor, zone),
      }))
      setEditingId(item.id)
    },
    [page.loading, anchor, zone, setSelectedId, setDrafts],
  )

  const updateDraft = useCallback(
    (itemId: string, patch: Partial<HourDraft>) => {
      setEditorError(null)
      setDrafts((previous) => {
        const draft = previous[itemId]
        if (!draft) return previous
        return { ...previous, [itemId]: { ...draft, ...patch } }
      })
    },
    [setDrafts],
  )

  function draftError(resolution: {
    gap: boolean
    invalid: boolean
    startIso: string
    endIso: string
  }): string | null {
    if (resolution.gap || resolution.invalid) return null
    const start = Date.parse(resolution.startIso),
      end = Date.parse(resolution.endIso)
    if (!Number.isFinite(start) || !Number.isFinite(end))
      return en ? "Invalid RFC3339 instant." : "RFC3339 时间无效。"
    return end <= start
      ? en
        ? "End must be after start."
        : "结束必须晚于开始。"
      : null
  }

  function saveDraft() {
    if (page.blocked || !editing || !editingDraft || editingLocked) return
    if (wallProblem || !editingResolution) {
      setEditorError(wallProblem)
      return
    }
    const problem = draftError(editingResolution)
    if (problem) {
      setEditorError(problem)
      return
    }
    const status = page.submitPatch(
      editing.id,
      editingDraft.allDay
        ? {
            startAt: editingResolution.startIso,
            endAt: editingResolution.endIso,

            timeZone: "UTC",
            allDay: true,
          }
        : {
            startAt: editingResolution.startIso,
            endAt: editingResolution.endIso,

            timeZone: "UTC",
            allDay: false,
          },
      editingDraft.baseRevision,
    )
    if (status === "confirmed") {
      setDrafts((previous) => ({ ...previous, [editing.id]: undefined }))
      setEditingId(null)
      setEditorError(null)
    } else if (status === "rejected") {
      setEditorError(
        en
          ? "Change rejected: the previous schedule and this draft are preserved."
          : "更改被拒绝：原排期与本草稿均已保留。",
      )
    } else {
      setEditorError(
        en
          ? "Outcome unknown: this request is locked. Check the simulated result explicitly."
          : "结果未知：请求已锁定，请显式核对模拟结果。",
      )
    }
  }

  function reconcileEvent(itemId: string) {
    if (page.blocked) return
    const status = page.reconcile(itemId)
    if (status === "confirmed") {
      setDrafts((previous) => ({ ...previous, [itemId]: undefined }))
      if (editingId === itemId) {
        setEditingId(null)
        setEditorError(null)
      }
    } else if (status === "rejected" && editingId === itemId) {
      setEditorError(en
        ? "Change rejected: the previous schedule and this editable draft are preserved."
        : "更改被拒绝：原排期与可编辑草稿均已保留。",
      )
    }
  }

  function reconcileEditing() {
    if (editing) reconcileEvent(editing.id)
  }

  const editorZoneNote = en
    ? `Local fixture only. Draft time zone: ${editingDraft?.zone ?? zone}. Date-only schedule is unchanged.`
    : `仅本地模拟。草稿时区：${editingDraft?.zone ?? zone}。日期排期保持不变。`
  // Fixture-only adaptation: Issue hour fields are never used by Product.
  const events = useMemo<HourCalendarEvent[]>(() => page.items.filter((item) => !!item.startAt && !!item.endAt).map((item) => ({ id: item.id, issueId: item.id, projectId: item.projectId ?? "", title: item.title, startAt: item.startAt!, endAt: item.endAt!, timeZone: item.timeZone, allDay: item.allDay, version: String(item.revision) })), [page.items])
  const issueSources = useMemo(() => page.items.filter((item) => !item.startAt || !item.endAt).map((item) => ({ id: item.id, projectId: item.projectId ?? "", identifier: item.identifier, title: item.title, startDate: item.startDate ?? null, dueDate: item.dueDate })), [page.items])
  const interaction: HourCalendarInteraction = { anchorDate: anchor, displayZone: zone, selectedId, reading: { top: hourScroll, left: 0 }, ...extraInteraction }
  function setInteraction(action: HourCalendarInteraction | ((current: HourCalendarInteraction) => HourCalendarInteraction)) {
    const next = typeof action === "function" ? action(interaction) : action
    setAnchor(next.anchorDate)
    setZone(next.displayZone as DisplayZone)
    setSelectedId(next.selectedId)
    setHourScroll(next.reading.top)
    setExtraInteraction({ mode: next.mode, filters: next.filters, secondaryOpen: next.secondaryOpen })
  }
  function fixtureItem(event: HourCalendarEvent) { return page.items.find((item) => item.id === event.id) }
  function moveFixture(event: HourCalendarEvent, intent: HourCalendarMove) {
    const item = fixtureItem(event)
    if (!item || page.blocked || isMutationLocked(page.mutationFor(item.id))) return
    if (intent.kind === "elapsed") {
      page.submitPatch(item.id, { startAt: new Date(Date.parse(event.startAt) + intent.deltaMinutes * 60000).toISOString(), endAt: new Date(Date.parse(event.endAt) + intent.deltaMinutes * 60000).toISOString() }, item.revision)
      return
    }
    const draft = createDraft(item, anchor, zone)
    const shiftWall = (wall: string) => addScheduleDays(wall.slice(0, 10), intent.days) + wall.slice(10)
    const resolution = resolveDraft({ ...draft, startWall: shiftWall(draft.startWall), endWall: shiftWall(draft.endWall) }, draft.zone)
    if (resolution.gap || resolution.invalid || draftError(resolution)) return
    page.submitPatch(item.id, { startAt: resolution.startIso, endAt: resolution.endIso }, item.revision)
  }
  function resizeFixture(event: HourCalendarEvent, intent: HourCalendarResize) {
    const item = fixtureItem(event)
    if (!item || page.blocked || isMutationLocked(page.mutationFor(item.id))) return
    const end = Date.parse(event.endAt) + intent.deltaMinutes * 60000
    if (end > Date.parse(event.startAt)) page.submitPatch(item.id, { endAt: new Date(end).toISOString() }, item.revision)
  }
  return <HourCalendarView
    interactive={interactive}
    readModel={{ events, issueSources, today, projects: [], mutations: page.domain.mutations, data: { state: page.loading ? "loading" : page.items.length ? "success" : "empty" }, displayZones, sourceDescription: en ? "Local fixture only; date-only issue schedule is unchanged." : "仅本地模拟；任务日期排期保持不变。", presentation: Object.fromEntries(page.items.map((item) => [item.id, { identifier: item.identifier, color: page.catalog.states.find((state) => state.id === item.stateId)?.color }])) }}
    interaction={interaction}
    capabilities={{ create: !page.blocked, edit: () => !page.blocked, move: () => !page.blocked, resize: () => !page.blocked, delete: () => !page.blocked, reason: page.capabilities.reason }}
    actions={{ setInteraction,
      create: () => { if (!addDraft) setAddDraft(emptyAddIssueDraft(page.catalog)); setAddOpen(true) },
      edit: (event, trigger) => { const item = fixtureItem(event); if (item) openEditor(item, trigger) },
      move: moveFixture, resize: resizeFixture,
      delete: (event) => { const item = fixtureItem(event); if (item && !page.blocked && !isMutationLocked(page.mutationFor(item.id))) page.submitPatch(item.id, { startAt: null, endAt: null, allDay: false }, item.revision) },
      openIssue: (id) => { const item = page.items.find((entry) => entry.id === id); if (item) page.getPresentation(item).onOpen(item) },
      reconcile: (id) => reconcileEvent(id),
    }}
    onScheduleIssue={(source, trigger) => { const item = page.items.find((entry) => entry.id === source.id); if (item) openEditor(item, trigger) }}
    settingsSlot={<ScheduleOutcomeField id="pm-calendar-2" page={page} disabled={page.blocked} />}
    dataBoundary={(children) => <PmDataBoundary scenario={scenario} empty={page.items.length === 0} emptyDescription={en ? "No issues in this local scene." : "当前本地场景没有任务。"}>{children}</PmDataBoundary>}
    editDialog={
      <Sheet
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditingId(null)
            setEditorError(null)
          }
        }}
      >
        <SheetContent size={576} className="pm-hour-editor">
          <SheetHeader className={styles.createHeader} data-pm-hour-editor-header>
            <SheetTitle className="text-lg font-semibold">{editing?.title}</SheetTitle>
            <SheetDescription>{editorZoneNote}</SheetDescription>
          </SheetHeader>
          <SheetBody className={`${styles.createBody} space-y-6`} data-pm-hour-editor-body>
            {editing && (
              <div className="grid gap-6" data-pm-hour-issue-context>
                <div className="rounded-xl border bg-surface-raised p-3">
                  <p className="text-xs text-muted-foreground">{en ? "Issue key" : "任务编号"}</p>
                  <p className="mt-1 text-sm font-semibold">{editing.identifier}</p>
                </div>
                <Field label={en ? "Issue title · read only" : "任务标题 · 只读"}>
                  {(control) => <Input {...control} readOnly value={editing.title} />}
                </Field>
                <Field label={en ? "Description · read only" : "描述 · 只读"}>
                  {(control) => <Textarea {...control} readOnly rows={4} value={editing.description} />}
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label={en ? "Status · read only" : "状态 · 只读"}>
                    {(control) => <Input {...control} readOnly value={page.catalog.states.find((state) => state.id === editing.stateId)?.label ?? "—"} />}
                  </Field>
                  <Field label={en ? "Priority · read only" : "优先级 · 只读"}>
                    {(control) => <Input {...control} readOnly value={page.catalog.priorities.find((priority) => priority.id === editing.priorityId)?.label ?? "—"} />}
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field label={en ? "Issue start date · read only" : "任务开始日期 · 只读"}>
                    {(control) => <Input {...control} readOnly value={editing.startDate ?? "—"} />}
                  </Field>
                  <Field label={en ? "Target date · read only" : "目标日期 · 只读"}>
                    {(control) => <Input {...control} readOnly value={editing.dueDate ?? "—"} />}
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">{en ? "Issue properties remain read only here. Only the hour/all-day schedule below is saved." : "此处任务属性只读；仅保存下方小时／全天排期。"}</p>
              </div>
            )}
            {editing && editingDraft && editingResolution ? (
              <div className={styles.editorGrid} data-pm-time-fields>
                <label className={styles.editorRow}>
                  <Checkbox

                    checked={editingDraft.allDay}
                    disabled={page.blocked || editingLocked}
                    onCheckedChange={(checked) => {
                      const toAllDay = checked === true
                      if (toAllDay) {
                        const endDay = editingDraft.endWall.includes("T")
                          ? editingDraft.endWall.slice(11) === "00:00"
                            ? addScheduleDays(
                                editingDraft.endWall.slice(0, 10),
                                -1,
                              )
                            : editingDraft.endWall.slice(0, 10)
                          : editingDraft.endWall
                        updateDraft(editing.id, {
                          allDay: true,
                          startWall: editingDraft.startWall.slice(0, 10),
                          endWall: endDay,
                        })
                      } else {
                        updateDraft(editing.id, {
                          allDay: false,
                          startWall: `${editingDraft.startWall}T09:00`,
                          endWall: `${editingDraft.endWall}T10:00`,
                        })
                      }
                    }}
                  />
                  {en ? "All-day event" : "全天事件"}
                </label>
                {editingDraft.allDay ? (
                  <div data-pm-time-pair>
                    <div className={styles.editorRow} data-pm-time-row>
                      <label htmlFor={`pm-hour-start-${editing.id}`}>
                        {en ? "Start day" : "开始日期"}
                      </label>
                      <Input
                        id={`pm-hour-start-${editing.id}`}
                        type="date"
                        className="w-40"
                        value={
                          /^\d{4}-\d{2}-\d{2}$/.test(editingDraft.startWall)
                            ? editingDraft.startWall
                            : ""
                        }
                        disabled={page.blocked || editingLocked}
                        aria-invalid={fieldInvalid}
                        aria-describedby={fieldErrorId}
                        onChange={(event) =>
                          updateDraft(editing.id, {
                            startWall: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className={styles.editorRow} data-pm-time-row>
                      <label htmlFor={`pm-hour-end-${editing.id}`}>
                        {en ? "End day (inclusive)" : "结束日期（含当天）"}
                      </label>
                      <Input
                        id={`pm-hour-end-${editing.id}`}
                        type="date"
                        className="w-40"
                        value={
                          /^\d{4}-\d{2}-\d{2}$/.test(editingDraft.endWall)
                            ? editingDraft.endWall
                            : ""
                        }
                        disabled={page.blocked || editingLocked}
                        aria-invalid={fieldInvalid}
                        aria-describedby={fieldErrorId}
                        onChange={(event) =>
                          updateDraft(editing.id, {
                            endWall: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div data-pm-time-pair>
                    <div className={styles.editorRow} data-pm-time-row>
                      <label htmlFor={`pm-hour-start-${editing.id}`}>
                        {en ? "Start" : "开始"}
                      </label>
                      <Input
                        id={`pm-hour-start-${editing.id}`}
                        type="datetime-local"
                        className="w-52"
                        value={editingDraft.startWall}
                        disabled={page.blocked || editingLocked}
                        aria-invalid={fieldInvalid}
                        aria-describedby={fieldErrorId}
                        onChange={(event) =>
                          updateDraft(editing.id, {
                            startWall: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className={styles.editorRow} data-pm-time-row>
                      <label htmlFor={`pm-hour-end-${editing.id}`}>
                        {en ? "End" : "结束"}
                      </label>
                      <Input
                        id={`pm-hour-end-${editing.id}`}
                        type="datetime-local"
                        className="w-52"
                        value={editingDraft.endWall}
                        disabled={page.blocked || editingLocked}
                        aria-invalid={fieldInvalid}
                        aria-describedby={fieldErrorId}
                        onChange={(event) =>
                          updateDraft(editing.id, {
                            endWall: event.target.value,
                          })
                        }
                      />
                    </div>
                    <p className={`${styles.duration} pm-hour-duration`}>
                      {en ? "Duration" : "时长"}:{" "}
                      {wallProblem
                        ? "—"
                        : formatDuration(
                            (Date.parse(editingResolution.endIso) -
                              Date.parse(editingResolution.startIso)) /
                              60000,
                          )}
                    </p>
                  </div>
                )}
                <p className={styles.rfcPreview}>
                  {wallProblem
                    ? `${en ? "requested" : "请求"}: ${editingDraft.startWall} → ${editingDraft.endWall} (${editingDraft.zone})`
                    : `startAt: ${editingResolution.startIso} · endAt: ${editingResolution.endIso}`}
                  {" · "}
                  {en ? "base revision" : "基础版本"}:{" "}
                  {editingDraft.baseRevision}
                </p>
                {wallProblem && (
                  <p id="pm-hour-wall-error" role="alert" className="text-sm text-destructive">
                    {wallProblem}
                  </p>
                )}
                {editingLocked && (
                  <p role="status" className="text-sm">
                    {en
                      ? "Locked while the result is unknown."
                      : "结果未知期间已锁定。"}
                  </p>
                )}
                {editorError && (
                  <p id="pm-hour-editor-error" role="alert" className="text-sm text-destructive">
                    {editorError}
                  </p>
                )}
                {editingLocked && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={page.blocked} onClick={reconcileEditing}>
                      {en ? "Check result" : "核对结果"}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <p>{en ? "Draft closed." : "草稿已关闭。"}</p>
            )}
          </SheetBody>
          <SheetFooter className={styles.createFooter} data-pm-hour-editor-footer>
            <Button variant="ghost" className="mr-auto" disabled={!editing} onClick={() => {
              if (!editing) return
              setEditingId(null)
              page.getPresentation(editing).onOpen?.(editing)
            }}>{en ? "Open issue" : "打开任务"}</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditingId(null)
                setEditorError(null)
              }}
            >
              {en ? "Cancel · keep draft" : "取消 · 保留草稿"}
            </Button>
            <Button
              onClick={saveDraft}
              disabled={
                page.blocked || editingLocked || !editingDraft || !!wallProblem
              }
            >
              {en ? "Save" : "保存"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

    }
    createDialog={
      <ScheduleAddIssueDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        page={page}
        draft={addDraft}
        setDraft={setAddDraft}
      />
    }
  />
}
