"use client"
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react"
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Share2,
  Wrench,
} from "lucide-react"
import { Alert } from "@easyuse-ui/ui/components/ui/alert"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@easyuse-ui/ui/components/ui/sheet"
import { StatisticalChart } from "@easyuse-ui/ui/components/blocks/charts/statistical-chart"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import type { ChartSelection } from "@easyuse-ui/ui/lib/chart-model"
import { useApCache, useApState } from "../state"
import { useApAccountState } from "../account-state"
import {
  apAsOf,
  apScope,
  apScenarioIds,
  apScenarios,
  type ApScenario,
} from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  createProfileEvents,
  profileDayIds,
  profileTools,
  profileUnknownDayIds,
  profileYear,
} from "./fixtures"
import {
  clampMonth,
  completeLoad,
  closeSheet,
  createProfileState,
  dayCellLabel,
  draftFromProfile,
  formatCompact,
  formatInt,
  formatPercentDelta,
  intervalLevel,
  intervalValue,
  monthFullLabel,
  monthLabel,
  openSheet,
  profileAgentMonth,
  profileAgentMonths,
  profileAgentsChart,
  profileDays,
  profileInsights,
  profileTokenWindow,
  profileToolStats,
  profileTokensChart,
  profileYearStats,
  resolveSave,
  resolveCheck,
  retryRefresh,
  selectDay,
  selectInterval,
  selectMonth,
  setNotice,
  settleRefresh,
  submitCheck,
  submitSave,
  updateDraft,
  validateDraft,
  type ProfileDraft,
  type ProfileInterval,
} from "./controller"
import styles from "./profile.module.css"

const saveDelayMs = 900
const checkDelayMs = 600
const refreshDelayMs = 900

const intervals: readonly {
  id: ProfileInterval
  label: Record<"zh-CN" | "en", string>
}[] = [
  { id: "daily", label: { "zh-CN": "日", en: "Daily" } },
  { id: "weekly", label: { "zh-CN": "周", en: "Weekly" } },
  { id: "cumulative", label: { "zh-CN": "累计", en: "Cumulative" } },
]

const draftFields: readonly {
  key: keyof ProfileDraft
  label: Record<"zh-CN" | "en", string>
  kind: "input" | "textarea"
  description?: Record<"zh-CN" | "en", string>
}[] = [
  {
    key: "name",
    label: { "zh-CN": "显示名称", en: "Display name" },
    kind: "input",
  },
  { key: "handle", label: { "zh-CN": "用户名", en: "Handle" }, kind: "input" },
  { key: "title", label: { "zh-CN": "职业", en: "Role" }, kind: "input" },
  {
    key: "bio",
    label: { "zh-CN": "个人简介", en: "Bio" },
    kind: "textarea",
    // Maximum length is validated on save.
  },
  // Role is a display title, not an authorization grant.
]

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  const profileScenario =
    apScenarioIds.find((id) => id === scenario) ?? "default"
  return <ProfileView scenario={profileScenario} active={active} />
}

export function ProfileView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [account, setAccount] = useApAccountState()
  const [state, setState] = useApState("profile", () =>
    createProfileState(scenario),
  )
  const [focusDayId, setFocusDayId] = useApState<string | null>(
    "profile-focus-day",
    () => null,
  )
  const calendarRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLElement>(null)
  useEffect(() => {
    pageRef.current?.setAttribute("data-ap-profile-ready", "true")
  }, [])
  const [appliedOperationId, setAppliedOperationId] = useApState<string | null>(
    "profile-applied-operation",
    () => null,
  )
  const focusInvalidApplied = useRef(false)
  const [agentSelection, setAgentSelection] = useApState<ChartSelection>(
    "profile-agent-selection",
    () => null,
  )
  const [tokenSelection, setTokenSelection] = useApState<ChartSelection>(
    "profile-token-selection",
    () => null,
  )

  const profile = account.profile
  const member =
    account.members.find((entry) => entry.memberId === profile.memberId) ?? null
  const cache = useApCache()
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = Number(cache?.get("reading-position") ?? 0)
  }, [cache])
  const project =
    account.projects.find((entry) => entry.projectId === apScope.projectId) ??
    null

  const unknownDayIds = useMemo(
    () => profileUnknownDayIds(scenario),
    [scenario],
  )
  const events = useMemo(
    () => createProfileEvents(scenario, profile.memberId),
    [scenario, profile.memberId],
  )
  const days = useMemo(
    () => profileDays(events, unknownDayIds),
    [events, unknownDayIds],
  )
  const dayIndex = new Map(days.map((day, index) => [day.dayId, index]))
  const stats = profileYearStats(days)
  const insights = profileInsights(days)
  const toolStats = profileToolStats(events, unknownDayIds)
  const agentMonths = profileAgentMonths(events)
  const activeMonth = clampMonth(agentMonths, state.selectedMonth)
  const navIndex = activeMonth ? agentMonths.indexOf(activeMonth) : -1
  const agentMonth = activeMonth ? profileAgentMonth(events, activeMonth) : null
  const tokenWindow = profileTokenWindow(days)
  const loading = scenario === "loading" && !state.loaded
  const readonly = scenario === "readonly"
  const pending = state.save.status === "pending"
  const unknownText = en ? "Unknown" : "未知"
  const coverageNote = en
    ? `${insights.knownDays} / ${insights.totalDays} days covered; missing days are never counted as zero.`
    : `已覆盖 ${insights.knownDays} / ${insights.totalDays} 天；缺失日期不按 0 计。`
  const draft = state.draft ?? draftFromProfile(profile)
  const errors = validateDraft(draft, en)
  const showErrors = state.saveAttempted
  const calendarOffset = new Date(profileDayIds[0] + "T00:00:00Z").getUTCDay()
  const columns = Math.ceil((profileDayIds.length + calendarOffset) / 7)
  const [toolsOpen, setToolsOpen] = useApState(
    "profile-tools-open",
    () => false,
  )
  const monthAnchors: { monthId: string; column: number }[] = []
  profileDayIds.forEach((dayId, index) => {
    const monthId = dayId.slice(0, 7)
    if (monthAnchors[monthAnchors.length - 1]?.monthId !== monthId)
      monthAnchors.push({
        monthId,
        column: Math.floor((index + calendarOffset) / 7),
      })
  })
  const rows = Array.from({ length: 7 }, (_, row) =>
    Array.from(
      { length: columns },
      (_, column) => profileDayIds[column * 7 + row - calendarOffset] ?? null,
    ),
  )
  const rovingDayId = focusDayId ?? state.selectedDayId ?? profileDayIds[0]
  const selected = state.selectedDayId
    ? (days[dayIndex.get(state.selectedDayId) ?? 0] ?? null)
    : null
  const selectedValue =
    selected === null
      ? null
      : intervalValue(days, selected.index, state.interval)

  /* A confirmed save updates the shared profile and the matching member record
     in one functional patch; rejected and unknown results never reach here. */
  useEffect(() => {
    const save = state.save
    if (save.status !== "confirmed" || !save.request || !save.operationId)
      return
    if (appliedOperationId === save.operationId) return
    setAppliedOperationId(save.operationId)
    const request = save.request
    setAccount((previous) => {
      const memberId = previous.profile.memberId
      const name = request.name.trim()
      // Email and permission role are not editable presentation fields.
      return {
        ...previous,
        profile: {
          ...previous.profile,
          name,
          handle: request.handle.trim(),
          jobTitle: request.title.trim(),
          bio: request.bio,
        },
        members: previous.members.map((entry) =>
          entry.memberId === memberId ? { ...entry, name } : entry,
        ),
      }
    })
  }, [state.save, setAccount, appliedOperationId, setAppliedOperationId])

  useEffect(() => {
    if (state.save.status !== "pending") return
    const isCheck = state.save.intent === "check"
    const timer = setTimeout(
      () => {
        setState((current) => {
          const next = isCheck
            ? resolveCheck(current)
            : resolveSave(current, scenario)
          return next.save.status === "confirmed" ? closeSheet(next) : next
        })
      },
      isCheck ? checkDelayMs : saveDelayMs,
    )
    return () => clearTimeout(timer)
  }, [
    state.save.status,
    state.save.intent,
    state.save.operationId,
    scenario,
    setState,
  ])

  useEffect(() => {
    if (state.refresh !== "pending") return
    const timer = setTimeout(() => setState(settleRefresh), refreshDelayMs)
    return () => clearTimeout(timer)
  }, [state.refresh, setState])

  useEffect(() => {
    if (!active) return
    if (!state.saveAttempted) {
      focusInvalidApplied.current = false
      return
    }
    if (focusInvalidApplied.current) return
    focusInvalidApplied.current = true
    document
      .querySelector<HTMLElement>(
        '[data-ap-profile-sheet] [aria-invalid="true"]',
      )
      ?.focus()
  }, [state.saveAttempted, active])

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setState((current) => setNotice(current, "copied"))
    } catch {
      setState((current) => setNotice(current, "copy-error"))
    }
  }

  function focusCalendarDay(dayId: string) {
    setFocusDayId(dayId)
    requestAnimationFrame(() =>
      calendarRef.current
        ?.querySelector<HTMLButtonElement>(`[data-ap-day="${dayId}"]`)
        ?.focus(),
    )
  }

  function onDayKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    dayId: string,
  ) {
    const index = profileDayIds.indexOf(dayId)
    let target = -1
    if (event.key === "ArrowRight") target = index + 7
    else if (event.key === "ArrowDown") target = index + 1
    else if (event.key === "ArrowLeft") target = index - 7
    else if (event.key === "ArrowUp") target = index - 1
    else if (event.key === "Home")
      target = Math.max(0, index - ((index + calendarOffset) % 7))
    else if (event.key === "End")
      target = Math.min(
        index - ((index + calendarOffset) % 7) + 6,
        profileDayIds.length - 1,
      )
    else return
    event.preventDefault()
    if (target < 0 || target >= profileDayIds.length) return
    focusCalendarDay(profileDayIds[target])
  }

  function backToActivity() {
    const dayId = state.selectedDayId ?? profileDayIds[0]
    calendarRef.current?.scrollIntoView({ block: "start" })
    calendarRef.current
      ?.querySelector<HTMLButtonElement>(`[data-ap-day="${dayId}"]`)
      ?.focus()
    setFocusDayId(dayId)
  }

  function stepMonth(offset: number) {
    if (!activeMonth) return
    const index = agentMonths.indexOf(activeMonth) + offset
    if (index < 0 || index >= agentMonths.length) return
    setState((current) => selectMonth(current, agentMonths[index]))
  }

  const agentsChart = agentMonth ? profileAgentsChart(agentMonth, locale) : null
  const tokensChart = profileTokensChart(tokenWindow, locale)
  const statCells = [
    {
      id: "lifetime-tokens",
      label: en ? "Lifetime tokens" : "生命周期 Token",
      value:
        stats.lifetimeTokens === null
          ? unknownText
          : formatCompact(stats.lifetimeTokens, locale),
    },
    {
      id: "peak-day-tokens",
      label: en ? "Peak tokens" : "峰值 Token",
      value:
        stats.peakDayTokens === null
          ? unknownText
          : formatCompact(stats.peakDayTokens, locale),
    },
    {
      id: "longest-session",
      label: en ? "Longest session" : "最长会话",
      value:
        stats.longestSessionMinutes === null
          ? unknownText
          : en
            ? `${Math.floor(stats.longestSessionMinutes / 60)}h ${stats.longestSessionMinutes % 60}m`
            : `${Math.floor(stats.longestSessionMinutes / 60)}小时 ${stats.longestSessionMinutes % 60}分`,
    },
    {
      id: "current-streak",
      label: en ? "Current streak" : "当前连续",
      value:
        stats.currentStreak === null
          ? unknownText
          : en
            ? `${stats.currentStreak} days`
            : `${stats.currentStreak} 天`,
    },
    {
      id: "longest-streak",
      label: en ? "Longest streak" : "最长连续",
      value:
        stats.longestStreak === null
          ? unknownText
          : en
            ? `${stats.longestStreak} days`
            : `${stats.longestStreak} 天`,
    },
  ]
  const insightRows = [
    {
      id: "fast-mode",
      label: en ? "Fast mode" : "快速模式",
      value:
        insights.fastPercent === null
          ? unknownText
          : `${insights.fastPercent}%`,
    },
    {
      id: "reasoning",
      label: en ? "Most used reasoning" : "最常用推理级别",
      value:
        insights.highReasoningPercent === null
          ? unknownText
          : `${en ? "High" : "高"} · ${insights.highReasoningPercent}%`,
    },
    {
      id: "skills-explored",
      label: en ? "Skills explored" : "已探索技能",
      value:
        insights.skillsExplored === null
          ? unknownText
          : formatInt(insights.skillsExplored, locale),
    },
    {
      id: "tool-runs",
      label: en ? "Total skills used" : "技能使用总数",
      value:
        insights.toolRuns === null
          ? unknownText
          : formatInt(insights.toolRuns, locale),
    },
    {
      id: "chats",
      label: en ? "Total chats" : "总对话",
      value:
        insights.chats === null
          ? unknownText
          : formatInt(insights.chats, locale),
    },
  ]
  const toolName = (toolId: string) => {
    const tool = profileTools.find((entry) => entry.toolId === toolId)
    return tool ? tool.label[locale] : toolId
  }

  return (
    <main
      className={styles.page}
      data-ap-page="profile"
      data-ap-profile-ready="false"
      ref={pageRef}
      aria-label={en ? "Profile" : "个人资料"}
    >
      <div
        className={styles.scroll}
        data-ap-scroll
        ref={scrollRef}
        onScroll={(event) =>
          cache?.set("reading-position", event.currentTarget.scrollTop)
        }
      >
        <div className={styles.container}>
          <section
            className={styles.identity}
            data-ap-profile-identity
            aria-label={en ? "Profile identity" : "个人身份"}
          >
            <div className={styles.identityActions}>
              {readonly && (
                <span
                  className="flex items-center gap-2"
                  role="status"
                  data-ap-profile-readonly
                >
                  <Badge tone="warning">{en ? "Read only" : "只读"}</Badge>
                  <span className={styles.readonlyNote}>
                    {en
                      ? "Profile editing and saving are disabled."
                      : "资料编辑与保存已停用。"}
                  </span>
                </span>
              )}
              <Button
                variant="ghost"
                data-ap-profile-share
                onClick={() => void share()}
              >
                <Share2 aria-hidden="true" />
                {en ? "Share" : "分享"}
              </Button>
              <Button
                variant="outline"
                data-ap-profile-edit
                onClick={() =>
                  setState((current) => openSheet(current, profile))
                }
              >
                <Pencil aria-hidden="true" />
                {en ? "Edit profile" : "编辑资料"}
              </Button>
            </div>
            {state.notice !== "idle" && (
              <p
                role="status"
                className="mt-2 text-right text-xs text-muted-foreground"
                data-ap-share-notice={state.notice}
              >
                {state.notice === "copied"
                  ? en
                    ? "Profile link copied"
                    : "已复制个人资料链接"
                  : en
                    ? "Clipboard unavailable; copy the address bar instead."
                    : "剪贴板不可用，请手动复制地址栏链接。"}
              </p>
            )}
            <div className={styles.identityCenter}>
              <span
                className={styles.avatar}
                role="img"
                aria-label={profile.name}
              >
                {profile.name
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0] ?? "")
                  .join("")
                  .toUpperCase() || "?"}
              </span>
              <h1
                className={styles.name}
                data-ap-profile-name
                data-ap-page-title
              >
                {profile.name}
              </h1>
              <div className={styles.handleRow}>
                <span className={styles.handle} data-ap-profile-handle>
                  @{profile.handle ?? profile.email.split("@")[0]}
                </span>
                <span aria-hidden="true">·</span>
                <Badge
                  tone="neutral"
                  className={styles.profilePlan}
                  data-ap-profile-plan
                >
                  PRO
                </Badge>
              </div>
              <p
                className={`${styles.bio} ${profile.bio ? "" : styles.bioEmpty}`}
                data-ap-profile-bio
              >
                {profile.bio || (en ? "No bio provided." : "尚未填写简介。")}
              </p>
              <p className={styles.meta} data-ap-profile-meta>
                {profile.jobTitle ?? (en ? "Product engineer" : "产品工程师")}
              </p>
            </div>
            {!state.sheetOpen && state.save.status !== "idle" && (
              <Alert
                tone={
                  state.save.status === "confirmed"
                    ? "success"
                    : state.save.status === "rejected"
                      ? "error"
                      : state.save.status === "unknown"
                        ? "warning"
                        : "info"
                }
                className={styles.saveStatus}
                data-ap-save-status={state.save.status}
              >
                {state.save.status === "pending" &&
                  (en ? "Saving profile…" : "正在保存资料…")}
                {state.save.status === "confirmed" && (
                  <span data-ap-save-receipt={state.save.receiptId ?? ""}>
                    {en
                      ? `Profile updated · receipt ${state.save.receiptId}`
                      : `资料已更新 · 回执 ${state.save.receiptId}`}
                  </span>
                )}
                {state.save.status === "rejected" && (
                  <span data-ap-save-operation={state.save.operationId ?? ""}>
                    {en
                      ? `Save rejected · operation ${state.save.operationId}; no profile data was changed.`
                      : `保存被拒绝 · 操作 ${state.save.operationId}；资料数据未改动。`}
                  </span>
                )}
                {state.save.status === "unknown" && (
                  <span className="flex flex-wrap items-center gap-2">
                    <span data-ap-save-operation={state.save.operationId ?? ""}>
                      {en
                        ? `Result unknown · operation ${state.save.operationId}; check the recorded result.`
                        : `结果未知 · 操作 ${state.save.operationId}；请检查已记录的结果。`}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      data-ap-check-result
                      onClick={() =>
                        setState((current) => submitCheck(current))
                      }
                    >
                      {en ? "Check result" : "检查结果"}
                    </Button>
                  </span>
                )}
              </Alert>
            )}
          </section>

          {loading ? (
            <div className="py-6">
              <Button
                variant="secondary"
                data-ap-profile-load
                onClick={() => setState((current) => completeLoad(current))}
              >
                {en ? "Load activity data" : "加载活动数据"}
              </Button>
              <DataRegion
                state="loading"
                loadingLabel={en ? "Loading activity data" : "正在加载活动数据"}
              />
            </div>
          ) : (
            <>
              <dl className={styles.stats} data-ap-profile-stats>
                {statCells.map((cell) => (
                  <div key={cell.id} className={styles.statCell}>
                    <dt className={styles.statLabel}>{cell.label}</dt>
                    <dd
                      className={styles.statValue}
                      data-ap-stat={cell.id}
                      data-value={cell.value}
                    >
                      {cell.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {stats.lifetimeTokens === null && (
                <p className={styles.coverageNote} data-ap-stats-coverage>
                  {coverageNote}
                </p>
              )}

              <DataRegion
                state={state.refresh === "error" ? "error" : "success"}
                hasContent
                refreshing={state.refresh === "pending"}
                updatedAt={apAsOf}
                error={{
                  category: "network",
                  message: en
                    ? "Activity refresh failed; the content below shows the last successful result."
                    : "活动数据刷新失败，以下为上次成功结果。",
                  reason: en
                    ? "This scene enters with a failed refresh; existing content is preserved."
                    : "该场景以刷新失败进入；已保留现有内容。",
                }}
                onRetry={
                  state.refresh === "error"
                    ? () => setState((current) => retryRefresh(current))
                    : undefined
                }
              >
                <section
                  className={styles.section}
                  data-ap-profile-activity
                  aria-labelledby="ap-profile-activity-heading"
                >
                  <div className={styles.sectionHeader}>
                    <div>
                      <h2
                        id="ap-profile-activity-heading"
                        className={styles.sectionTitle}
                      >
                        {en ? "Token activity" : "Token 活动"}
                      </h2>
                      <p className={styles.sectionSubtitle}>
                        {en
                          ? "A year of conversations, tools, and agent runs."
                          : "一年的对话、工具与智能体运行。"}
                      </p>
                      <p className="sr-only" data-ap-profile-scope>
                        {en
                          ? `Personal scope · ${project?.name ?? apScope.projectId} · UTC · ${profileYear.startDayId} → ${profileYear.endDayId}`
                          : `个人范围 · ${project?.name ?? apScope.projectId} · UTC · ${profileYear.startDayId} → ${profileYear.endDayId}`}
                      </p>
                    </div>
                    <div
                      role="group"
                      aria-label={en ? "Activity interval" : "活动间隔"}
                      className={styles.segmented}
                      data-ap-interval-group
                    >
                      {intervals.map((interval) => (
                        <Button
                          key={interval.id}
                          size="sm"
                          variant="ghost"
                          className={styles.segmentButton}
                          aria-pressed={state.interval === interval.id}
                          data-ap-interval={interval.id}
                          onClick={() =>
                            setState((current) =>
                              selectInterval(current, interval.id),
                            )
                          }
                        >
                          {interval.label[locale]}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div
                    className={styles.calendarScroll}
                    data-ap-profile-calendar
                    ref={calendarRef}
                  >
                    <div
                      className={styles.monthLabels}
                      style={{
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      }}
                    >
                      {monthAnchors.map((anchor) => (
                        <span
                          key={anchor.monthId}
                          className={styles.monthLabel}
                          style={{ gridColumn: anchor.column + 1 }}
                        >
                          {en
                            ? monthLabel(anchor.monthId, true).slice(0, 3)
                            : monthLabel(anchor.monthId, false)}
                        </span>
                      ))}
                    </div>
                    <table className={styles.calendar}>
                      <caption className="sr-only">
                        {en
                          ? `Profile-year activity calendar, ${profileYear.startDayId} to ${profileYear.endDayId}, personal scope. Select a day to inspect it; arrow keys move between days.`
                          : `资料年度活动日历（${profileYear.startDayId} 至 ${profileYear.endDayId}，个人范围）。选择日期可查看详情；方向键在日期间移动。`}
                      </caption>
                      <tbody>
                        {rows.map((rowDays, row) => (
                          <tr key={row}>
                            {rowDays.map((dayId, column) => {
                              if (!dayId) return <td key={`blank-${column}`} />
                              const index = dayIndex.get(dayId) ?? 0
                              const summary = days[index]
                              const value = intervalValue(
                                days,
                                index,
                                state.interval,
                              )
                              const level = intervalLevel(value, state.interval)
                              return (
                                <td key={dayId}>
                                  <button
                                    type="button"
                                    className={styles.dayCell}
                                    data-ap-day={dayId}
                                    data-level={
                                      level === null ? "unknown" : String(level)
                                    }
                                    aria-pressed={state.selectedDayId === dayId}
                                    aria-label={dayCellLabel(
                                      summary,
                                      value,
                                      en,
                                    )}
                                    tabIndex={rovingDayId === dayId ? 0 : -1}
                                    onFocus={() => setFocusDayId(dayId)}
                                    onKeyDown={(event) =>
                                      onDayKeyDown(event, dayId)
                                    }
                                    onClick={() =>
                                      setState((current) =>
                                        selectDay(current, dayId),
                                      )
                                    }
                                  />
                                </td>
                              )
                            })}
                            {/* Blank cells retain the Sunday-aligned year boundary. */}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className={styles.calendarFooter}>
                    <span data-ap-activity-total>
                      {stats.activities === null
                        ? en
                          ? "Activity total unknown for this profile year"
                          : "本资料年度活动总数未知"
                        : en
                          ? `${formatInt(stats.activities, locale)} activities in this profile year`
                          : `本资料年度共 ${formatInt(stats.activities, locale)} 次活动`}
                    </span>
                    <span
                      className={styles.legend}
                      role="img"
                      aria-label={
                        en
                          ? "Activity level, less to more"
                          : "活动强度，从少到多"
                      }
                    >
                      <span aria-hidden="true">{en ? "Less" : "少"}</span>
                      {[0, 1, 2, 3, 4, 5].map((level) => (
                        <span
                          key={level}
                          aria-hidden="true"
                          className={styles.legendSwatch}
                          data-level={String(level)}
                        />
                      ))}
                      <span aria-hidden="true">{en ? "More" : "多"}</span>
                    </span>
                  </div>
                  {unknownDayIds.length > 0 && (
                    <p
                      className={styles.coverageNote}
                      data-ap-calendar-coverage
                    >
                      {coverageNote}
                    </p>
                  )}

                  <div
                    className={selected ? styles.dayReadout : "sr-only"}
                    data-ap-selected-day={selected?.dayId ?? "none"}
                    aria-live="polite"
                  >
                    {!selected ? (
                      en ? (
                        "Select a day in the calendar to inspect its activity."
                      ) : (
                        "选择日历中的日期以查看当天活动。"
                      )
                    ) : (
                      <>
                        <p className={styles.readoutTitle}>
                          <span>{selected.dayId}</span>
                          <span className={styles.readoutTerm}>
                            {en ? "Personal scope" : "个人范围"}
                          </span>
                        </p>
                        {selected.unknown ? (
                          <p data-ap-selected-day-state="unknown">
                            {en
                              ? "Missing data: this day is unknown, not zero."
                              : "数据缺失：该日期为未知，不是 0。"}
                          </p>
                        ) : (
                          <div className={styles.readoutList}>
                            <p className={styles.readoutRow}>
                              <span className={styles.readoutTerm}>
                                {en ? "Activities" : "活动"}
                              </span>
                              <span className={styles.readoutValue}>
                                {formatInt(selected.count, locale)}
                                {state.interval !== "daily" &&
                                selectedValue !== null
                                  ? en
                                    ? ` (current interval: ${formatInt(selectedValue, locale)})`
                                    : `（当前口径：${formatInt(selectedValue, locale)}）`
                                  : ""}
                              </span>
                            </p>
                            <p className={styles.readoutRow}>
                              <span className={styles.readoutTerm}>Token</span>
                              <span className={styles.readoutValue}>
                                {formatCompact(selected.tokens, locale)}
                              </span>
                            </p>
                            <p className={styles.readoutRow}>
                              <span className={styles.readoutTerm}>
                                {en
                                  ? "Chats / tools / agents"
                                  : "对话 / 工具 / 智能体"}
                              </span>
                              <span className={styles.readoutValue}>
                                {selected.chatCount} / {selected.toolCount} /{" "}
                                {selected.agentCount}
                              </span>
                            </p>
                            <p className={styles.readoutRow}>
                              <span className={styles.readoutTerm}>
                                {en ? "Models" : "模型"}
                              </span>
                              <span className={styles.readoutValue}>
                                {selected.modelIds.length === 0
                                  ? en
                                    ? "No model recorded"
                                    : "无模型记录"
                                  : selected.modelIds.map((modelId) => (
                                      <span
                                        key={modelId}
                                        className={styles.readoutModel}
                                      >
                                        {modelId}
                                        {" · "}
                                      </span>
                                    ))}
                              </span>
                            </p>
                            <p className={styles.readoutRow}>
                              <span className={styles.readoutTerm}>
                                {en ? "Scope" : "范围"}
                              </span>
                              <span className={styles.readoutValue}>
                                {member?.name ?? profile.name} ·{" "}
                                {project?.name ?? apScope.projectId} · UTC
                              </span>
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </section>

                <section
                  className={styles.splitSection}
                  aria-labelledby="ap-profile-insights-heading"
                >
                  <div>
                    <h2
                      id="ap-profile-insights-heading"
                      className={styles.sectionTitle}
                    >
                      {en ? "Activity insights" : "活动洞察"}
                    </h2>
                    <p className="sr-only">
                      {en
                        ? "Personal scope across the whole profile year."
                        : "个人范围 · 整个资料年度。"}
                    </p>
                    <dl className={styles.insightList} data-ap-profile-insights>
                      {insightRows.map((row) => (
                        <div key={row.id} className={styles.insightRow}>
                          <dt className={styles.insightTerm}>{row.label}</dt>
                          <dd
                            className={styles.insightValue}
                            data-ap-insight={row.id}
                            data-value={row.value}
                          >
                            {row.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {insights.chats === null && (
                      <p
                        className={styles.coverageNote}
                        data-ap-insights-coverage
                      >
                        {coverageNote}
                      </p>
                    )}
                  </div>
                  <div>
                    <div className={styles.sectionHeader}>
                      <div>
                        <h2
                          id="ap-profile-tools-heading"
                          className={styles.sectionTitle}
                        >
                          {en ? "Most used tools" : "最常用工具"}
                        </h2>
                        <p className="sr-only">
                          {en
                            ? "Personal scope across the whole profile year."
                            : "个人范围 · 整个资料年度。"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className={styles.browseSkills}
                        aria-expanded={toolsOpen}
                        aria-controls="ap-profile-tool-details"
                        onClick={() => setToolsOpen((open) => !open)}
                        data-ap-browse-skills
                      >
                        {en ? "Browse skills" : "浏览技能"}{" "}
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    </div>
                    <DataRegion
                      state={
                        toolStats.tools.length === 0
                          ? "empty"
                          : toolStats.complete
                            ? "success"
                            : "partial"
                      }
                      hasContent={toolStats.tools.length > 0}
                      emptyTitle={en ? "No tool runs" : "暂无工具运行"}
                      emptyDescription={
                        en
                          ? "0 runs in this profile year; every day is covered."
                          : "本资料年度 0 次运行；全部日期均已覆盖。"
                      }
                      partialDescription={coverageNote}
                    >
                      {toolsOpen && (
                        <div
                          id="ap-profile-tool-details"
                          className={styles.toolDetails}
                          data-ap-tools-total
                          role="region"
                          aria-label={en ? "Skill statistics" : "技能统计"}
                        >
                          <p>
                            {en
                              ? "Personal profile year · UTC"
                              : "个人资料年度 · UTC"}
                          </p>
                          <p>
                            {toolStats.totalRuns === null
                              ? unknownText
                              : formatInt(toolStats.totalRuns, locale)}{" "}
                            {en ? "total skill runs" : "次技能运行"}
                          </p>
                          <p>
                            {profileTools
                              .map((tool) => tool.label[locale])
                              .join(" · ")}
                          </p>
                        </div>
                      )}
                      <ul className={styles.toolList} data-ap-profile-tools>
                        {toolStats.tools.map((tool) => (
                          <li key={tool.toolId} className={styles.toolRow}>
                            <span
                              className={styles.toolIcon}
                              aria-hidden="true"
                            >
                              <Wrench size={14} />
                            </span>
                            <span className={styles.toolName}>
                              {toolName(tool.toolId)}
                            </span>
                            <span className={styles.toolRuns}>
                              {tool.runs === null
                                ? unknownText
                                : en
                                  ? `${formatInt(tool.runs, locale)} runs`
                                  : `${formatInt(tool.runs, locale)} 次运行`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </DataRegion>
                  </div>
                </section>

                <div className={styles.chartSection}>
                  <section
                    className={styles.chartCard}
                    aria-label={en ? "Agents" : "智能体活动"}
                    data-ap-profile-agents-card
                  >
                    <div className={styles.chartHeader}>
                      <div>
                        <p className={styles.overline}>
                          {en ? "Agents" : "智能体"}
                        </p>
                        <p className={styles.valueRow}>
                          <span
                            className={styles.chartValue}
                            data-ap-agent-value
                          >
                            {agentMonth
                              ? en
                                ? `${agentMonth.agents} agents`
                                : `${agentMonth.agents} 个智能体`
                              : en
                                ? "0 agents"
                                : "0 个智能体"}
                          </span>
                          {agentMonth && agentMonth.delta !== null ? (
                            <Badge
                              tone={
                                agentMonth.delta >= 0 ? "success" : "warning"
                              }
                              data-ap-agent-delta={formatPercentDelta(
                                agentMonth.delta,
                              )}
                            >
                              {formatPercentDelta(agentMonth.delta)}
                            </Badge>
                          ) : (
                            <span
                              className={styles.deltaNone}
                              data-ap-agent-delta="none"
                            >
                              —
                              <span className="sr-only">
                                {en
                                  ? "No comparable previous period"
                                  : "无对比周期"}
                              </span>
                            </span>
                          )}
                        </p>
                        <p className={styles.chartSub} data-ap-agent-sub>
                          {en
                            ? `${agentMonth ? formatInt(agentMonth.runs, locale) : "0"} runs across active agents`
                            : `${agentMonth ? formatInt(agentMonth.runs, locale) : "0"} 次智能体运行`}
                        </p>
                      </div>
                      {agentMonth && (
                        <div
                          className={styles.monthNav}
                          role="group"
                          aria-label={en ? "Chart month" : "图表月份"}
                        >
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={en ? "Previous month" : "上个月"}
                            disabled={navIndex <= 0}
                            data-ap-month-prev
                            onClick={() => stepMonth(-1)}
                          >
                            <ChevronLeft aria-hidden="true" />
                          </Button>
                          <span
                            className={styles.monthNavLabel}
                            data-month={agentMonth.monthId}
                            data-ap-month-label
                          >
                            {monthLabel(agentMonth.monthId, en)}
                            <span className="sr-only">
                              {" "}
                              {en
                                ? agentMonth.monthId.slice(0, 4)
                                : `${agentMonth.monthId.slice(0, 4)} 年`}
                            </span>
                          </span>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={en ? "Next month" : "下个月"}
                            disabled={navIndex >= agentMonths.length - 1}
                            data-ap-month-next
                            onClick={() => stepMonth(1)}
                          >
                            <ChevronRight aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {agentMonth && agentsChart ? (
                      <div className={styles.chartPlot}>
                        <StatisticalChart
                          widgetId="ap-profile-agents-chart"
                          presentation="embedded"
                          kind="bar"
                          height={210}
                          title={en ? "Daily agent runs" : "每日智能体运行"}
                          description={
                            en
                              ? `Personal scope · ${monthFullLabel(agentMonth.monthId, en)} · UTC`
                              : `个人范围 · ${monthFullLabel(agentMonth.monthId, en)} · UTC`
                          }
                          query={agentsChart.query}
                          result={agentsChart.result}
                          xType="category"
                          selection={agentSelection}
                          onSelectionChange={(selection) => {
                            setAgentSelection(selection)
                            if (selection)
                              setState((current) =>
                                selectDay(current, selection.bucketId),
                              )
                          }}
                          data={{
                            partialDescription: en
                              ? "Some days are unknown; unknown values are never shown as zero."
                              : "部分日期未知；未知值不会显示为 0。",
                            emptyTitle: en ? "No agent runs" : "暂无智能体运行",
                            emptyDescription: en
                              ? "0 runs in this profile year; every day is covered."
                              : "本资料年度 0 次运行；全部日期均已覆盖。",
                          }}
                        />
                        {agentSelection &&
                          agentSelection.bucketId.startsWith(
                            activeMonth ?? "",
                          ) && (
                            <p
                              className={styles.chartSub}
                              role="status"
                              data-ap-chart-selection="agents"
                            >
                              {agentSelection.bucketId} ·{" "}
                              {formatInt(
                                agentMonth.daily[
                                  Number(agentSelection.bucketId.slice(8)) - 1
                                ] ?? 0,
                                locale,
                              )}{" "}
                              {en ? "runs" : "次运行"}
                            </p>
                          )}
                      </div>
                    ) : (
                      <DataRegion
                        state="empty"
                        emptyTitle={en ? "No agent runs" : "暂无智能体运行"}
                        emptyDescription={
                          en
                            ? "0 runs in this profile year; every day is covered."
                            : "本资料年度 0 次运行；全部日期均已覆盖。"
                        }
                      />
                    )}
                  </section>

                  <section
                    className={styles.chartCard}
                    aria-label={en ? "Tokens" : "Token 用量"}
                    data-ap-profile-tokens-card
                  >
                    <div className={styles.chartHeader}>
                      <div>
                        <p className={styles.overline}>
                          {en ? "Tokens" : "Token"}
                        </p>
                        <p className={styles.valueRow}>
                          <span
                            className={styles.chartValue}
                            data-ap-tokens-value
                          >
                            {tokenWindow.total === null
                              ? unknownText
                              : `${formatCompact(tokenWindow.total, locale)}${
                                  en ? " tokens" : " Token"
                                }`}
                          </span>
                          {tokenWindow.delta !== null ? (
                            <Badge
                              tone={
                                tokenWindow.delta >= 0 ? "success" : "warning"
                              }
                              data-ap-tokens-delta={formatPercentDelta(
                                tokenWindow.delta,
                              )}
                            >
                              {formatPercentDelta(tokenWindow.delta)}
                            </Badge>
                          ) : (
                            <span
                              className={styles.deltaNone}
                              data-ap-tokens-delta="none"
                            >
                              —
                              <span className="sr-only">
                                {en
                                  ? "No comparable previous period"
                                  : "无对比周期"}
                              </span>
                            </span>
                          )}
                        </p>
                        <p
                          className={styles.chartSub}
                          data-ap-tokens-sub
                          title={`${tokenWindow.from} → ${tokenWindow.to} · UTC`}
                        >
                          {en
                            ? "Input and output tokens over 31 days"
                            : "最近 31 天输入与输出 Token"}
                        </p>
                      </div>
                    </div>
                    {tokenWindow.total === 0 ? (
                      <DataRegion
                        state="empty"
                        emptyTitle={
                          en ? "No token activity" : "暂无 Token 活动"
                        }
                        emptyDescription={
                          en
                            ? "0 tokens in the last 31 days; all 31 days are covered."
                            : "最近 31 天 0 Token；31 天全部覆盖。"
                        }
                      />
                    ) : (
                      <div className={styles.chartPlot}>
                        <StatisticalChart
                          widgetId="ap-profile-tokens-chart"
                          yTickFormatter={(value) =>
                            en
                              ? Math.round(value / 1_000_000) + "M"
                              : Math.round(value / 1_000_000) + "百万"
                          }
                          presentation="embedded"
                          kind="area"
                          height={210}
                          title={
                            en
                              ? "Tokens over the last 31 days"
                              : "最近 31 天 Token"
                          }
                          description={
                            en
                              ? `Personal scope · ${tokenWindow.from} → ${tokenWindow.to} · UTC`
                              : `个人范围 · ${tokenWindow.from} → ${tokenWindow.to} · UTC`
                          }
                          query={tokensChart.query}
                          result={tokensChart.result}
                          xType="category"
                          selection={tokenSelection}
                          onSelectionChange={(selection) => {
                            setTokenSelection(selection)
                            if (selection)
                              setState((current) =>
                                selectDay(current, selection.bucketId),
                              )
                          }}
                          data={{
                            partialDescription: en
                              ? "Some days are unknown; unknown values are never shown as zero."
                              : "部分日期未知；未知值不会显示为 0。",
                            emptyTitle: en
                              ? "No token activity"
                              : "暂无 Token 活动",
                            emptyDescription: en
                              ? "0 tokens in the last 31 days; all 31 days are covered."
                              : "最近 31 天 0 Token；31 天全部覆盖。",
                          }}
                        />
                        {tokenSelection && (
                          <p
                            className={styles.chartSub}
                            role="status"
                            data-ap-chart-selection="tokens"
                          >
                            {tokenSelection.bucketId} ·{" "}
                            {formatCompact(
                              days[dayIndex.get(tokenSelection.bucketId) ?? 0]
                                ?.tokens ?? 0,
                              locale,
                            )}{" "}
                            Token
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                </div>

                <div className={styles.cta}>
                  <div className={styles.ctaLead}>
                    <span className={styles.ctaIcon} aria-hidden="true">
                      <Bot size={16} />
                    </span>
                    <div>
                      <p className={styles.ctaTitle}>
                        {en ? "Agent activity" : "智能体活动"}
                      </p>
                      <p className={styles.ctaDesc}>
                        {en
                          ? "Review the day-level runs behind these profile totals."
                          : "查看这些资料汇总背后的逐日运行记录。"}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className={styles.backToActivity}
                    data-ap-back-to-activity
                    onClick={backToActivity}
                  >
                    {en ? "View activity" : "查看活动"}
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </DataRegion>
            </>
          )}
        </div>

        <Sheet
          open={state.sheetOpen}
          onOpenChange={(open) => {
            if (open) {
              setState((current) => openSheet(current, profile))
              return
            }
            // Never close while a save is in flight; unknown results are kept outside.
            if (state.save.status === "pending") return
            setState((current) => closeSheet(current))
          }}
        >
          <SheetContent side="right" size={384} data-ap-profile-sheet>
            <SheetHeader className={styles.sheetHeader}>
              <SheetTitle className={styles.sheetTitle}>
                {en ? "Edit profile" : "编辑资料"}
              </SheetTitle>
              <SheetDescription>
                {en
                  ? "Update the identity shown across your AI workspace."
                  : "更新在工作区中展示的身份信息。"}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className={styles.sheetBody}>
              {pending && (
                <p
                  role="status"
                  className={styles.pendingNote}
                  data-ap-save-pending
                >
                  {state.save.intent === "check"
                    ? en
                      ? "Checking the recorded result…"
                      : "正在检查已记录的结果…"
                    : en
                      ? "Saving profile…"
                      : "正在保存资料…"}
                </p>
              )}
              {state.save.status === "rejected" && (
                <Alert tone="error" data-ap-save-rejected>
                  <span data-ap-save-operation={state.save.operationId ?? ""}>
                    {en
                      ? `Save rejected · operation ${state.save.operationId}; no profile data was changed. Your input is kept.`
                      : `保存被拒绝 · 操作 ${state.save.operationId}；资料数据未改动，输入已保留。`}
                  </span>
                </Alert>
              )}
              {state.save.status === "unknown" && (
                <Alert tone="warning" data-ap-save-unknown>
                  <span className="flex flex-wrap items-center gap-2">
                    <span data-ap-save-operation={state.save.operationId ?? ""}>
                      {en
                        ? `Result unknown · operation ${state.save.operationId}; the original request is kept and never replayed.`
                        : `结果未知 · 操作 ${state.save.operationId}；原请求已保留且不会自动重放。`}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      data-ap-check-result
                      onClick={() =>
                        setState((current) => submitCheck(current))
                      }
                    >
                      {en ? "Check result" : "检查结果"}
                    </Button>
                  </span>
                </Alert>
              )}
              <div className={styles.sheetFieldGrid}>
                {draftFields.map((field) => {
                  const error = showErrors ? errors[field.key] : undefined
                  return (
                    <Field
                      key={field.key}
                      label={field.label[locale]}
                      // Native inputs expose required semantics without changing visible labels.
                      description={field.description?.[locale]}
                      error={error}
                    >
                      {(props) =>
                        field.kind === "textarea" ? (
                          <Textarea
                            {...props}
                            rows={5}
                            className={styles.sheetTextarea}
                            data-ap-profile-field={field.key}
                            disabled={
                              readonly ||
                              pending ||
                              state.save.status === "unknown"
                            }
                            value={draft[field.key]}
                            onChange={(event) =>
                              setState((current) =>
                                updateDraft(current, {
                                  [field.key]: event.target.value,
                                }),
                              )
                            }
                          />
                        ) : (
                          <Input
                            {...props}
                            className={styles.sheetInput}
                            required={
                              field.key === "name" || field.key === "handle"
                            }
                            data-ap-profile-field={field.key}
                            disabled={
                              readonly ||
                              pending ||
                              state.save.status === "unknown"
                            }
                            value={draft[field.key]}
                            onChange={(event) =>
                              setState((current) =>
                                updateDraft(current, {
                                  [field.key]: event.target.value,
                                }),
                              )
                            }
                          />
                        )
                      }
                    </Field>
                  )
                })}
              </div>
              {readonly && (
                <p className={styles.readonlyNote} data-ap-readonly-note>
                  {en
                    ? "Read-only scene: profile editing and saving are disabled."
                    : "只读场景：资料编辑与保存已停用。"}
                </p>
              )}
            </SheetBody>
            <SheetFooter className={styles.sheetFooter}>
              <Button
                variant="secondary"
                data-ap-profile-cancel
                disabled={pending}
                onClick={() => setState((current) => closeSheet(current))}
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                data-ap-profile-save
                disabled={
                  pending || readonly || state.save.status === "unknown"
                }
                onClick={() =>
                  setState((current) => submitSave(current, scenario, en))
                }
              >
                {pending
                  ? en
                    ? "Saving…"
                    : "保存中…"
                  : en
                    ? "Save changes"
                    : "保存更改"}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    </main>
  )
}
