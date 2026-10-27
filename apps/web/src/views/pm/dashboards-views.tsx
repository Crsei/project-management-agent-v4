import type { ReactNode } from "react"
import { AlertTriangle, CircleCheck, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AnalyticsQuery,
  AnalyticsResult,
} from "@/lib/analytics-model"
import { analyticsQueryKey } from "@/lib/analytics-query"
import { usePmDomainState } from "./domain-session"
import {
  createProjectList1Fixtures,
  type ProjectCardRecord,
} from "./project-list-1-fixtures"
import { issueCatalog, type PmIssue } from "./issue-domain"
import {
  pmClock,
  pmMembers,
  pmTimeZone,
  type PmMember,
  type PmScenario,
} from "./model"
import { dashboardBudgets, type DashboardCurrency } from "./dashboards-fixtures"
import styles from "./dashboards-views.module.css"
import {
  projectHealthBand,
  projectHealthBands,
  type ProjectHealthBand,
} from "./project-health"

/** Shared PM7 project facts; the agreed array shape is owned by PM6 fixtures. */
export function usePmProjectDomain(scenario: PmScenario): ProjectCardRecord[] {
  const [projects] = usePmDomainState("projects", () =>
    createProjectList1Fixtures(scenario),
  )
  return projects
}

export function Picker({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger aria-label={label} className={styles.picker}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className={styles.sectionTitle}>{children}</h2>
}

export function healthBandLabel(band: ProjectHealthBand, en: boolean) {
  return {
    "on-track": en ? "On track" : "正常",
    "at-risk": en ? "At risk" : "有风险",
    "off-track": en ? "Off track" : "落后",
    unknown: en ? "Unknown" : "未知",
  }[band]
}
export function healthBandColor(band: ProjectHealthBand) {
  return {
    "on-track": "var(--status-success)",
    "at-risk": "var(--status-waiting)",
    "off-track": "var(--status-error)",
    unknown: "var(--status-neutral)",
  }[band]
}

export function dashboardMember(id: string): PmMember | undefined {
  return pmMembers.find((member) => member.id === id)
}

/** Whole currency units (0 fraction digits), recorded currency, never summed across currencies. */
export function dashboardMoney(
  value: number,
  currency: DashboardCurrency,
  locale: "en" | "zh-CN",
) {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}
export function dashboardMoneyPrecisionLabel(locale: "en" | "zh-CN") {
  return locale === "en"
    ? "Amounts use whole currency units (0 decimals) in the recorded currency; totals are never combined across currencies."
    : "金额按记录币种以整数单位（0 位小数）显示；不同币种不做合计。"
}

/** Half-open window [clock, clock + days) anchored at the fixture clock. */
export function dashboardWindow(days: number): { from: string; to: string } {
  const from = Date.parse(`${pmClock.slice(0, 10)}T00:00:00Z`)
  return {
    from: new Date(from).toISOString().slice(0, 10),
    to: new Date(from + days * 86400000).toISOString().slice(0, 10),
  }
}
export function dashboardBucketStarts(days: number): string[] {
  const { from, to } = dashboardWindow(days)
  const starts: string[] = []
  for (
    let cursor = Date.parse(`${from}T00:00:00Z`);
    cursor < Date.parse(`${to}T00:00:00Z`);
    cursor += 7 * 86400000
  )
    starts.push(new Date(cursor).toISOString().slice(0, 10))
  return starts
}
export function issuesScheduledIn(
  issues: readonly PmIssue[],
  window: { from: string; to: string },
) {
  return issues.filter(
    (issue) =>
      !!issue.dueDate &&
      issue.dueDate >= window.from &&
      issue.dueDate < window.to,
  )
}

const snapshotId = "pm-domain-snapshot-2026-01-12"
function queryRange() {
  const from = Date.parse(pmClock)
  return {
    from: pmClock,
    to: new Date(from + 86400000).toISOString(),
  }
}
function analyticsBase(scopeId: string, measureId: string, dimension: string) {
  return {
    source: "pm-issue-domain",
    scope: {
      id: scopeId,
      permissionVersion: "pm-fixtures-2026-10-12-v1",
      projectIds: [] as readonly string[],
    },
    measureId,
    measureVersion: 1,
    dimension,
    timeField: "asOf" as const,
    range: queryRange(),
    bucket: "day" as const,
    timeZone: pmTimeZone,
    filters: [] as AnalyticsQuery["filters"],
  }
}

/** Stacked weekly distribution of scheduled issues by state (dashboard-2). */
export function issueScheduleAnalytics(
  issues: readonly PmIssue[],
  projectIds: readonly string[],
  days: number,
  window: { from: string; to: string },
  locale: "en" | "zh-CN",
): { query: AnalyticsQuery; result: AnalyticsResult } {
  const catalog = issueCatalog(locale)
  const query: AnalyticsQuery = {
    ...analyticsBase("pm-dashboard-2-schedule", "issue-count", "dueDateWeek"),
    scope: {
      id: "pm-dashboard-2-schedule",
      permissionVersion: "pm-fixtures-2026-10-12-v1",
      projectIds,
    },
    range: {
      from: `${window.from}T00:00:00Z`,
      to: `${window.to}T00:00:00Z`,
    },
    bucket: "week",
  }
  const key = analyticsQueryKey(query)
  const starts = dashboardBucketStarts(days)
  const scheduled = issuesScheduledIn(issues, window)
  const bucketOf = (date: string) => {
    let match = starts[0]
    for (const start of starts) if (date >= start) match = start
    return match
  }
  const colorByState: Record<
    string,
    AnalyticsResult["series"][number]["color"]
  > = {
    backlog: "backlog",
    todo: "1",
    progress: "active",
    review: "3",
    done: "completed",
  }
  const result: AnalyticsResult = {
    queryKey: key,
    snapshotId,
    asOf: pmClock,
    computedAt: pmClock,
    unit: "issues",
    series: catalog.states.map((state) => ({
      id: state.id,
      label: state.label,
      color: colorByState[state.id] ?? "1",
      points: starts.map((start) => ({
        bucketId: start,
        label: start,
        value: scheduled.filter(
          (issue) =>
            issue.stateId === state.id && bucketOf(issue.dueDate!) === start,
        ).length,
        drilldown: {
          queryKey: key,
          snapshotId,
          seriesId: state.id,
          bucketId: start,
          targetKind: "workItem" as const,
          predicate: [{ field: "stateId" as const, values: [state.id] }],
          totalCount: null,
          membership: "snapshot" as const,
        },
      })),
    })),
    coverage: null,
    total: scheduled.length,
    limitations: [
      locale === "en"
        ? `Bars count issues whose due date falls in ${window.from} → ${window.to}; issues without a due date are listed separately.`
        : `柱状图统计到期日位于 ${window.from} → ${window.to} 的任务；无到期日的任务单独列出。`,
    ],
    // The supplied fixed snapshot fully determines this cohort, including zero.
    completeness: "complete",
  }
  return { query, result }
}

/** Planned (due) vs completed issues per week bucket in the selected window. */
export function issueTrendAnalytics(
  issues: readonly PmIssue[],
  projectIds: readonly string[],
  days: number,
  window: { from: string; to: string },
  locale: "en" | "zh-CN",
): { query: AnalyticsQuery; result: AnalyticsResult } {
  const en = locale === "en"
  const query: AnalyticsQuery = {
    ...analyticsBase("pm-dashboard-trends", "issue-count", "dueDateWeek"),
    scope: {
      id: "pm-dashboard-trends",
      permissionVersion: "pm-fixtures-2026-10-12-v1",
      projectIds,
    },
    range: {
      from: `${window.from}T00:00:00Z`,
      to: `${window.to}T00:00:00Z`,
    },
    bucket: "week",
  }
  const key = analyticsQueryKey(query)
  const starts = dashboardBucketStarts(days)
  const bucketOf = (date: string) => {
    let match = starts[0]
    for (const start of starts) if (date >= start) match = start
    return match
  }
  const scheduled = issuesScheduledIn(issues, window)
  const planned = starts.map((start) => ({
    bucketId: start,
    label: start,
    value: scheduled.filter((issue) => bucketOf(issue.dueDate!) === start)
      .length,
    drilldown: {
      queryKey: key,
      snapshotId,
      seriesId: "planned",
      bucketId: start,
      targetKind: "workItem" as const,
      predicate: [] as AnalyticsQuery["filters"],
      totalCount: null,
      membership: "snapshot" as const,
    },
  }))
  const completed = starts.map((start) => ({
    bucketId: start,
    label: start,
    value: scheduled.filter(
      (issue) => issue.stateId === "done" && bucketOf(issue.dueDate!) === start,
    ).length,
    drilldown: {
      queryKey: key,
      snapshotId,
      seriesId: "completed",
      bucketId: start,
      targetKind: "workItem" as const,
      predicate: [] as AnalyticsQuery["filters"],
      totalCount: null,
      membership: "snapshot" as const,
    },
  }))
  const result: AnalyticsResult = {
    queryKey: key,
    snapshotId,
    asOf: pmClock,
    computedAt: pmClock,
    unit: "issues",
    series: [
      {
        id: "planned",
        label: en ? "Planned (due)" : "计划（到期）",
        color: "1",
        points: planned,
      },
      {
        id: "completed",
        label: en ? "Completed" : "已完成",
        color: "4",
        points: completed,
      },
    ],
    coverage: null,
    total: scheduled.length,
    limitations: [
      en
        ? `Recorded issue history covers ${window.from} → ${window.to}; the previous window of the same length has no recorded issues.`
        : `本地任务历史仅覆盖 ${window.from} → ${window.to}；等长的上一周期没有已记录任务。`,
    ],
    completeness: scheduled.length ? "complete" : "partial",
  }
  return { query, result }
}

/** Donut of project health bands, including the unknown band for null health. */
export function healthAnalytics(
  projects: readonly ProjectCardRecord[],
  locale: "en" | "zh-CN",
): { query: AnalyticsQuery; result: AnalyticsResult } {
  const en = locale === "en"
  const query: AnalyticsQuery = {
    ...analyticsBase("pm-dashboard-health", "project-count", "healthBand"),
    measureId: "project-count",
    scope: {
      id: "pm-dashboard-health",
      permissionVersion: "pm-fixtures-2026-10-12-v1",
      projectIds: projects.map((project) => project.id),
    },
  }
  const key = analyticsQueryKey(query)
  const result: AnalyticsResult = {
    queryKey: key,
    snapshotId,
    asOf: pmClock,
    computedAt: pmClock,
    unit: "projects",
    series: [
      {
        id: "projects",
        label: en ? "Projects" : "项目",
        color: "1",
        points: projectHealthBands.map((band) => ({
          bucketId: band,
          label: healthBandLabel(band, en),
          value: projects.filter(
            (project) => projectHealthBand(project.health) === band,
          ).length,
        })),
      },
    ],
    coverage: null,
    total: projects.length,
    limitations: [],
    completeness: "complete",
  }
  return { query, result }
}

/** Per-currency budget rollups; mixed currencies are never combined. */
export function currencySummaries(projectIds?: readonly string[]) {
  const byCurrency = new Map<
    DashboardCurrency,
    {
      currency: DashboardCurrency
      cap: number
      actual: number
      reporting: number
      withoutCap: number
      withoutActual: number
      zeroCap: number
    }
  >()
  for (const budget of dashboardBudgets) {
    if (projectIds && !projectIds.includes(budget.projectId)) continue
    const row =
      byCurrency.get(budget.currency) ??
      ({
        currency: budget.currency,
        cap: 0,
        actual: 0,
        reporting: 0,
        withoutCap: 0,
        withoutActual: 0,
        zeroCap: 0,
      } as const)
    const next = { ...row }
    next.reporting += 1
    if (budget.cap === null) next.withoutCap += 1
    else {
      next.cap += budget.cap
      if (budget.cap === 0) next.zeroCap += 1
    }
    if (budget.actual === null) next.withoutActual += 1
    else next.actual += budget.actual
    byCurrency.set(budget.currency, next)
  }
  return [...byCurrency.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  )
}

export function DashboardStatCard({
  label,
  value,
  hint,
  onClick,
  pressed,
  tone = "default",
}: {
  label: string
  value: string
  hint?: string
  onClick?: () => void
  pressed?: boolean
  tone?: "default" | "muted"
}) {
  const body = (
    <>
      <span className={styles.statLabel}>{label}</span>
      <strong className={styles.statValue} data-tone={tone}>
        {value}
      </strong>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </>
  )
  return onClick ? (
    <Button
      variant="outline"
      className={styles.statCard}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {body}
    </Button>
  ) : (
    <div className={styles.statCard} data-static="true">
      {body}
    </div>
  )
}

export type DashboardAttentionItem = {
  id: string
  severity: "error" | "warning" | "info"
  title: string
  detail: string
  entitySlug?: string
  entityId?: string
}

export function AttentionList({
  items,
  onOpen,
  emptyLabel,
}: {
  items: readonly DashboardAttentionItem[]
  onOpen: (slug: string, entityId?: string) => void
  emptyLabel: string
}) {
  if (!items.length) return <p className={styles.meta}>{emptyLabel}</p>
  return (
    <ol className={styles.issueList} data-pm-attention-list>
      {items.map((item) => (
        <li key={item.id} className={styles.issueRow}>
          <span
            className={styles.severityDot}
            data-severity={item.severity}
            aria-hidden="true"
          />
          <span className={styles.issueBody}>
            <span className={styles.issueTitle}>{item.title}</span>
            <span className={styles.meta}>{item.detail}</span>
          </span>
          {item.entitySlug && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${item.title} — ${item.detail}`}
              onClick={() => onOpen(item.entitySlug!, item.entityId)}
            >
              {item.severity === "error" ? (
                <AlertTriangle size={16} aria-hidden="true" />
              ) : item.severity === "warning" ? (
                <Info size={16} aria-hidden="true" />
              ) : (
                <CircleCheck size={16} aria-hidden="true" />
              )}
            </Button>
          )}
        </li>
      ))}
    </ol>
  )
}

export type DependencyGraphIssue = {
  id: string
  code: "dangling" | "cycle" | "self-loop"
  severity: "error" | "warning"
  message: string
}

export function DependencyIssueList({
  issues,
  emptyLabel,
}: {
  issues: readonly DependencyGraphIssue[]
  emptyLabel: string
}) {
  if (!issues.length) return <p className={styles.meta}>{emptyLabel}</p>
  return (
    <ul className={styles.issueList} data-pm-dependency-issues>
      {issues.map((issue) => (
        <li
          key={issue.id}
          className={styles.issueRow}
          data-issue-code={issue.code}
        >
          <span
            className={styles.severityDot}
            data-severity={issue.severity}
            aria-hidden="true"
          />
          <span className={styles.issueBody}>
            <span className={styles.issueTitle}>
              {issue.code === "dangling"
                ? "Dangling reference"
                : issue.code === "cycle"
                  ? "Dependency cycle"
                  : "Self loop"}
            </span>
            <span className={styles.meta}>{issue.message}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
