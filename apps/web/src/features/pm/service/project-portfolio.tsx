import type { Entity } from "@contracts"
import { Button } from "@/components/ui/button"
import { PortfolioBudget, PortfolioHealth } from "./dashboard-portfolio"
import { usePortfolioDashboard } from "./pm-service"
import { useText } from "./pm-ui"

export type ProjectPortfolioSummaryProps = { projectId: string }
export type ProjectPortfolioRegionProps = { project: Entity }

/** A project-scoped view of the same assessment and ledger consumed by Dashboard. */
export function ProjectPortfolioSummary({ projectId }: ProjectPortfolioSummaryProps) {
  const query = usePortfolioDashboard()
  const t = useText()
  const current = query.data?.projects.find(row => row.projectId === projectId)
  const health = current?.health?.data
  const budget = current?.budget
  const confidence = health?.confidence === "high" ? t("高", "High") : health?.confidence === "medium" ? t("中", "Medium") : health?.confidence === "low" ? t("低", "Low") : t("未知 / 未评估", "Unknown / unassessed")
  const healthStatus = health?.status === "on_track" ? t("正常", "On track") : health?.status === "at_risk" ? t("有风险", "At risk") : health?.status === "off_track" ? t("偏离计划", "Off track") : t("未评估", "Unassessed")
  const amount = (value: number) => `${value.toLocaleString()} ${budget?.data.currency ?? ""} ${t("最小单位", "minor units")}`
  return <section aria-label={t("项目健康与财务概览", "Project health and financial summary")} className="min-w-0 space-y-3 text-sm">
    {query.isPending && <p role="status">{t("加载项目评估…", "Loading project assessment…")}</p>}
    {query.error && <div role="alert" className="space-y-2"><p>{query.error.message}</p><Button variant="outline" onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>}
    {!query.isPending && !query.error && !current && <p>{t("项目评估不可访问。", "Project assessment is not accessible.")}</p>}
    {!query.error && current && <>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">{t("人工健康评估", "Manual health assessment")}</dt><dd className="font-medium">{healthStatus}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("人工交付信心", "Manual delivery confidence")}</dt><dd className="font-medium">{confidence}</dd></div>
      </dl>
      {health ? <div className="space-y-1"><p className="break-words">{health.rationale}</p><p className="break-all text-xs text-muted-foreground">{t("风险项", "Risk entries")}: {health.risks.length} · {health.assessedAt} · {health.assessedBy}</p></div> : <p className="text-muted-foreground">{t("没有人工评估；不等于零风险。", "No manual assessment; not equivalent to zero risk.")}</p>}
      <p className="text-xs text-muted-foreground">{t("健康和信心独立于任务完成率；不会自动完成项目。", "Health and confidence are independent of task completion; they never complete a project automatically.")}</p>
      {budget ? <>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">{t("预算", "Budget")}</dt><dd className="break-words font-medium">{amount(budget.data.budgetMinor)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("实际支出", "Actual spend")}</dt><dd className="break-words font-medium">{amount(budget.actualMinor)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("剩余成本估计", "Remaining cost estimate")}</dt><dd className="break-words">{amount(budget.data.remainingEstimateMinor)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("完工预测", "Forecast at completion")}</dt><dd className="break-words">{amount(budget.forecastMinor)}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">{budget.data.asOfDate} · {t("预测 = 实际支出 + 显式剩余估计；不换算币种。", "Forecast = actual spend + explicit remaining estimate; no FX conversion.")}</p>
      </> : <p className="text-muted-foreground">{t("尚未设置预算或币种；不能视为零预算。", "No budget or currency configured; not equivalent to a zero budget.")}</p>}
    </>}
  </section>
}

/** Shared editors retain their actor/workspace drafts, head CAS and unknown-command guard. */
export function ProjectHealthRegion({ project }: ProjectPortfolioRegionProps) {
  const t = useText()
  return <section className="min-w-0 space-y-3" aria-label={t("项目健康、信心与风险历史", "Project health, confidence and risk history")}>
    <h3 className="font-medium">{t("健康、信心与风险", "Health, confidence and risk")}</h3>
    <PortfolioHealth projects={[project]} projectId={project.id} />
  </section>
}

export function ProjectFinancialRegion({ project }: ProjectPortfolioRegionProps) {
  const t = useText()
  return <section className="min-w-0 space-y-3" aria-label={t("项目预算、支出与预测历史", "Project budget, spend and forecast history")}>
    <h3 className="font-medium">{t("预算、支出与预测", "Budget, spend and forecast")}</h3>
    <PortfolioBudget projects={[project]} projectId={project.id} />
  </section>
}
