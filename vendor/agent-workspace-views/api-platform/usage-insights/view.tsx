"use client"
import { useMemo, useRef, type CSSProperties, type KeyboardEvent } from "react"
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ChevronLeft, ChevronRight, Download } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { ApProviderMark } from "../ap-provider-mark"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@easyuse-ui/ui/components/ui/table"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect } from "../shared"
import { useApCache, useApState } from "../state"
import { apUsagePeriod } from "../fixtures/usage-ledger"
import { apModels } from "../fixtures/models"
import { apScenarios, type ApLocale, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  formatUsageAmount,
  usageProjects,
  type UsageBucket,
  type UsageInsightsState,
  type UsageMetric,
} from "./controller"
import {
  createReferenceUsageState,
  isReferencePeriod,
  referenceUsageExport,
  referenceUsageInsights,
  referenceUsageModels,
  referenceUsagePeriod,
  referenceUsageProjects,
  updateReferenceUsageFilter,
} from "./reference-controller"
import styles from "./usage-insights.module.css"

const usagePeriodChoices = [
  { value: "year", label: { en: "Last 12 months", "zh-CN": "过去 12 个月" } },
  { value: "90-days", label: { en: "Last 90 days", "zh-CN": "过去 90 天" } },
  { value: "fixture", label: { en: "September fixture", "zh-CN": "9 月样例" } },
  { value: "7-days", label: { en: "Last 7 days", "zh-CN": "过去 7 天" } },
] as const

const metricLabels = {
  requests: { en: "Requests", "zh-CN": "请求" },
  tokens: { en: "Tokens", "zh-CN": "Token" },
  spend: { en: "Spend", "zh-CN": "费用" },
}
const metricOrder: UsageMetric[] = ["requests", "tokens", "spend"]
const palette = [
  "var(--usage-green)",
  "var(--usage-green-dark)",
  "var(--usage-green-light)",
  "var(--chart-3)",
]

export function UsageActivity({
  days,
  selectedDay,
  onSelect,
  locale,
}: {
  days: UsageBucket[]
  selectedDay: string
  onSelect: (id: string) => void
  locale: ApLocale
}) {
  const grid = useRef<HTMLDivElement>(null)
  const offset = new Date(days[0].from).getUTCDay()
  const columns = Math.ceil((days.length + offset) / 7)
  const max = Math.max(1, ...days.map((day) => day.requests ?? 0))
  const monthLabels = days.flatMap((day, index) =>
    (index === 0 && Number(day.id.slice(-2)) <= 7) || day.id.endsWith("-01")
      ? [
          {
            id: day.id,
            column: Math.floor((index + offset) / 7),
            label: new Intl.DateTimeFormat(locale, {
              month: "short",
              timeZone: "UTC",
            }).format(new Date(day.from)),
          },
        ]
      : [],
  )
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const current = days.findIndex(
      (day) =>
        day.id === (document.activeElement as HTMLElement)?.dataset.usageDay,
    )
    const delta =
      event.key === "ArrowLeft"
        ? -7
        : event.key === "ArrowRight"
          ? 7
          : event.key === "ArrowUp"
            ? -1
            : event.key === "ArrowDown"
              ? 1
              : 0
    if (!delta && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? days.length - 1
          : Math.max(0, Math.min(days.length - 1, current + delta))
    onSelect(days[next].id)
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-usage-day="${days[next].id}"]`)
      ?.focus()
  }
  return (
    <div className={styles.heatOverflow}>
      <div
        className={styles.calendar}
        data-wide={days.length > 100}
        style={{ "--usage-weeks": columns } as CSSProperties}
      >
        <div className={styles.months}>
          {monthLabels.map((month) => (
            <span key={month.id} style={{ gridColumn: month.column + 1 }}>
              {month.label}
            </span>
          ))}
        </div>
        <div className={styles.heatRow}>
          <div className={styles.weekdays}>
            <span>{locale === "en" ? "Mon" : "一"}</span>
            <span>{locale === "en" ? "Wed" : "三"}</span>
            <span>{locale === "en" ? "Fri" : "五"}</span>
          </div>
          <div
            ref={grid}
            className={styles.heatmap}
            role="group"
            aria-label={
              locale === "en" ? "Daily request activity" : "每日请求活动"
            }
            onKeyDown={navigate}
          >
            {days.map((day, index) => {
              const label = `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(day.from))}: ${day.requests === null ? (locale === "en" ? "Data unavailable" : "数据不可用") : `${new Intl.NumberFormat(locale).format(day.requests)} ${locale === "en" ? "requests" : "次请求"}`}`
              return (
                <button
                  key={day.id}
                  type="button"
                  data-usage-day={day.id}
                  data-level={
                    day.requests === null
                      ? "missing"
                      : day.requests === 0
                        ? "zero"
                        : "known"
                  }
                  tabIndex={selectedDay === day.id ? 0 : -1}
                  aria-pressed={selectedDay === day.id}
                  aria-label={label}
                  title={`${day.id} · ${label}`}
                  onClick={() => onSelect(day.id)}
                  onFocus={() => onSelect(day.id)}
                  style={
                    {
                      gridColumn: Math.floor((index + offset) / 7) + 1,
                      gridRow: ((index + offset) % 7) + 1,
                      "--usage-intensity": `${Math.max(25, (100 * (day.requests ?? 0)) / max)}%`,
                    } as CSSProperties
                  }
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export function UsageInsightsView({ scenario }: { scenario: ApScenario }) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [state, setState] = useApState<UsageInsightsState>(
    "usage-insights",
    createReferenceUsageState,
  )
  const { project, period, metric, coverageDemo } = state
  const result = useMemo(
    () =>
      referenceUsageInsights(
        { project, period, metric, coverageDemo },
        scenario,
      ),
    [project, period, metric, coverageDemo, scenario],
  )
  const cache = useApCache()

  const loading = scenario === "loading" && !state.recovered,
    refreshError = scenario === "refresh-error" && !state.recovered
  const metricLabel = metricLabels[state.metric][locale]
  const periodOptions = useMemo(
    () =>
      usagePeriodChoices.map((choice) => ({
        value: choice.value,
        label: choice.label[locale],
      })),
    [locale],
  )
  const referencePeriodOptions = useMemo(
    () => periodOptions.slice(0, 2),
    [periodOptions],
  )
  const selectedDay =
    result.days.find((day) => day.id === state.selectedDay) ??
    result.days[result.days.length - 1]
  const weekRows = result.weeks.map((week) => ({
    id: week.id,
    ...Object.fromEntries(
      result.models.map((model, index) => [
        `series${index}`,
        week.models[model.id]?.value ?? null,
      ]),
    ),
  }))
  const hourRows = result.hours.map((hour) => ({
    id: hour.id,
    value: hour.amount.value,
  }))
  const peakHour = Number(result.peak.id)
  const dateFormat = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  const fullDate = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  const axisDates = Array.from({ length: 6 }, (_, index) =>
    dateFormat.format(
      new Date(
        Date.parse(result.range.from) +
          Math.round(((result.days.length - 1) * index) / 5) * 86_400_000,
      ),
    ),
  )
  const maxModel = Math.max(
    1,
    ...result.models.map((model) => model.amount.observed),
  )
  const changeMetric = (direction: number) =>
    setState((before) => ({
      ...before,
      metric:
        metricOrder[
          (metricOrder.indexOf(before.metric) +
            direction +
            metricOrder.length) %
            metricOrder.length
        ],
    }))
  const exportData = () => {
    const url = URL.createObjectURL(
      new Blob([referenceUsageExport(state, scenario)], {
        type: "application/json",
      }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "usage-insights-fixture.json"
    link.click()
    URL.revokeObjectURL(url)
    setState((before) => ({
      ...before,
      notice: "export-ready",
    }))
  }
  const tableRows =
    state.table === "daily"
      ? result.days.map((day) => ({
          id: day.id,
          label: day.id,
          amount: day.amount,
          complete: day.complete,
        }))
      : state.table === "weekly"
        ? result.weeks.map((week) => ({
            id: week.id,
            label: `${week.from.slice(0, 10)} → ${week.to.slice(0, 10)}`,
            amount: week.amount,
            complete: week.complete,
          }))
        : state.table === "hourly"
          ? result.hours.map((hour) => ({
              id: hour.id,
              label: `${hour.id}:00 UTC`,
              amount: hour.amount,
              complete: result.complete,
            }))
          : result.models.map((model) => ({
              id: model.id,
              label: model.name,
              amount: model.amount,
              complete: result.complete,
            }))
  return (
    <div className={styles.root}>
      <ApPage
        variant="analytics"
        pageId="usage-insights"
        title={en ? "Usage insights" : "用量洞察"}
        description={
          en
            ? "A closer look at how your workspace uses AI."
            : "深入了解工作区如何使用 AI。"
        }
        actions={
          <div className={styles.filters}>
            <ApSelect
              label={en ? "Project" : "项目"}
              value={state.project}
              onChange={(value) =>
                setState((before) =>
                  updateReferenceUsageFilter(before, "project", value),
                )
              }
              options={[
                { value: "all", label: en ? "All projects" : "所有项目" },
                ...(isReferencePeriod(state.period)
                  ? referenceUsageProjects
                  : usageProjects
                ).map((project) => ({
                  value: project.projectId,
                  label: project.name,
                })),
              ]}
            />
            <ApSelect
              label={en ? "Usage period" : "用量周期"}
              value={state.period}
              onChange={(value) =>
                setState((before) =>
                  updateReferenceUsageFilter(before, "period", value),
                )
              }
              options={
                isReferencePeriod(state.period)
                  ? referencePeriodOptions
                  : periodOptions
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={en ? "Export usage insights" : "导出用量洞察"}
              className={styles.icon}
              disabled={loading}
              onClick={exportData}
            >
              <Download size={14} />
            </Button>
          </div>
        }
      >
        {loading && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setState((before) => ({ ...before, recovered: true }))
            }
          >
            {en ? "Finish fixture loading" : "完成样例加载"}
          </Button>
        )}
        <DataRegion
          state={loading ? "loading" : refreshError ? "error" : "success"}
          hasContent={!loading}
          updatedAt={
            isReferencePeriod(state.period)
              ? referenceUsagePeriod.to
              : apUsagePeriod.to
          }
          error={{
            category: "request",
            message: en ? "Fixture refresh failed" : "样例刷新失败",
            reason: en
              ? "The last fixture snapshot is preserved. Retry only reads local fixtures."
              : "保留最后的样例快照；重试仅读取本地样例。",
          }}
          onRetry={() => setState((before) => ({ ...before, recovered: true }))}
        >
          <div
            className={styles.sections}
            data-usage-query={result.queryKey}
            data-usage-requests={result.requestCount}
          >
            {scenario === "empty" && (
              <p role="status" className={styles.dataExplanation}>
                {en
                  ? "No API activity in this fixture range. Project and period filters remain available."
                  : "此样例范围内暂无 API 活动。仍可调整项目和周期。"}
              </p>
            )}
            <section
              aria-labelledby="usage-activity-title"
              className={styles.activity}
            >
              <div className={styles.sectionHeading}>
                <h2 id="usage-activity-title">{en ? "Activity" : "活动"}</h2>
                <p>
                  {en ? "API requests, day by day" : "每日 API 请求"} ·{" "}
                  <span data-usage-count={result.requestCount}>
                    {new Intl.NumberFormat(locale, {
                      notation: "compact",
                      maximumFractionDigits: 1,
                    }).format(result.requestCount)}
                  </span>{" "}
                  {en ? "in this period" : "次请求（本周期）"}
                </p>
              </div>
              <UsageActivity
                days={result.days}
                selectedDay={selectedDay.id}
                onSelect={(id) =>
                  setState((before) => ({ ...before, selectedDay: id }))
                }
                locale={locale}
              />
              <div className={styles.activityMeta}>
                <p>
                  {result.streak}
                  {en ? "-day streak · Longest " : " 天连续活动 · 最长 "}
                  {result.longest}
                  {en ? " days · Busiest " : " 天 · 最忙 "}
                  {result.busiest
                    ? `${dateFormat.format(new Date(result.busiest.from))} (${new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(result.busiest.requests ?? 0)} ${en ? "requests" : "次请求"})`
                    : "—"}
                </p>
                <div
                  className={styles.intensity}
                  role="img"
                  aria-label={
                    en
                      ? "Color intensity represents request volume; hatching means unavailable"
                      : "颜色深浅表示请求量；斜线表示不可用"
                  }
                >
                  <span>{en ? "Less" : "少"}</span>
                  {[0, 20, 40, 60, 80, 100].map((level) => (
                    <i
                      key={level}
                      style={{
                        background:
                          level === 0
                            ? "var(--muted)"
                            : `color-mix(in oklab,var(--usage-green) ${level}%,var(--muted))`,
                      }}
                    />
                  ))}
                  <span>{en ? "More" : "多"}</span>
                </div>
              </div>
              <p className={styles.selected} aria-live="polite">
                {dateFormat.format(new Date(selectedDay.from))}:{" "}
                {selectedDay.requests === null
                  ? en
                    ? "Data unavailable"
                    : "数据不可用"
                  : `${new Intl.NumberFormat(locale).format(selectedDay.requests)} ${en ? "requests" : "次请求"}`}{" "}
                ·{" "}
                {en
                  ? "Select a day, or use the arrow keys to explore."
                  : "选择日期，或使用方向键浏览。"}
              </p>
            </section>
            <section
              aria-labelledby="usage-trend-title"
              className={styles.trend}
            >
              <div className={styles.sectionHeading}>
                <h2 id="usage-trend-title">{en ? "Over time" : "趋势"}</h2>
                <p>
                  {metricLabel}
                  {en ? " per week, by model" : "：按模型每周统计"}
                </p>
              </div>
              <div
                className={styles.weekPlot}
                role="img"
                aria-label={
                  en
                    ? `Weekly ${metricLabel.toLowerCase()} by model; unavailable weeks are not zero. Read exact values below.`
                    : `按模型的每周${metricLabel}；缺失周不是零。下方可读取准确数值。`
                }
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={weekRows}
                    margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                    barCategoryGap={state.period === "year" ? 1.5 : 3}
                    accessibilityLayer={false}
                  >
                    <XAxis dataKey="id" hide />
                    <YAxis hide domain={[0, "dataMax"]} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        color: "var(--foreground)",
                        borderColor: "var(--border)",
                        borderRadius: "var(--radius)",
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "var(--foreground)" }}
                      labelFormatter={(label) =>
                        `${en ? "Week of " : "周起始 "}${label}`
                      }
                      formatter={(value, name) => [
                        state.metric === "spend"
                          ? `${Number(value)} microUSD`
                          : value,
                        name,
                      ]}
                    />
                    {result.models.map((model, index) => (
                      <Bar
                        key={model.id}
                        name={model.name}
                        dataKey={`series${index}`}
                        stackId="models"
                        fill={palette[index % palette.length]}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className={styles.axis}>
                {axisDates.map((date, index) => (
                  <span key={index}>{date}</span>
                ))}
              </div>
              <div className={styles.legend}>
                {result.models.map(
                  (model, index) =>
                    model.amount.observed > 0 && (
                      <span key={model.id}>
                        <i
                          style={{
                            background: palette[index % palette.length],
                          }}
                        />
                        {model.name}
                      </span>
                    ),
                )}
              </div>
            </section>
            <section aria-labelledby="usage-hour-title" className={styles.hour}>
              <div className={styles.hourHeading}>
                <div className={styles.sectionHeading}>
                  <h2 id="usage-hour-title">{en ? "By hour" : "小时分布"}</h2>
                  <p>
                    {result.requestCount
                      ? `${en ? "Most active around " : "最活跃时段 "}${new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(new Date(`2026-09-01T${String(peakHour).padStart(2, "0")}:00:00Z`))}`
                      : en
                        ? "No observed activity"
                        : "无已观测活动"}{" "}
                    · UTC
                  </p>
                </div>
                <div className={styles.metric}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={styles.icon}
                    aria-label={en ? "Previous usage metric" : "上一个用量指标"}
                    onClick={() => changeMetric(-1)}
                  >
                    <ChevronLeft size={14} />
                  </Button>
                  <span data-usage-metric>{metricLabel}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={styles.icon}
                    aria-label={en ? "Next usage metric" : "下一个用量指标"}
                    onClick={() => changeMetric(1)}
                  >
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
              <div
                className={styles.hourPlot}
                role="img"
                aria-label={
                  en
                    ? `${metricLabel} by hour in UTC, ${isReferencePeriod(state.period) ? "reference demo aggregates" : "observed ledger only"}. Read exact values below.`
                    : `UTC 每小时${metricLabel}，${isReferencePeriod(state.period) ? "参考演示聚合数据" : "仅统计已观测账本"}；下方可读取准确值。`
                }
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={hourRows}
                    margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                    barCategoryGap={2}
                    accessibilityLayer={false}
                  >
                    <XAxis dataKey="id" hide />
                    <YAxis hide domain={[0, "dataMax"]} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        color: "var(--foreground)",
                        borderColor: "var(--border)",
                        borderRadius: "var(--radius)",
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "var(--foreground)" }}
                      labelFormatter={(label) => `${label}:00 UTC`}
                      formatter={(value) =>
                        state.metric === "spend"
                          ? `${Number(value)} microUSD`
                          : value
                      }
                    />
                    <Bar
                      dataKey="value"
                      name={metricLabel}
                      isAnimationActive={false}
                      radius={[2, 2, 0, 0]}
                    >
                      {result.hours.map((hour) => (
                        <Cell
                          key={hour.id}
                          fill={
                            hour.id === result.peak.id
                              ? "var(--usage-green)"
                              : "var(--usage-hour-base)"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className={styles.axis}>
                {[0, 6, 12, 18, 23].map((hour) => (
                  <span key={hour}>
                    {new Intl.DateTimeFormat(locale, {
                      hour: "numeric",
                      timeZone: "UTC",
                    }).format(
                      new Date(
                        `2026-09-01T${String(hour).padStart(2, "0")}:00:00Z`,
                      ),
                    )}
                  </span>
                ))}
              </div>
            </section>
            <section
              aria-labelledby="usage-model-title"
              className={styles.models}
            >
              <div className={styles.modelHeading}>
                <h2 id="usage-model-title">{en ? "Models" : "模型"}</h2>
                <span>{metricLabel}</span>
              </div>
              <div className={styles.modelList}>
                {result.models.map((model) => (
                  <div
                    className={styles.modelRow}
                    key={model.id}
                    data-usage-model={model.id}
                  >
                    <div className={styles.modelName}>
                      <ApProviderMark
                        provider={
                          referenceUsageModels.find(
                            (item) => item.id === model.id,
                          )?.provider ??
                          apModels.find((item) => item.modelId === model.id)
                            ?.provider ??
                          "?"
                        }
                        size={20}
                      />
                      <span title={model.name}>{model.name}</span>
                    </div>
                    <div className={styles.track} aria-hidden="true">
                      <div
                        style={{
                          width: `${(100 * model.amount.observed) / maxModel}%`,
                        }}
                      />
                    </div>
                    <span
                      className={styles.modelValue}
                      title={formatUsageAmount(
                        model.amount,
                        state.metric,
                        locale,
                        false,
                      )}
                    >
                      {formatUsageAmount(model.amount, state.metric, locale)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <footer className={styles.footer}>
              <p>
                {en ? "Fixture usage" : "样例用量"} ·{" "}
                {fullDate.format(new Date(result.range.from))} –{" "}
                {fullDate.format(
                  new Date(Date.parse(result.range.to) - 86_400_000),
                )}{" "}
                · {en ? "All times UTC" : "全部时间为 UTC"}
              </p>
              {result.missingDays > 0 && (
                <p>
                  {result.missingDays}{" "}
                  {en
                    ? "unavailable days; missing is not zero."
                    : "天不可用；缺失不是零。"}
                </p>
              )}
              {state.notice && (
                <p role="status">
                  {en
                    ? "Fixture download started for the current range."
                    : "已发起当前范围的样例文件下载。"}
                </p>
              )}
            </footer>
            <details
              className={styles.dataDetails}
              onToggle={(event) =>
                cache?.set("usage-insights-details", event.currentTarget.open)
              }
              open={Boolean(cache?.get("usage-insights-details"))}
            >
              <summary>
                {en ? "Readable data & fixture coverage" : "可读数据与样例覆盖"}
              </summary>
              <p className={styles.dataExplanation}>
                {isReferencePeriod(state.period)
                  ? en
                    ? "Reference demo aggregates, not account requests. Daily counts are captured values; tokens are rounded visible weekly totals and spend uses USD cents. Hourly and daily/model allocations are local fixture distributions."
                    : "参考演示聚合数据，并非账户请求。每日计数来自采集值；Token 使用可见的每周舍入值，费用使用美元分。小时和每日模型拆分属于本地样例分布。"
                  : en
                    ? `Observed account fixture coverage: ${apUsagePeriod.from} → ${apUsagePeriod.to}. Missing is not zero.`
                    : `账户样例观测覆盖：${apUsagePeriod.from} → ${apUsagePeriod.to}。缺失不是零。`}
                {isReferencePeriod(state.period) &&
                  ` ${referenceUsagePeriod.revision}`}
              </p>
              <div className={styles.dataControls}>
                <ApSelect
                  label={en ? "Readable dataset" : "可读数据集"}
                  value={state.table}
                  onChange={(value) =>
                    setState((before) => ({
                      ...before,
                      table: value as UsageInsightsState["table"],
                    }))
                  }
                  options={[
                    {
                      value: "daily",
                      label: en ? "Daily activity" : "每日活动",
                    },
                    {
                      value: "weekly",
                      label: en ? "Weekly trend" : "每周趋势",
                    },
                    {
                      value: "hourly",
                      label: en ? "Hourly distribution" : "小时分布",
                    },
                    { value: "models", label: en ? "Model split" : "模型拆分" },
                  ]}
                />
                <ApSelect
                  label={en ? "Fixture interval" : "样例范围"}
                  value={state.period}
                  onChange={(value) =>
                    setState((before) =>
                      updateReferenceUsageFilter(before, "period", value),
                    )
                  }
                  options={periodOptions}
                />
                <ApSelect
                  label={en ? "Coverage demonstration" : "覆盖演示"}
                  value={state.coverageDemo}
                  onChange={(value) =>
                    setState((before) => ({
                      ...before,
                      coverageDemo: value as UsageInsightsState["coverageDemo"],
                    }))
                  }
                  options={[
                    {
                      value: "normal",
                      label: en ? "Observed ledger" : "已观测账本",
                    },
                    {
                      value: "missing-day",
                      label: en ? "Missing September 15" : "9 月 15 日缺失",
                    },
                  ]}
                />
              </div>
              <p className={styles.dataExplanation}>
                {isReferencePeriod(state.period)
                  ? en
                    ? "UTC dates use half-open intervals. Aggregate request, token and microUSD values remain separate. Missing coverage and unknown fields are not measured zero."
                    : "UTC 日期采用左闭右开范围。聚合请求、Token 和 microUSD 数值分别保留。覆盖缺失和未知字段不等于已测零值。"
                  : en
                    ? "UTC has no daylight-saving shift. Each day is a half-open UTC interval. Tokens = input + output; cached tokens are already included in input. Spend is stored in integer microUSD. Unavailable intervals and unknown values remain distinct from measured zero."
                    : "UTC 没有夏令时切换。每日采用 UTC 左闭右开范围。Token = 输入 + 输出；缓存已包含在输入中。费用存储为整数 microUSD。不可用范围、未知值与已测零值明确区分。"}
              </p>
              <Table>
                <TableCaption>
                  {en ? "Readable fixture " : "可读样例"}
                  {metricLabel} · {result.range.from} → {result.range.to}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">
                      {en ? "Bucket / model" : "时间桶 / 模型"}
                    </TableHead>
                    <TableHead scope="col">
                      {en ? "Observed value" : "已观测值"}
                      {state.metric === "spend" ? " (microUSD)" : ""}
                    </TableHead>
                    <TableHead scope="col">
                      {en ? "Coverage" : "覆盖"}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tableRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.label}</TableCell>
                      <TableCell>
                        {row.amount.value === null && row.amount.observed === 0
                          ? "—"
                          : new Intl.NumberFormat(locale).format(
                              row.amount.observed,
                            )}
                        {row.amount.missing > 0
                          ? en
                            ? " + unknown"
                            : " + 未知"
                          : ""}
                      </TableCell>
                      <TableCell>
                        {row.complete
                          ? row.amount.missing
                            ? en
                              ? "Unknown fields"
                              : "字段未知"
                            : en
                              ? "Complete"
                              : "完整"
                          : en
                            ? "Incomplete / unavailable"
                            : "不完整 / 不可用"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          </div>
        </DataRegion>
      </ApPage>
    </div>
  )
}

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario }: RemainingPageProps) {
  return <UsageInsightsView scenario={scenario as ApScenario} />
}
