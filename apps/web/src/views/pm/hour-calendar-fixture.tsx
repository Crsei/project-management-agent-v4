import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/field"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert } from "@/components/ui/alert"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@/components/ui/sheet"
import { useI18n } from "@/lib/i18n-provider"
import { HourCalendarView } from "./hour-calendar"
import { pmClock } from "./model"
import type {
  HourCalendarActions,
  HourCalendarCapabilities,
  HourCalendarEvent,
  HourCalendarInteraction,
  HourCalendarReadModel,
} from "./hour-calendar-contracts"
import { RadixSelect } from "@/components/ui/radix-select"

const day = (offset: number) =>
  new Date(Date.parse(pmClock) + offset * 86400000).toISOString()
const at = (offset: number, hour: number, minute = 0) => {
  const base = new Date(Date.parse(pmClock) + offset * 86400000)
  base.setUTCHours(hour, minute, 0, 0)
  return base.toISOString()
}

const initialEvents: HourCalendarEvent[] = [
  {
    id: "event-standup",
    issueId: "issue-102",
    projectId: "project-platform",
    title: "每日站会",
    startAt: at(0, 1, 30),
    endAt: at(0, 2, 0),
    timeZone: "UTC",
    allDay: false,
    version: "v1",
  },
  {
    id: "event-review",
    issueId: "issue-118",
    projectId: "project-platform",
    title: "迭代评审",
    startAt: at(1, 3, 0),
    endAt: at(1, 5, 0),
    timeZone: "UTC",
    allDay: false,
    version: "v1",
  },
  {
    id: "event-cross-day",
    issueId: null,
    projectId: "project-mobile",
    title: "跨时区值班",
    startAt: at(2, 14, 0),
    endAt: at(3, 2, 0),
    timeZone: "UTC",
    allDay: false,
    version: "v1",
  },
  {
    id: "event-release",
    issueId: "issue-131",
    projectId: "project-mobile",
    title: "发布窗口",
    startAt: day(4),
    endAt: day(5),
    timeZone: "UTC",
    allDay: true,
    version: "v1",
  },
]

const issueSources = [
  {
    id: "issue-102",
    projectId: "project-platform",
    identifier: "PM-102",
    title: "补齐仪表盘权限矩阵",
    startDate: pmClock.slice(0, 10),
    dueDate: day(2).slice(0, 10),
  },
  {
    id: "issue-118",
    projectId: "project-platform",
    identifier: "PM-118",
    title: "评审依赖地图配色",
    startDate: null,
    dueDate: day(1).slice(0, 10),
  },
]

type EditorState =
  | { kind: "create"; defaults: { date: string; timeZone: string; allDay: boolean } }
  | { kind: "edit"; event: HourCalendarEvent }
  | null

export function HourCalendarFixtureView() {
  const { locale } = useI18n()
  const en = locale === "en"
  const navigate = useNavigate()
  const params = useParams()
  const [events, setEvents] = useState<HourCalendarEvent[]>(initialEvents)
  const [editor, setEditor] = useState<EditorState>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [draftAllDay, setDraftAllDay] = useState(false)
  const [draftStart, setDraftStart] = useState("")
  const [draftEnd, setDraftEnd] = useState("")
  const [draftZone, setDraftZone] = useState("UTC")
  const [interaction, setInteraction] = useState<HourCalendarInteraction>({
    anchorDate: pmClock.slice(0, 10),
    displayZone: "UTC",
    selectedId: null,
    reading: { top: 0, left: 0 },
    mode: "week",
    filters: { query: "", projectIds: [] },
    secondaryOpen: true,
  })

  const readModel = useMemo<HourCalendarReadModel>(
    () => ({
      events,
      issueSources,
      data: { state: "success" },
      today: pmClock.slice(0, 10),
      mutations: {},
      projects: [
        { id: "project-platform", label: en ? "Platform" : "平台" },
        { id: "project-mobile", label: en ? "Mobile" : "移动端" },
      ],
      presentation: Object.fromEntries(
        events.map((event) => [
          event.id,
          {
            identifier: issueSources.find((issue) => issue.id === event.issueId)?.identifier,
            color:
              event.projectId === "project-platform"
                ? "var(--status-info)"
                : "var(--status-success)",
          },
        ]),
      ),
      displayZones: ["UTC", "Asia/Shanghai", "America/Los_Angeles"],
      sourceDescription: en
        ? "Demo fixture events; edits stay in this browser session."
        : "演示 fixture 事件；编辑仅保留在当前浏览器会话。",
    }),
    [events, en],
  )

  const capabilities = useMemo<HourCalendarCapabilities>(
    () => ({
      create: true,
      edit: () => true,
      move: () => true,
      resize: () => true,
      delete: () => true,
    }),
    [],
  )

  const shift = (event: HourCalendarEvent, deltaMs: number) => ({
    ...event,
    startAt: new Date(Date.parse(event.startAt) + deltaMs).toISOString(),
    endAt: new Date(Date.parse(event.endAt) + deltaMs).toISOString(),
    version: `v${Number(event.version.slice(1) || "1") + 1}`,
  })

  const openEditor = (state: EditorState) => {
    setEditor(state)
    if (state?.kind === "create") {
      setDraftTitle("")
      setDraftAllDay(state.defaults.allDay)
      setDraftStart(`${state.defaults.date}T09:00`)
      setDraftEnd(`${state.defaults.date}T10:00`)
      setDraftZone(state.defaults.timeZone)
    } else if (state?.kind === "edit") {
      setDraftTitle(state.event.title)
      setDraftAllDay(state.event.allDay)
      setDraftStart(toLocalInput(state.event.startAt))
      setDraftEnd(toLocalInput(state.event.endAt))
      setDraftZone(state.event.timeZone)
    }
  }

  const actions = useMemo<HourCalendarActions>(
    () => ({
      setInteraction,
      create: (defaults, trigger) => {
        setInteraction((current) => ({ ...current, selectedId: null }))
        openEditor({ kind: "create", defaults })
        trigger?.blur()
      },
      edit: (event) => openEditor({ kind: "edit", event }),
      move: (event, intent) =>
        setEvents((current) =>
          current.map((item) =>
            item.id === event.id
              ? shift(
                  item,
                  intent.kind === "elapsed"
                    ? intent.deltaMinutes * 60000
                    : intent.days * 86400000,
                )
              : item,
          ),
        ),
      resize: (event, intent) =>
        setEvents((current) =>
          current.map((item) =>
            item.id === event.id
              ? {
                  ...item,
                  endAt: new Date(
                    Date.parse(item.endAt) + intent.deltaMinutes * 60000,
                  ).toISOString(),
                  version: `v${Number(item.version.slice(1) || "1") + 1}`,
                }
              : item,
          ),
        ),
      delete: (event) => {
        setEvents((current) => current.filter((item) => item.id !== event.id))
        setInteraction((current) =>
          current.selectedId === event.id
            ? { ...current, selectedId: null }
            : current,
        )
      },
      openIssue: (issueId) => {
        const workspace = params.workspaceSlug ?? "execra-ai"
        navigate(
          `/lab/pm/${encodeURIComponent(workspace)}/projects/project-platform/issues/${encodeURIComponent(issueId)}?view=detail1`,
        )
      },
      reconcile: () => {},
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- navigate/params are stable per route
    [],
  )

  const saveEditor = () => {
    if (editor?.kind !== "edit") {
      const id = `event-${Date.now().toString(36)}`
      setEvents((current) => [
        ...current,
        {
          id,
          issueId: null,
          projectId: "project-platform",
          title: draftTitle || (en ? "New event" : "新事件"),
          startAt: new Date(draftStart).toISOString(),
          endAt: new Date(draftEnd).toISOString(),
          timeZone: draftZone,
          allDay: draftAllDay,
          version: "v1",
        },
      ])
    } else {
      const id = editor.event.id
      setEvents((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                title: draftTitle || item.title,
                startAt: new Date(draftStart).toISOString(),
                endAt: new Date(draftEnd).toISOString(),
                timeZone: draftZone,
                allDay: draftAllDay,
                version: `v${Number(item.version.slice(1) || "1") + 1}`,
              }
            : item,
        ),
      )
    }
    setEditor(null)
  }

  return (
    <>
      <HourCalendarView
        readModel={readModel}
        interaction={interaction}
        capabilities={capabilities}
        actions={actions}
        editDialog={
          editor?.kind === "edit" ? (
            <ScheduleEditorSheet
              open
              onOpenChange={(open) => !open && setEditor(null)}
              title={draftTitle}
              allDay={draftAllDay}
              start={draftStart}
              end={draftEnd}
              zone={draftZone}
              onTitle={setDraftTitle}
              onAllDay={setDraftAllDay}
              onStart={setDraftStart}
              onEnd={setDraftEnd}
              onZone={setDraftZone}
              onSave={saveEditor}
            />
          ) : null
        }
        createDialog={
          editor?.kind === "create" ? (
            <ScheduleEditorSheet
              open
              onOpenChange={(open) => !open && setEditor(null)}
              title={draftTitle}
              allDay={draftAllDay}
              start={draftStart}
              end={draftEnd}
              zone={draftZone}
              onTitle={setDraftTitle}
              onAllDay={setDraftAllDay}
              onStart={setDraftStart}
              onEnd={setDraftEnd}
              onZone={setDraftZone}
              onSave={saveEditor}
            />
          ) : null
        }
      />
    </>
  )
}

function toLocalInput(iso: string) {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function ScheduleEditorSheet({
  open,
  onOpenChange,
  title,
  allDay,
  start,
  end,
  zone,
  onTitle,
  onAllDay,
  onStart,
  onEnd,
  onZone,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  allDay: boolean
  start: string
  end: string
  zone: string
  onTitle: (value: string) => void
  onAllDay: (value: boolean) => void
  onStart: (value: string) => void
  onEnd: (value: string) => void
  onZone: (value: string) => void
  onSave: () => void
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const invalid = Date.parse(start) >= Date.parse(end)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size={576} className="pm-hour-editor">
        <SheetHeader data-pm-hour-editor-header>
          <SheetTitle className="text-lg font-semibold">
            {en ? "Schedule event" : "排期事件"}
          </SheetTitle>
          <SheetDescription>
            {en
              ? "UTC instants; the display zone only changes rendering."
              : "UTC 瞬时时间；显示时区只影响展示。"}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div className="grid gap-4">
            <Field label={en ? "Title" : "标题"}>
              {(control) => (
                <Input
                  {...control}
                  value={title}
                  onChange={(event) => onTitle(event.target.value)}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={allDay}
                onCheckedChange={(checked) => onAllDay(checked === true)}
              />
              {en ? "All day" : "全天"}
            </label>
            <div data-pm-time-fields className="grid gap-4">
              <Field label={en ? "Start (UTC)" : "开始（UTC）"}>
                {(control) => (
                  <Input
                    {...control}
                    type="datetime-local"
                    value={start}
                    onChange={(event) => onStart(event.target.value)}
                  />
                )}
              </Field>
              <Field label={en ? "End (UTC)" : "结束（UTC）"}>
                {(control) => (
                  <Input
                    {...control}
                    type="datetime-local"
                    value={end}
                    onChange={(event) => onEnd(event.target.value)}
                  />
                )}
              </Field>
              <Field label={en ? "Time zone" : "时区"}>
                {(control) => (
                  <RadixSelect
                    {...control}
                    value={zone}
                    onChange={(event) => onZone(event.target.value)}
                  >
                    {["UTC", "Asia/Shanghai", "America/Los_Angeles"].map(
                      (value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ),
                    )}
                  </RadixSelect>
                )}
              </Field>
            </div>
            {invalid && (
              <Alert tone="error">
                {en ? "End must be after start." : "结束必须晚于开始。"}
              </Alert>
            )}
          </div>
        </SheetBody>
        <div className="flex shrink-0 justify-end gap-2 border-t p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {en ? "Cancel" : "取消"}
          </Button>
          <Button disabled={invalid} onClick={onSave}>
            {en ? "Save" : "保存"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
