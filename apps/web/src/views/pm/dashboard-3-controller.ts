import type { PmIssue } from "./issue-domain"
import { usePmScenarioState } from "./shared"
import { pmClock } from "./model"
import type { ProjectCardRecord } from "./project-list-1-fixtures"
import { dashboardBudgets, type DashboardBudget } from "./dashboards-fixtures"
import {
  dashboardMoney,
  dashboardWindow,
  type DashboardAttentionItem,
} from "./dashboards-views"
import { projectHealthBand } from "./project-health"
import { dashboard3BudgetHistory, dashboard3HistoryMonths } from "./dashboard-3-fixtures"
import { addScheduleDays } from "@/lib/schedule-date-utils"

/** Seven cumulative due-date cohorts; completed means the current done state,
 * not an invented historical completion timestamp. */
export function dashboard3SprintRows(
  issues: readonly PmIssue[],
  days: Dashboard3WindowDays,
  locale: "en" | "zh-CN",
) {
  const window = dashboardWindow(days)
  const scheduled = issues.filter(issue => issue.dueDate !== null && issue.dueDate >= window.from && issue.dueDate < window.to)
  return Array.from({ length: 7 }, (_, index) => {
    const from = addScheduleDays(window.from, Math.floor(index * days / 7))
    const to = addScheduleDays(window.from, Math.floor((index + 1) * days / 7))
    const cohort = scheduled.filter(issue => issue.dueDate! < to)
    return {
      from,
      to,
      label: new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(`${from}T00:00:00Z`)),
      completed: cohort.filter(issue => issue.stateId === "done").length,
      scope: cohort.length,
    }
  })
}

export function dashboard3MonthlyBudgetRows(
  projects: readonly ProjectCardRecord[],
  currency: string,
  locale: "en" | "zh-CN",
) {
  const ids = new Set(projects.map(project => project.id))
  const histories = dashboard3BudgetHistory.filter(row => ids.has(row.projectId) && dashboardBudgets.some(budget => budget.projectId === row.projectId && budget.currency === currency))
  return dashboard3HistoryMonths.map((at, index) => {
    const actuals = histories.map(row => row.actual[index]).filter(value => value !== null && value !== undefined)
    const forecasts = histories.map(row => row.forecast[index]).filter(value => value !== null && value !== undefined)
    return {
      at,
      label: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(`${at}T00:00:00Z`)),
      actual: actuals.length ? actuals.reduce((total, value) => total + value, 0) : null,
      forecast: forecasts.length ? forecasts.reduce((total, value) => total + value, 0) : null,
      actualReporting: actuals.length,
      forecastReporting: forecasts.length,
      projects: histories.length,
    }
  })
}

export type Dashboard3WindowDays = 14 | 28 | 56
export type Dashboard3State = {
  windowDays: Dashboard3WindowDays
  projectId: string
}
export function createDashboard3State(): Dashboard3State {
  return { windowDays: 14, projectId: "all" }
}
export function useDashboard3State() {
  return usePmScenarioState("pm-dashboard-3-state", createDashboard3State)
}
export type Dashboard3BudgetRow = {
  project: ProjectCardRecord
  budget: DashboardBudget | null
  currency: DashboardBudget["currency"] | null
  cap: number | null
  actual: number | null
  forecast: number | null
  /** null when the cap is absent or zero, or the actual is not recorded. */
  burn: number | null
  status: "within" | "over" | "over-forecast" | "zero" | "absent"
}
/**
 * Budget facts are projectId-keyed side records; a missing record or null cap
 * is "absent" (never zero), a recorded 0 cap is "zero" with no burn ratio.
 */
export function dashboard3BudgetRows(
  projects: readonly ProjectCardRecord[],
): Dashboard3BudgetRow[] {
  return projects.map((project) => {
    const budget =
      dashboardBudgets.find((item) => item.projectId === project.id) ?? null
    const cap = budget?.cap ?? null
    const actual = budget?.actual ?? null
    const forecast = budget?.forecast ?? null
    const burn =
      cap !== null && cap > 0 && actual !== null ? actual / cap : null
    const status: Dashboard3BudgetRow["status"] =
      cap === null
        ? "absent"
        : cap === 0
          ? "zero"
          : actual !== null && actual > cap
            ? "over"
            : forecast !== null && forecast > cap
              ? "over-forecast"
              : "within"
    return {
      project,
      budget,
      currency: budget?.currency ?? null,
      cap,
      actual,
      forecast,
      burn,
      status,
    }
  })
}
export function budgetStatusLabel(
  status: Dashboard3BudgetRow["status"],
  en: boolean,
) {
  return {
    within: en ? "Within budget" : "预算内",
    over: en ? "Actual over budget" : "实际超支",
    "over-forecast": en ? "Forecast over budget" : "预测超支",
    zero: en ? "Zero budget" : "零预算",
    absent: en ? "Not set" : "未设置",
  }[status]
}
/** Attention reasons derive from actual records; absence is reported, not zeroed. */
export function dashboard3Attention(
  projects: readonly ProjectCardRecord[],
  issues: readonly PmIssue[],
  locale: "en" | "zh-CN",
): DashboardAttentionItem[] {
  const en = locale === "en"
  const items: DashboardAttentionItem[] = []
  for (const row of dashboard3BudgetRows(projects)) {
    const id = row.project.id
    const identifier = row.project.identifier
    if (row.status === "over")
      items.push({
        id: `budget-over-${id}`,
        severity: "error",
        title: en
          ? `${identifier} actual exceeds its budget`
          : `${identifier} 实际支出超出预算`,
        detail: `${dashboardMoney(row.actual!, row.currency!, locale)} / ${dashboardMoney(row.cap!, row.currency!, locale)}`,
        entitySlug: "project-detail-1",
        entityId: id,
      })
    else if (row.status === "over-forecast")
      items.push({
        id: `budget-forecast-${id}`,
        severity: "warning",
        title: en
          ? `${identifier} forecast exceeds its budget`
          : `${identifier} 预测支出超出预算`,
        detail: `${dashboardMoney(row.forecast!, row.currency!, locale)} / ${dashboardMoney(row.cap!, row.currency!, locale)}`,
        entitySlug: "project-detail-1",
        entityId: id,
      })
    else if (row.status === "zero")
      items.push({
        id: `budget-zero-${id}`,
        severity: "warning",
        title: en
          ? `${identifier} records a zero budget`
          : `${identifier} 记录为零预算`,
        detail: en
          ? "Burn percentage is not computed for a zero budget."
          : "零预算不计算消耗百分比。",
        entitySlug: "project-detail-1",
        entityId: id,
      })
  }
  const absentBudgets = projects.filter(
    (project) =>
      !dashboardBudgets.some(
        (budget) => budget.projectId === project.id && budget.cap !== null,
      ),
  )
  if (absentBudgets.length) {
    const absentIds = [...new Set(absentBudgets.map((project) => project.id))]
    items.push({
      id: "budget-absent",
      severity: "info",
      title: en
        ? `${absentBudgets.length} projects have no budget set`
        : `${absentBudgets.length} 个项目未设置预算`,
      detail: `${absentBudgets.map((project) => project.identifier).join(", ")} · ${en ? "absent is not counted as 0" : "缺失不计为 0"}`,
      entitySlug: "project-detail-1",
      // An aggregate spanning several projects is not linked to an arbitrary one.
      ...(absentIds.length === 1 ? { entityId: absentIds[0] } : {}),
    })
  }
  for (const project of projects) {
    if (projectHealthBand(project.health) !== "off-track") continue
    items.push({
      id: `health-${project.id}`,
      severity: "warning",
      title: en
        ? `${project.identifier} is off track`
        : `${project.identifier} 落后于计划`,
      detail: en
        ? `Health ${project.health}/100 recorded for this project.`
        : `该项目记录健康度 ${project.health}/100。`,
      entitySlug: "project-detail-1",
      entityId: project.id,
    })
  }
  const projectIds = new Set(projects.map((project) => project.id))
  const unscheduled = issues.filter(
    (issue) => projectIds.has(issue.projectId) && !issue.dueDate,
  )
  if (unscheduled.length) {
    const unscheduledIds = [
      ...new Set(unscheduled.map((issue) => issue.projectId)),
    ]
    items.push({
      id: "issues-unscheduled",
      severity: "info",
      title: en
        ? `${unscheduled.length} issues have no due date`
        : `${unscheduled.length} 项任务没有到期日`,
      detail: `${unscheduled.map((issue) => issue.identifier).join(", ")} · ${en ? "excluded from window metrics" : "不计入窗口指标"}`,
      entitySlug: "issue-list-1",
      ...(unscheduledIds.length === 1 ? { entityId: unscheduledIds[0] } : {}),
    })
  }
  return items
}
export function dashboard3ComparisonNote(
  days: Dashboard3WindowDays,
  locale: "en" | "zh-CN",
) {
  const window = dashboardWindow(days)
  const previousFrom = new Date(
    Date.parse(`${pmClock.slice(0, 10)}T00:00:00Z`) - days * 86400000,
  )
    .toISOString()
    .slice(0, 10)
  return locale === "en"
    ? `Comparison period: previous ${days} days (${previousFrom} → ${window.from}); unit: issues; buckets: weeks; time zone: UTC.`
    : `比较周期：上一个 ${days} 天（${previousFrom} → ${window.from}）；单位：任务；分桶：周；时区：UTC。`
}
