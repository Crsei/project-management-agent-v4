import type { Dispatch, ReactNode, SetStateAction } from "react"
import type { PmControlledData, PmControlledSurface, PmReadingState } from "./controlled-contracts"

/** An independent scheduling entity, never Issue.startDate/dueDate interpreted as an instant.
 * Both bounds are UTC ISO instants; end is exclusive. For all-day events the
 * bounds are local date boundaries in timeZone (including 23/25-hour DST days).
 * The opaque service version is passed intact to the host; the View does not CAS.
 */
export type HourCalendarEvent = {
  id: string
  issueId: string | null
  projectId: string
  title: string
  startAt: string
  endAt: string
  timeZone: string
  allDay: boolean
  version: string
}
export type HourCalendarMutation = {
  operationId: string
  status: "pending" | "confirmed" | "rejected" | "unknown"
  error?: string
  fieldErrors?: Readonly<Record<string, string | undefined>>
}
/** A timed/all-day conversion replaces the entire schedule atomically in the
 * host command. It is never a checkbox-only patch or an Issue date mutation. */
export type HourCalendarSchedule =
  | { allDay: false; startAt: string; endAt: string; timeZone: string }
  | { allDay: true; startAt: string; endAt: string; timeZone: string }
export type HourCalendarIssueSource = {
  id: string
  projectId: string
  identifier: string
  title: string
  startDate: string | null
  dueDate: string | null
}
export type HourCalendarInteraction = {
  /** Date-only navigation is retained verbatim when displayZone changes. */
  anchorDate: string
  displayZone: string
  selectedId: string | null
  reading: PmReadingState
  mode: "week" | "agenda"
  filters: { query: string; projectIds: readonly string[] }
  secondaryOpen: boolean
}
export type HourCalendarMove =
  | { kind: "elapsed"; deltaMinutes: number }
  | { kind: "calendar-days"; days: number }
export type HourCalendarResize = { edge: "end"; deltaMinutes: number }
export type HourCalendarCreateDefaults = { date: string; timeZone: string; allDay: boolean; issueId?: string }
export type HourCalendarReadModel = {
  events: readonly HourCalendarEvent[]
  /** Separate date-only sources are read-only and open their Issue, not event fields. */
  issueSources: readonly HourCalendarIssueSource[]
  data: PmControlledData
  today: string
  mutations: Readonly<Record<string, HourCalendarMutation | undefined>>
  projects: readonly { id: string; label: string }[]
  /** Labels/colors are optional presentation metadata, not event identity or CAS. */
  presentation?: Readonly<Record<string, { identifier?: string; color?: string } | undefined>>
  displayZones?: readonly string[]
  sourceDescription: string
  announcement?: string
}
export type HourCalendarCapabilities = {
  create: boolean
  edit: (event: HourCalendarEvent) => boolean
  move: (event: HourCalendarEvent) => boolean
  resize: (event: HourCalendarEvent) => boolean
  delete: (event: HourCalendarEvent) => boolean
  reason?: string
}
export type HourCalendarActions = {
  setInteraction: Dispatch<SetStateAction<HourCalendarInteraction>>
  create: (defaults: HourCalendarCreateDefaults, trigger: HTMLElement | null) => void
  edit: (event: HourCalendarEvent, trigger: HTMLElement | null) => void
  /** The host uses Temporal to apply calendar-day moves or elapsed-instant deltas. */
  move: (event: HourCalendarEvent, intent: HourCalendarMove, trigger: HTMLElement | null) => void
  resize: (event: HourCalendarEvent, intent: HourCalendarResize, trigger: HTMLElement | null) => void
  delete: (event: HourCalendarEvent, trigger: HTMLElement | null) => void
  openIssue: (issueId: string, trigger: HTMLElement | null) => void
  reconcile: (eventId: string, operationId: string) => void
}
export type HourCalendarViewProps = PmControlledSurface & {
  readModel: HourCalendarReadModel
  interaction: HourCalendarInteraction
  capabilities: HourCalendarCapabilities
  actions: HourCalendarActions
  /** Host display preferences; date-only boundaries and event instants stay intact. */
  weekStartsOn?: 0 | 1 | 6
  timeFormat?: "12" | "24"
  formatDate?: (date: string) => string
  /** Complete host-owned editor. Host retains drafts, explicit fold choices,
   * gap errors, UTC conversion, all-day/timed conversion and focus return. */
  editDialog?: ReactNode
  createDialog?: ReactNode
  /** Fixture adapter owns its explicitly labeled outcome controls. */
  settingsSlot?: ReactNode
  /** Only Showcase may offer event scheduling from its unscheduled fixture Issues. */
  onScheduleIssue?: (issue: HourCalendarIssueSource, trigger: HTMLElement) => void
  /** Caller-supplied boundary for Showcase scene recovery; Product uses data. */
  dataBoundary?: (children: ReactNode) => ReactNode
}
