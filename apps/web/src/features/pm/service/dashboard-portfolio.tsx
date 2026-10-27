import type { ReactNode } from "react"
import type { Command, Entity, PortfolioBudgetView, PortfolioProject, PortfolioRisk, ProjectDeliveryConfidence, ProjectHealthStatus } from "@contracts"
import { scopePortfolioDashboard } from "../../../../../../packages/domain/src/dashboard-portfolio"
import { Button } from "@/components/ui/button"
import { usePortfolioDashboard, usePmEntities, usePmService } from "./pm-service"
import { Choice, CommandNotice, Field, Form, allowed, required, today, useAction, useDraftState, useText } from "./pm-ui"

export type PortfolioProps = { projects?: Entity[]; projectId?: string }

function money(value: number | null, currency: string): string {
  return value === null ? `${currency}: overflow` : `${value.toLocaleString()} ${currency} minor units`
}
function parseMinor(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Enter a non-negative safe integer in minor currency units.")
  return Number(value)
}
function confidenceLabel(value: ProjectDeliveryConfidence | null | undefined, t: (zh: string, en: string) => string): string {
  if (value === "high") return t("高", "High")
  if (value === "medium") return t("中", "Medium")
  if (value === "low") return t("低", "Low")
  return t("未知 / 未评估", "Unknown / unassessed")
}
function Notice({ pending, error, retry, children }: { pending: boolean; error: Error | null; retry: () => unknown; children: ReactNode }) {
  const t = useText()
  if (pending) return <p role="status" className="text-sm">{t("加载项目评估…", "Loading portfolio…")}</p>
  if (error) return <div role="alert" className="space-y-2 text-sm"><p>{error.message}</p><Button variant="outline" onClick={() => { void retry() }}>{t("重试读取", "Retry read")}</Button></div>
  return <>{children}</>
}

/** Compact assessment strip; editing and immutable history stay collapsed. */
export function PortfolioHealth({ projects: supplied, projectId }: PortfolioProps) {
  const query = usePortfolioDashboard()
  const projectQuery = usePmEntities("project")
  const projects = supplied ?? projectQuery.data ?? []
  const t = useText()
  const [selection, setSelection] = useDraftState("portfolio-health", "project", "")
  const selectedId = projectId ?? (projects.some(project => project.id === selection) ? selection : projects[0]?.id)
  const selected = projects.find(project => project.id === selectedId)
  const rows = query.data ? scopePortfolioDashboard(query.data, projects.map(project => project.id), projectId).projects : []
  const current = rows.find(project => project.projectId === selectedId)
  const assessed = rows.filter(row => row.health !== null)
  const counts = {
    on_track: assessed.filter(row => row.health?.data.status === "on_track").length,
    at_risk: assessed.filter(row => row.health?.data.status === "at_risk").length,
    off_track: assessed.filter(row => row.health?.data.status === "off_track").length,
  }
  return <section className="min-w-0 space-y-3" aria-label={t("健康与风险", "Health and risk")}>
    <Notice pending={query.isPending || (!supplied && projectQuery.isPending)} error={query.error ?? (!supplied ? projectQuery.error : null)} retry={() => { void query.refetch(); if (!supplied) void projectQuery.refetch() }}>
      {!projectId && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs"><span>{t("正常", "On track")} {counts.on_track}</span><span>{t("风险", "At risk")} {counts.at_risk}</span><span>{t("偏离", "Off track")} {counts.off_track}</span><span>{t("未评估", "Unassessed")} {rows.length - assessed.length}</span></div>}
      {!projectId && projects.length > 0 && <Choice label={t("当前项目", "Current project")} value={selectedId ?? ""} onChange={setSelection} options={projects.map(project => ({ value: project.id, label: String(project.data.name ?? project.id) }))} />}
      {selected && current ? <HealthProject key={selected.id} project={selected} current={current} /> : <p className="text-sm text-muted-foreground">{t("没有可访问项目。", "No accessible project.")}</p>}
    </Notice>
  </section>
}

function HealthProject({ project, current }: { project: Entity; current: PortfolioProject }) {
  const t = useText()
  const { workspace } = usePmService()
  const query = usePortfolioDashboard()
  const action = useAction()
  const scope = `portfolio-health:${project.id}`
  const [base, setBase] = useDraftState(scope, "base", { project, health: current.health })
  const [status, setStatus] = useDraftState<ProjectHealthStatus>(scope, "status", current.health?.data.status ?? "on_track")
  const [confidence, setConfidence] = useDraftState<ProjectDeliveryConfidence | null>(scope, "confidence", current.health?.data.confidence ?? null)
  const [rationale, setRationale] = useDraftState(scope, "rationale", current.health?.data.rationale ?? "")
  const [risks, setRisks] = useDraftState<PortfolioRisk[]>(scope, "risks", current.health?.data.risks ?? [])
  const canEdit = allowed(workspace, "planning.edit", project.id) && !project.data.archivedAt && project.data.archived !== true && ["planning", "active"].includes(String(project.data.status))
  const changed = base.project.version !== project.version || base.health?.version !== current.health?.version
  return <div className="min-w-0 space-y-2 text-sm">
    {current.health ? <><p className="font-medium">{current.health.data.status.replaceAll("_", " ")}</p><p className="line-clamp-2 break-words">{current.health.data.rationale}</p><p className="text-xs text-muted-foreground">{t("风险项", "Risk entries")}: {current.health.data.risks.length} · {current.health.data.assessedAt} · <span className="break-all">{current.health.data.assessedBy}</span></p></> : <p>{t("未评估；不能视为零风险。", "Unassessed; not equivalent to zero risk.")}</p>}
    <p>{t("人工交付信心", "Manual delivery confidence")}: <span className="font-medium">{confidenceLabel(current.health?.data.confidence, t)}</span></p>
    <details className="rounded-md border p-2"><summary className="cursor-pointer font-medium">{t("编辑评估与风险", "Edit assessment and risks")}</summary>
      {!canEdit && <p className="py-2 text-muted-foreground">{t("只读：需要项目编辑权限且项目可写。", "Read only: requires project editing permission and a writable project.")}</p>}
      <div className="pt-3"><Form disabled={!canEdit || action.locked || changed} onSubmit={async () => {
        const command: Command = { commandId: crypto.randomUUID(), commandType: "SetProjectHealth", targetId: project.id, projectId: project.id, expectedVersions: { [base.project.id]: base.project.version, ...(base.health ? { [base.health.id]: base.health.version } : {}) }, payload: { status, confidence, rationale: required.parse(rationale), risks } }
        await action.execute(command)
        const refreshed = await query.refetch()
        const next = refreshed.data?.projects.find(row => row.projectId === project.id)
        if (next) setBase({ project, health: next.health })
      }}>
        <Choice label={t("评估", "Assessment")} value={status} onChange={value => setStatus(value as ProjectHealthStatus)} options={[{ value: "on_track", label: t("正常", "On track") }, { value: "at_risk", label: t("有风险", "At risk") }, { value: "off_track", label: t("偏离计划", "Off track") }]} />
        <Choice label={t("人工交付信心", "Manual delivery confidence")} value={confidence ?? ""} onChange={value => setConfidence(value === "high" || value === "medium" || value === "low" ? value : null)} options={[{ value: "", label: t("未知 / 清除评估", "Unknown / clear assessment") }, { value: "high", label: t("高", "High") }, { value: "medium", label: t("中", "Medium") }, { value: "low", label: t("低", "Low") }]} />
        <p className="text-xs text-muted-foreground">{t("信心为独立人工判断；未知不是低信心，不根据健康级别或任务完成率推断。", "Confidence is an independent manual judgment. Unknown is not low; it is never inferred from health status or task completion.")}</p>
        <Field label={t("评估理由", "Rationale")} value={rationale} onChange={setRationale} multiline required />
        {risks.map((risk, index) => <div key={index} className="space-y-2 rounded-md border p-2"><Field label={t("风险说明", "Risk description")} value={risk.description} onChange={description => setRisks(rows => rows.map((row, position) => position === index ? { ...row, description } : row))} required /><Choice label={t("严重程度", "Severity")} value={risk.severity} onChange={severity => setRisks(rows => rows.map((row, position) => position === index ? { ...row, severity: severity as PortfolioRisk["severity"] } : row))} options={[{ value: "low", label: t("低", "Low") }, { value: "medium", label: t("中", "Medium") }, { value: "high", label: t("高", "High") }]} /><Field label={t("缓解措施", "Mitigation")} value={risk.mitigation} onChange={mitigation => setRisks(rows => rows.map((row, position) => position === index ? { ...row, mitigation } : row))} multiline /><Button type="button" variant="outline" onClick={() => setRisks(rows => rows.filter((_, position) => position !== index))}>{t("移除风险项", "Remove risk")}</Button></div>)}
        <Button type="button" variant="outline" disabled={risks.length >= 100} onClick={() => setRisks(rows => [...rows, { description: "", severity: "medium", mitigation: "" }])}>{t("添加风险项", "Add risk")}</Button>
      </Form>{changed && <p role="status" className="mt-2">{t("版本已变化。保留草稿并采用当前版本后再保存。", "Version changed. Keep your draft and adopt the current version before saving.")}</p>}<Button type="button" variant="ghost" disabled={action.locked} onClick={() => setBase({ project, health: current.health })}>{t("采用当前版本（保留草稿）", "Use current version (keep draft)")}</Button><CommandNotice /></div>
    </details>
    <details className="rounded-md border p-2"><summary className="cursor-pointer">{t("评估历史", "Assessment history")} ({current.healthHistory.length})</summary><ol className="max-h-72 space-y-3 overflow-auto py-3">{[...current.healthHistory].reverse().map(row => <li key={row.id} className="break-words"><p className="font-medium">{row.data.status.replaceAll("_", " ")}</p><p>{t("交付信心", "Delivery confidence")}: {confidenceLabel(row.data.confidence, t)}</p><p>{row.data.rationale}</p><ul>{row.data.risks.map((risk, index) => <li key={index}>[{risk.severity}] {risk.description}{risk.mitigation && ` — ${risk.mitigation}`}</li>)}</ul><p className="break-all text-xs text-muted-foreground">{row.data.assessedAt} · {row.data.assessedBy}</p></li>)}</ol></details>
  </div>
}

/** Explicit minor-unit financial summary; no task-based estimates or implicit FX. */
export function PortfolioBudget({ projects: supplied, projectId }: PortfolioProps) {
  const query = usePortfolioDashboard()
  const projectQuery = usePmEntities("project")
  const projects = supplied ?? projectQuery.data ?? []
  const t = useText()
  const [selection, setSelection] = useDraftState("portfolio-budget", "project", "")
  const selectedId = projectId ?? (projects.some(project => project.id === selection) ? selection : projects[0]?.id)
  const selected = projects.find(project => project.id === selectedId)
  const dashboard = query.data ? scopePortfolioDashboard(query.data, projects.map(project => project.id), projectId) : undefined
  const current = dashboard?.projects.find(project => project.projectId === selectedId)
  return <section className="min-w-0 space-y-3" aria-label={t("预算与预测", "Budget and forecast")}>
    <Notice pending={query.isPending || (!supplied && projectQuery.isPending)} error={query.error ?? (!supplied ? projectQuery.error : null)} retry={() => { void query.refetch(); if (!supplied) void projectQuery.refetch() }}>
      {!projectId && <div className="grid gap-2 text-xs sm:grid-cols-2">{dashboard?.totals.map(total => <div key={total.currency} className="rounded-md bg-muted/50 p-2"><p className="font-medium">{total.currency} · {total.projectCount} {t("个项目", "projects")}</p><p>{t("预算", "Budget")}: {money(total.budgetMinor, total.currency)}</p><p>{t("实际", "Actual")}: {money(total.actualMinor, total.currency)}</p><p>{t("预测", "Forecast")}: {money(total.forecastMinor, total.currency)}</p>{total.overflow && <p role="alert">{t("总额超过安全整数范围；未舍入或相加币种。", "Total exceeds the safe integer range; not rounded or FX-converted.")}</p>}</div>)}</div>}
      {!projectId && projects.length > 0 && <Choice label={t("当前项目", "Current project")} value={selectedId ?? ""} onChange={setSelection} options={projects.map(project => ({ value: project.id, label: String(project.data.name ?? project.id) }))} />}
      {selected && current ? <BudgetProject key={selected.id} project={selected} current={current} /> : <p className="text-sm text-muted-foreground">{t("没有可访问项目。", "No accessible project.")}</p>}
    </Notice>
  </section>
}

function BudgetProject({ project, current }: { project: Entity; current: PortfolioProject }) {
  const t = useText()
  const { workspace } = usePmService()
  const query = usePortfolioDashboard()
  const action = useAction()
  const scope = `portfolio-budget:${project.id}`
  const [base, setBase] = useDraftState(scope, "base", { project, budget: current.budget })
  const [currency, setCurrency] = useDraftState(scope, "currency", current.budget?.data.currency ?? "")
  const [budget, setBudget] = useDraftState(scope, "budget", current.budget ? String(current.budget.data.budgetMinor) : "")
  const [remaining, setRemaining] = useDraftState(scope, "remaining", current.budget ? String(current.budget.data.remainingEstimateMinor) : "")
  const [asOfDate, setAsOfDate] = useDraftState(scope, "asOfDate", current.budget?.data.asOfDate ?? today())
  const [reason, setReason] = useDraftState(scope, "reason", "")
  const [amount, setAmount] = useDraftState(scope, "amount", "")
  const [spentOn, setSpentOn] = useDraftState(scope, "spentOn", today())
  const [description, setDescription] = useDraftState(scope, "description", "")
  const [spendId, setSpendId] = useDraftState(scope, "spendId", "")
  const [operation, setOperation] = useDraftState(scope, "operation", "RecordProjectSpend")
  const canEdit = allowed(workspace, "planning.edit", project.id) && !project.data.archivedAt && project.data.archived !== true && ["planning", "active"].includes(String(project.data.status))
  const changed = base.project.version !== project.version || base.budget?.version !== current.budget?.version
  async function execute(commandType: Command["commandType"], payload: Record<string, unknown>) {
    await action.execute({ commandId: crypto.randomUUID(), commandType, targetId: project.id, projectId: project.id, expectedVersions: { [base.project.id]: base.project.version, ...(base.budget ? { [base.budget.id]: base.budget.version } : {}) }, payload } as Command)
    const refreshed = await query.refetch()
    const next = refreshed.data?.projects.find(row => row.projectId === project.id)
    if (next) setBase({ project, budget: next.budget })
  }
  return <div className="min-w-0 space-y-2 text-sm">
    {current.budget ? <BudgetSummary budget={current.budget} /> : <p>{t("尚未设置预算或币种。", "No budget or currency configured.")}</p>}
    <details className="rounded-md border p-2"><summary className="cursor-pointer font-medium">{t("编辑预算 / 剩余成本", "Edit budget / remaining cost")}</summary><div className="space-y-3 pt-3">
      <p className="text-xs text-muted-foreground">{t("金额为最小货币单位整数；预测 = 实际支出 + 剩余成本估计。", "Amounts are integer minor units; forecast = actual spend + remaining cost estimate.")}</p>
      {!canEdit && <p>{t("当前项目只读。", "This project is read only.")}</p>}
      <Form disabled={!canEdit || action.locked || changed} onSubmit={() => execute("SetProjectBudget", { currency: current.spend.length > 0 ? current.budget!.data.currency : currency.trim().toUpperCase(), budgetMinor: parseMinor(budget), remainingEstimateMinor: parseMinor(remaining), asOfDate, reason: required.parse(reason) })}>
        <Field label={t("ISO 币种（如 CNY / USD / JPY）", "ISO currency (e.g. CNY / USD / JPY)")} value={current.spend.length > 0 ? current.budget!.data.currency : currency} onChange={setCurrency} disabled={current.spend.length > 0} required />
        <Field label={t("预算（最小单位）", "Budget (minor units)")} value={budget} onChange={setBudget} required />
        <Field label={t("剩余成本估计（最小单位）", "Remaining estimate (minor units)")} value={remaining} onChange={setRemaining} required />
        <Field label={t("财务日期", "Financial as-of date")} type="date" value={asOfDate} onChange={setAsOfDate} required />
        <Field label={t("变更理由", "Change rationale")} value={reason} onChange={setReason} multiline required />
      </Form>
      {current.budget && <Button type="button" variant="outline" disabled={!canEdit || action.locked || changed} onClick={() => { void action.run(() => execute("SetProjectRemainingEstimate", { remainingEstimateMinor: parseMinor(remaining), asOfDate, reason: required.parse(reason) })) }}>{t("只保存剩余成本", "Save remaining estimate only")}</Button>}
      {action.localError && <p role="alert">{action.localError}</p>}
    </div></details>
    {current.budget && <details className="rounded-md border p-2"><summary className="cursor-pointer font-medium">{t("记录 / 作废 / 纠正支出", "Record / void / correct spend")}</summary><div className="pt-3"><Form disabled={!canEdit || action.locked || changed} onSubmit={() => execute(operation as Command["commandType"], operation === "VoidProjectSpend" ? { spendId, reason: required.parse(reason) } : { currency: current.budget!.data.currency, amountMinor: parseMinor(amount), spentOn, description: required.parse(description), ...(operation === "CorrectProjectSpend" ? { spendId, reason: required.parse(reason) } : {}) })}>
      <Choice label={t("操作", "Operation")} value={operation} onChange={setOperation} options={[{ value: "RecordProjectSpend", label: t("新增真实支出", "Record actual spend") }, { value: "VoidProjectSpend", label: t("作废（保留原记录）", "Void (retain original)") }, { value: "CorrectProjectSpend", label: t("纠正（作废并新增）", "Correct (void and replace)") }]} />
      {operation !== "RecordProjectSpend" && <><Choice label={t("原支出", "Original spend")} value={spendId} onChange={setSpendId} options={[{ value: "", label: "—" }, ...current.spend.filter(row => !row.void).map(row => ({ value: row.id, label: `${row.data.spentOn} · ${money(row.data.amountMinor, row.data.currency)} · ${row.data.description}` }))]} /><Field label={t("作废 / 纠正理由", "Void / correction rationale")} value={reason} onChange={setReason} required /></>}
      {operation !== "VoidProjectSpend" && <><Field label={`${t("支出（最小单位）", "Spend (minor units)")} · ${current.budget.data.currency}`} value={amount} onChange={setAmount} required /><Field label={t("实际支出日期", "Actual spend date")} type="date" value={spentOn} onChange={setSpentOn} required /><Field label={t("支出说明", "Spend description")} value={description} onChange={setDescription} multiline required /></>}
    </Form></div></details>}
    {changed && <p role="status">{t("版本已变化，草稿仍保留。", "Version changed; draft retained.")}</p>}
    {canEdit && changed && <Button type="button" variant="ghost" disabled={action.locked} onClick={() => setBase({ project, budget: current.budget })}>{t("采用当前版本（保留草稿）", "Use current version (keep draft)")}</Button>}
    <details className="rounded-md border p-2"><summary className="cursor-pointer">{t("不可变支出与预测历史", "Immutable spend and forecast history")} ({current.financialHistory.length})</summary><div className="max-h-80 space-y-4 overflow-auto py-3">
      <ol className="space-y-3">{[...current.spend].reverse().map(row => <li key={row.id} className="break-words"><p className={row.void ? "line-through" : "font-medium"}>{row.data.spentOn} · {money(row.data.amountMinor, row.data.currency)}</p><p>{row.data.description}</p>{row.data.correctsSpendId && <p className="break-all text-xs">{t("纠正原记录", "Corrects")}: {row.data.correctsSpendId}</p>}<p className="break-all text-xs text-muted-foreground">{row.createdAt} · {row.createdBy}</p>{row.void && <p className="break-all text-xs">{t("已作废", "Voided")}: {row.void.data.reason} · {row.void.createdAt} · {row.void.createdBy}</p>}</li>)}</ol>
      <ol className="space-y-3 border-t pt-3">{[...current.financialHistory].reverse().map(row => <li key={row.id} className="break-words"><p>{row.data.asOfDate} · {row.data.cause}</p><p>{t("预算", "Budget")}: {money(row.data.budgetMinor, row.data.currency)}</p><p>{t("实际 / 剩余 / 预测", "Actual / remaining / forecast")}: {row.data.actualMinor.toLocaleString()} / {row.data.remainingEstimateMinor.toLocaleString()} / {row.data.forecastMinor.toLocaleString()} {row.data.currency} {t("最小单位", "minor units")}</p><p>{row.data.reason}</p><p className="break-all text-xs text-muted-foreground">{row.createdAt} · {row.createdBy}</p></li>)}</ol>
    </div></details>
    <CommandNotice />
  </div>
}

function BudgetSummary({ budget }: { budget: PortfolioBudgetView }) {
  const t = useText()
  const maximum = Math.max(budget.data.budgetMinor, budget.forecastMinor, 1)
  return <div className="space-y-2"><dl className="grid grid-cols-2 gap-2 text-xs"><div><dt className="text-muted-foreground">{t("预算", "Budget")}</dt><dd className="break-words font-medium">{money(budget.data.budgetMinor, budget.data.currency)}</dd></div><div><dt className="text-muted-foreground">{t("实际支出", "Actual spend")}</dt><dd className="break-words font-medium">{money(budget.actualMinor, budget.data.currency)}</dd></div><div><dt className="text-muted-foreground">{t("剩余成本", "Remaining cost")}</dt><dd className="break-words">{money(budget.data.remainingEstimateMinor, budget.data.currency)}</dd></div><div><dt className="text-muted-foreground">{t("完工预测", "Forecast at completion")}</dt><dd className="break-words">{money(budget.forecastMinor, budget.data.currency)}</dd></div></dl><div role="img" aria-label={`${t("实际与预测相对预算", "Actual and forecast relative to budget")}: ${budget.actualMinor} / ${budget.forecastMinor} / ${budget.data.budgetMinor}`} className="space-y-1"><div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-foreground" style={{ width: `${budget.actualMinor / maximum * 100}%` }} /></div><div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-amber-500" style={{ width: `${budget.forecastMinor / maximum * 100}%` }} /></div></div><p className="text-xs text-muted-foreground">{t("预测 = 实际 + 显式剩余估计；不换算币种。", "Forecast = actual + explicit remaining estimate; no FX conversion.")}</p></div>
}
