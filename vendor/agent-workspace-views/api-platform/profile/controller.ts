import {
  apAsOf,
  apFixtureRevision,
  apScope,
  type ApLocale,
  type ApScenario,
} from "../model.ts"
import type { ApAccountProfile } from "../fixtures/accounts.ts"
import type {
  AnalyticsQuery,
  AnalyticsResult,
} from "@easyuse-ui/ui/lib/analytics-model"
import { analyticsQueryKey } from "@easyuse-ui/ui/lib/analytics-query"
import {
  profileAgentWindow,
  profileDayIds,
  profileTools,
  type ApProfileEvent,
} from "./fixtures.ts"

export type ProfileInterval = "daily" | "weekly" | "cumulative"
export type ProfileSaveStatus =
  "idle" | "pending" | "confirmed" | "rejected" | "unknown"
export type ProfileSaveIntent = "none" | "save" | "check"
export type ProfileDraft = {
  name: string
  handle: string
  title: string
  bio: string
}
export type ProfileFieldErrors = Partial<Record<keyof ProfileDraft, string>>
export type ProfileSaveBlock = {
  status: ProfileSaveStatus
  intent: ProfileSaveIntent
  /** Stable operation identifier; retained for rejected and unknown results. */
  operationId: string | null
  /** Immutable submitted request; an unknown result never replays it. */
  request: ProfileDraft | null
  receiptId: string | null
}
export type ProfileState = {
  interval: ProfileInterval
  selectedDayId: string | null
  selectedMonth: string
  sheetOpen: boolean
  draft: ProfileDraft | null
  saveAttempted: boolean
  save: ProfileSaveBlock
  saveSeq: number
  loaded: boolean
  refresh: "ok" | "pending" | "error"
  notice: "idle" | "copied" | "copy-error"
}

export function createProfileState(scenario: ApScenario): ProfileState {
  return {
    interval: "daily",
    selectedDayId: null,
    selectedMonth: "2025-12",
    sheetOpen: false,
    draft: null,
    saveAttempted: false,
    save: {
      status: "idle",
      intent: "none",
      operationId: null,
      request: null,
      receiptId: null,
    },
    saveSeq: 0,
    loaded: scenario !== "loading",
    refresh: scenario === "refresh-error" ? "error" : "ok",
    notice: "idle",
  }
}

export function draftFromProfile(profile: ApAccountProfile): ProfileDraft {
  return {
    name: profile.name,
    handle: profile.handle ?? profile.email.split("@")[0],
    title: profile.jobTitle ?? "Product engineer",
    bio: profile.bio,
  }
}

/**
 * Fixture outcome entry conditions: refresh-error rejects every save for the
 * scene, missing-data returns an unknown result that requires an explicit
 * check, every other scene confirms. readonly never reaches save.
 */
export function profileSaveOutcome(
  scenario: ApScenario,
): "confirmed" | "rejected" | "unknown" {
  if (scenario === "refresh-error") return "rejected"
  if (scenario === "missing-data") return "unknown"
  return "confirmed"
}

export function openSheet(
  state: ProfileState,
  profile: ApAccountProfile,
): ProfileState {
  return {
    ...state,
    sheetOpen: true,
    draft:
      state.save.status === "unknown" && state.save.request
        ? { ...state.save.request }
        : draftFromProfile(profile),
    saveAttempted: false,
    notice: "idle",
  }
}

/** Closing (Cancel, Escape, backdrop) discards the input but keeps the operation record. */
export function closeSheet(state: ProfileState): ProfileState {
  return { ...state, sheetOpen: false, saveAttempted: false }
}

export function updateDraft(
  state: ProfileState,
  patch: Partial<ProfileDraft>,
): ProfileState {
  if (
    !state.draft ||
    state.save.status === "pending" ||
    state.save.status === "unknown"
  )
    return state
  return { ...state, draft: { ...state.draft, ...patch } }
}

export function validateDraft(
  draft: ProfileDraft,
  en: boolean,
): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = en ? "Enter a display name." : "请填写显示名称。"
  else if (name.length > 60)
    errors.name = en
      ? "Display name must be 60 characters or fewer."
      : "显示名称不能超过 60 个字符。"
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(draft.handle.trim()))
    errors.handle = en
      ? "Use 1–40 letters, numbers, underscores or hyphens."
      : "使用 1–40 个字母、数字、下划线或连字符。"
  if (draft.title.length > 80)
    errors.title = en
      ? "Role must be 80 characters or fewer."
      : "职业不能超过 80 个字符。"
  if (draft.bio.length > 1000)
    errors.bio = en
      ? "Bio must be 1000 characters or fewer."
      : "简介不能超过 1000 个字符。"
  // Role is a profile presentation field, never an authorization role.
  return errors
}

export function hasErrors(errors: ProfileFieldErrors): boolean {
  return Object.keys(errors).length > 0
}

export function submitSave(
  state: ProfileState,
  scenario: ApScenario,
  en: boolean,
): ProfileState {
  if (
    !state.draft ||
    scenario === "readonly" ||
    state.save.status === "pending" ||
    state.save.status === "unknown"
  )
    return state
  const errors = validateDraft(state.draft, en)
  if (hasErrors(errors)) return { ...state, saveAttempted: true }
  const seq = state.saveSeq + 1
  return {
    ...state,
    saveSeq: seq,
    saveAttempted: false,
    save: {
      status: "pending",
      intent: "save",
      operationId: `profile-${scenario}-save-${seq}`,
      request: { ...state.draft },
      receiptId: null,
    },
  }
}

export function resolveSave(
  state: ProfileState,
  scenario: ApScenario,
): ProfileState {
  if (state.save.status !== "pending" || state.save.intent !== "save")
    return state
  const outcome = profileSaveOutcome(scenario)
  return {
    ...state,
    save: {
      ...state.save,
      status: outcome,
      intent: "none",
      receiptId:
        outcome === "confirmed" && state.save.operationId
          ? `receipt-${state.save.operationId}`
          : null,
    },
  }
}

/** Explicit result check for an unknown save; resolves the recorded operation without replay. */
export function submitCheck(state: ProfileState): ProfileState {
  if (state.save.status !== "unknown" || !state.save.operationId) return state
  return {
    ...state,
    save: { ...state.save, status: "pending", intent: "check" },
  }
}

export function resolveCheck(state: ProfileState): ProfileState {
  if (state.save.status !== "pending" || state.save.intent !== "check")
    return state
  return {
    ...state,
    save: {
      ...state.save,
      status: "confirmed",
      intent: "none",
      receiptId: `receipt-${state.save.operationId}`,
    },
  }
}

export function selectInterval(
  state: ProfileState,
  interval: ProfileInterval,
): ProfileState {
  return { ...state, interval }
}

export function selectDay(state: ProfileState, dayId: string): ProfileState {
  return { ...state, selectedDayId: dayId }
}

export function selectMonth(
  state: ProfileState,
  monthId: string,
): ProfileState {
  return { ...state, selectedMonth: monthId }
}

export function completeLoad(state: ProfileState): ProfileState {
  return { ...state, loaded: true }
}

export function retryRefresh(state: ProfileState): ProfileState {
  if (state.refresh !== "error") return state
  return { ...state, refresh: "pending" }
}

export function settleRefresh(state: ProfileState): ProfileState {
  if (state.refresh !== "pending") return state
  return { ...state, refresh: "ok" }
}

export function setNotice(
  state: ProfileState,
  notice: ProfileState["notice"],
): ProfileState {
  return { ...state, notice }
}

/* ---------------------------------- derived data ---------------------------------- */

export type ProfileDaySummary = {
  dayId: string
  index: number
  unknown: boolean
  count: number
  tokens: number
  chatCount: number
  toolCount: number
  agentCount: number
  sessionMinutes: number
  fastModeChats: number
  highReasoningChats: number
  modelIds: string[]
  toolIds: string[]
  agentIds: string[]
}

/** One summary per profile-year day, in calendar order; unknown days are flagged, never zeroed. */
export function profileDays(
  events: readonly ApProfileEvent[],
  unknownDayIds: readonly string[],
): ProfileDaySummary[] {
  const unknown = new Set(unknownDayIds)
  const byDay = new Map<string, ProfileDaySummary>()
  profileDayIds.forEach((dayId, index) => {
    byDay.set(dayId, {
      dayId,
      index,
      unknown: unknown.has(dayId),
      count: 0,
      tokens: 0,
      chatCount: 0,
      toolCount: 0,
      agentCount: 0,
      sessionMinutes: 0,
      fastModeChats: 0,
      highReasoningChats: 0,
      modelIds: [],
      toolIds: [],
      agentIds: [],
    })
  })
  for (const event of events) {
    const day = byDay.get(event.dayId)
    if (!day || day.unknown) continue
    day.count += event.count
    day.tokens += event.tokens
    day.sessionMinutes = Math.max(day.sessionMinutes, event.sessionMinutes)
    day.fastModeChats += event.fastModeChats
    day.highReasoningChats += event.highReasoningChats
    if (event.kind === "chat") day.chatCount += event.count
    if (event.kind === "tool") day.toolCount += event.count
    if (event.kind === "agent") day.agentCount += event.count
    if (!day.modelIds.includes(event.modelId)) day.modelIds.push(event.modelId)
    if (event.toolId && !day.toolIds.includes(event.toolId))
      day.toolIds.push(event.toolId)
    if (event.agentId && !day.agentIds.includes(event.agentId))
      day.agentIds.push(event.agentId)
  }
  return profileDayIds.map((dayId) => byDay.get(dayId)!)
}

export type ProfileYearStats = {
  knownDays: number
  totalDays: number
  lifetimeTokens: number | null
  peakDayTokens: number | null
  activities: number | null
  activeDays: number | null
  currentStreak: number | null
  longestStreak: number | null
  longestSessionMinutes: number | null
}

/** Year totals are unknown whenever any day is missing: partial data never becomes zero. */
export function profileYearStats(
  days: readonly ProfileDaySummary[],
): ProfileYearStats {
  const unknownDays = days.filter((day) => day.unknown).length
  const knownDays = days.length - unknownDays
  if (unknownDays > 0)
    return {
      knownDays,
      totalDays: days.length,
      lifetimeTokens: null,
      peakDayTokens: null,
      activities: null,
      activeDays: null,
      currentStreak: null,
      longestStreak: null,
      longestSessionMinutes: null,
    }
  let lifetimeTokens = 0,
    peakDayTokens = 0,
    activities = 0,
    activeDays = 0,
    currentStreak = 0,
    longestStreak = 0,
    run = 0
  for (const day of days) {
    lifetimeTokens += day.tokens
    activities += day.count
    peakDayTokens = Math.max(peakDayTokens, day.tokens)
    if (day.count > 0) {
      activeDays += 1
      run += 1
      longestStreak = Math.max(longestStreak, run)
    } else run = 0
  }
  for (let index = days.length - 1; index >= 0; index--) {
    if (days[index].count > 0) currentStreak += 1
    else break
  }
  return {
    knownDays,
    totalDays: days.length,
    lifetimeTokens,
    peakDayTokens,
    activities,
    activeDays,
    currentStreak,
    longestStreak,
    longestSessionMinutes: Math.max(
      0,
      ...days.map((day) => day.sessionMinutes),
    ),
  }
}

export type ProfileInsights = {
  chats: number | null
  toolRuns: number | null
  agentRuns: number | null
  activeDays: number | null
  modelsUsed: number | null
  knownDays: number
  totalDays: number
  fastPercent: number | null
  highReasoningPercent: number | null
  skillsExplored: number | null
}

export function profileInsights(
  days: readonly ProfileDaySummary[],
): ProfileInsights {
  const unknownDays = days.filter((day) => day.unknown).length
  const knownDays = days.length - unknownDays
  if (unknownDays > 0)
    return {
      chats: null,
      toolRuns: null,
      agentRuns: null,
      activeDays: null,
      modelsUsed: null,
      fastPercent: null,
      highReasoningPercent: null,
      skillsExplored: null,
      knownDays,
      totalDays: days.length,
    }
  const modelIds = new Set<string>()
  let chats = 0,
    toolRuns = 0,
    agentRuns = 0,
    activeDays = 0
  for (const day of days) {
    chats += day.chatCount
    toolRuns += day.toolCount
    agentRuns += day.agentCount
    if (day.count > 0) activeDays += 1
    for (const modelId of day.modelIds) modelIds.add(modelId)
  }
  return {
    chats,
    toolRuns,
    agentRuns,
    activeDays,
    modelsUsed: modelIds.size,
    fastPercent:
      chats === 0
        ? 0
        : Math.round(
            (days.reduce((sum, day) => sum + day.fastModeChats, 0) * 100) /
              chats,
          ),
    highReasoningPercent:
      chats === 0
        ? 0
        : Math.round(
            (days.reduce((sum, day) => sum + day.highReasoningChats, 0) * 100) /
              chats,
          ),
    skillsExplored: new Set(days.flatMap((day) => day.toolIds)).size,
    knownDays,
    totalDays: days.length,
  }
}

/** Value shown per calendar cell for the active interval, derived from day summaries. */
export function intervalValue(
  days: readonly ProfileDaySummary[],
  index: number,
  interval: ProfileInterval,
): number | null {
  if (interval === "daily") {
    const day = days[index]
    return day.unknown ? null : day.count
  }
  if (interval === "weekly") {
    // Sunday-aligned calendar week, clamped at the profile-year boundary.
    const startWeekday = new Date(`${profileDayIds[0]}T00:00:00Z`).getUTCDay()
    const from = Math.max(0, index - ((index + startWeekday) % 7))
    const end = index - ((index + startWeekday) % 7) + 7
    let total = 0
    for (let cursor = from; cursor < end && cursor < days.length; cursor++) {
      if (days[cursor].unknown) return null
      total += days[cursor].count
    }
    return total
  }
  let total = 0
  for (let cursor = 0; cursor <= index; cursor++) {
    if (days[cursor].unknown) return null
    total += days[cursor].count
  }
  return total
}

const levelSteps: Record<ProfileInterval, readonly number[]> = {
  daily: [0, 4, 8, 12, 16],
  weekly: [0, 30, 60, 90, 120],
  cumulative: [0, 1000, 2000, 3000, 4000],
}

export function intervalLevel(
  value: number | null,
  interval: ProfileInterval,
): number | null {
  if (value === null) return null
  const steps = levelSteps[interval]
  for (let level = 0; level < steps.length; level++)
    if (value <= steps[level]) return level
  return 5
}

export type ProfileToolStat = { toolId: string; runs: number | null }
export type ProfileToolStats = {
  tools: ProfileToolStat[]
  totalRuns: number | null
  complete: boolean
}

/** Top five tools by runs over covered days; incomplete coverage reports unknown runs. */
export function profileToolStats(
  events: readonly ApProfileEvent[],
  unknownDayIds: readonly string[],
): ProfileToolStats {
  const unknown = new Set(unknownDayIds)
  const complete = unknown.size === 0
  const runsByTool = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== "tool" || !event.toolId || unknown.has(event.dayId))
      continue
    runsByTool.set(
      event.toolId,
      (runsByTool.get(event.toolId) ?? 0) + event.count,
    )
  }
  const tools = profileTools
    .map((tool) => ({
      toolId: tool.toolId,
      observedRuns: runsByTool.get(tool.toolId) ?? 0,
    }))
    .filter((tool) => tool.observedRuns > 0)
    .sort(
      (a, b) =>
        b.observedRuns - a.observedRuns || a.toolId.localeCompare(b.toolId),
    )
    .slice(0, 5)
    .map(({ toolId, observedRuns }) => ({
      toolId,
      runs: complete ? observedRuns : null,
    }))
  const totalRuns = complete
    ? [...runsByTool.values()].reduce((sum, runs) => sum + runs, 0)
    : null
  return { tools, totalRuns, complete }
}

export function profileAgentMonths(
  events: readonly ApProfileEvent[],
): string[] {
  const months = new Set<string>()
  for (const event of events)
    if (event.kind === "agent") months.add(event.dayId.slice(0, 7))
  return [...months].sort()
}

export type ProfileAgentMonth = {
  monthId: string
  days: number
  runs: number
  agents: number
  daily: number[]
  prevRuns: number | null
  delta: number | null
}

function monthDayCount(monthId: string): number {
  const year = Number(monthId.slice(0, 4))
  const month = Number(monthId.slice(5, 7))
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function shiftMonth(monthId: string, offset: number): string {
  const year = Number(monthId.slice(0, 4))
  const month = Number(monthId.slice(5, 7))
  return new Date(Date.UTC(year, month - 1 + offset, 1))
    .toISOString()
    .slice(0, 7)
}

function agentRunsIn(events: readonly ApProfileEvent[], monthId: string) {
  const daily = new Array<number>(monthDayCount(monthId)).fill(0)
  const agents = new Set<string>()
  let runs = 0
  for (const event of events) {
    if (event.kind !== "agent" || !event.dayId.startsWith(monthId)) continue
    const day = Number(event.dayId.slice(8, 10))
    daily[day - 1] += event.count
    runs += event.count
    if (event.agentId) agents.add(event.agentId)
  }
  return { runs, agents, daily }
}

/** Daily runs for one month plus a delta derived from the previous month of the same events. */
export function profileAgentMonth(
  events: readonly ApProfileEvent[],
  monthId: string,
): ProfileAgentMonth {
  const current = agentRunsIn(events, monthId)
  const previousMonth = shiftMonth(monthId, -1)
  const previousMonthInRange =
    previousMonth >= profileAgentWindow.from.slice(0, 7) &&
    previousMonth <= profileAgentWindow.to.slice(0, 7)
  const previous = previousMonthInRange
    ? agentRunsIn(events, previousMonth)
    : null
  const prevRuns = previous && previous.runs > 0 ? previous.runs : null
  return {
    monthId,
    days: monthDayCount(monthId),
    runs: current.runs,
    agents: current.agents.size,
    daily: current.daily,
    prevRuns,
    delta: prevRuns ? (current.runs - prevRuns) / prevRuns : null,
  }
}

export type ProfileTokenWindow = {
  from: string
  to: string
  points: { dayId: string; value: number | null }[]
  total: number | null
  prevTotal: number | null
  delta: number | null
}

/** The profile-year's last 31 days and the 31 days before it, from the same day summaries. */
export function profileTokenWindow(
  days: readonly ProfileDaySummary[],
): ProfileTokenWindow {
  const current = days.slice(days.length - 31)
  const previous = days.slice(days.length - 62, days.length - 31)
  const sum = (slice: readonly ProfileDaySummary[]) =>
    slice.some((day) => day.unknown)
      ? null
      : slice.reduce((total, day) => total + day.tokens, 0)
  const total = sum(current)
  const prevTotal = sum(previous)
  return {
    from: current[0].dayId,
    to: current[current.length - 1].dayId,
    points: current.map((day) => ({
      dayId: day.dayId,
      value: day.unknown ? null : day.tokens,
    })),
    total,
    prevTotal,
    delta: total !== null && prevTotal ? (total - prevTotal) / prevTotal : null,
  }
}

/** Calendar cell label; unknown days say so instead of claiming zero activities. */
export function dayCellLabel(
  day: ProfileDaySummary,
  value: number | null,
  en: boolean,
): string {
  if (day.unknown || value === null)
    return en ? `${day.dayId}: missing data` : `${day.dayId}：数据缺失`
  return en
    ? `${day.dayId}: ${value} activities`
    : `${day.dayId}：${value} 次活动`
}

export function formatCompact(value: number, locale: ApLocale): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatInt(value: number, locale: ApLocale): string {
  return new Intl.NumberFormat(locale).format(value)
}

export function formatPercentDelta(delta: number): string {
  const rounded = Math.round(delta * 100)
  return `${rounded > 0 ? "+" : ""}${rounded}%`
}

const enMonths = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** Visible month name without the year, mirroring the reference pill. */
export function monthLabel(monthId: string, en: boolean): string {
  const month = Number(monthId.slice(5, 7))
  return en ? enMonths[month - 1] : `${month} 月`
}

/** Month and year for assistive technology and data attributes. */
export function monthFullLabel(monthId: string, en: boolean): string {
  const year = monthId.slice(0, 4)
  const month = Number(monthId.slice(5, 7))
  return en ? `${enMonths[month - 1]} ${year}` : `${year} 年 ${month} 月`
}

export function clampMonth(
  months: readonly string[],
  selectedMonth: string,
): string | null {
  if (months.length === 0) return null
  if (months.includes(selectedMonth)) return selectedMonth
  return months[months.length - 1]
}

/* ---------------------------------- charts ---------------------------------- */

function fixtureQuery(
  measureId: string,
  segment: string,
  range: { from: string; to: string },
): AnalyticsQuery {
  return {
    source: "api-platform-profile-fixture",
    scope: {
      id: `${apScope.orgId}:${apScope.projectId}`,
      permissionVersion: apFixtureRevision,
      projectIds: [apScope.projectId],
    },
    measureId,
    measureVersion: 1,
    dimension: "day",
    segment,
    timeField: "asOf",
    range,
    bucket: "day",
    timeZone: apScope.timeZone,
    filters: [],
  }
}

function addDays(dayId: string, offset: number): string {
  return new Date(Date.parse(`${dayId}T00:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

/** Month-start tick reads "1 Dec" like the reference chart; other ticks are day numbers. */
function agentsAxisLabel(
  monthId: string,
  day: number,
  locale: ApLocale,
): string {
  if (day !== 1) return String(day)
  const month = Number(monthId.slice(5, 7))
  return locale === "en"
    ? `1 ${enMonths[month - 1].slice(0, 3)}`
    : `${month} 月 1 日`
}

function shortDateLabel(dayId: string, locale: ApLocale): string {
  const month = Number(dayId.slice(5, 7))
  const day = Number(dayId.slice(8, 10))
  return locale === "en"
    ? `${enMonths[month - 1].slice(0, 3)} ${day}`
    : `${month} 月 ${day} 日`
}

/** One analytics query/result pair for the selected month, derived from the same events. */
export function profileAgentsChart(
  month: ProfileAgentMonth,
  locale: ApLocale,
): { query: AnalyticsQuery; result: AnalyticsResult } {
  const monthNumber = Number(month.monthId.slice(5, 7))
  const rangeEnd = new Date(
    Date.UTC(Number(month.monthId.slice(0, 4)), monthNumber, 1),
  )
    .toISOString()
    .slice(0, 10)
  const query = fixtureQuery("profile-agent-runs", `month:${month.monthId}`, {
    from: `${month.monthId}-01T00:00:00Z`,
    to: `${rangeEnd}T00:00:00Z`,
  })
  return {
    query,
    result: {
      queryKey: analyticsQueryKey(query),
      snapshotId: `profile-agents:${month.monthId}`,
      asOf: apAsOf,
      computedAt: apAsOf,
      unit: "runs",
      series: [
        {
          id: "agent-runs",
          label: locale === "en" ? "Agent runs" : "智能体运行",
          color: "1",
          points: month.daily.map((value, index) => ({
            bucketId: `${month.monthId}-${String(index + 1).padStart(2, "0")}`,
            label: agentsAxisLabel(month.monthId, index + 1, locale),
            value,
          })),
        },
      ],
      coverage: null,
      total: month.runs,
      limitations: [],
      sampleCoverage: { observed: month.days, total: month.days },
      completeness: "complete",
    },
  }
}

/** Tokens over the window's last 31 days; unknown days stay null instead of zero. */
export function profileTokensChart(
  windowRange: ProfileTokenWindow,
  locale: ApLocale,
): { query: AnalyticsQuery; result: AnalyticsResult } {
  const query = fixtureQuery("profile-tokens", `window:${windowRange.from}`, {
    from: `${windowRange.from}T00:00:00Z`,
    to: `${addDays(windowRange.to, 1)}T00:00:00Z`,
  })
  const nullPoints = windowRange.points.filter(
    (point) => point.value === null,
  ).length
  const observed = windowRange.points.length - nullPoints
  return {
    query,
    result: {
      queryKey: analyticsQueryKey(query),
      snapshotId: `profile-tokens:${windowRange.from}`,
      asOf: apAsOf,
      computedAt: apAsOf,
      unit: "tokens",
      series: [
        {
          id: "tokens",
          label: locale === "en" ? "Tokens" : "Token",
          color: "1",
          points: windowRange.points.map((point, index) => {
            const isEdge =
              index === 0 || index === windowRange.points.length - 1
            const relative = index === 7 || index === 14 || index === 21
            return {
              bucketId: point.dayId,
              label: isEdge
                ? shortDateLabel(point.dayId, locale)
                : relative
                  ? `+${index}d`
                  : String(Number(point.dayId.slice(8, 10))),
              value: point.value,
            }
          }),
        },
      ],
      coverage: null,
      total: windowRange.total,
      limitations: [],
      sampleCoverage: { observed, total: windowRange.points.length },
      completeness: nullPoints > 0 ? "partial" : "complete",
    },
  }
}
