"use client"
import { useMemo, useRef } from "react"
import { Download, ExternalLink, TriangleAlert } from "lucide-react"
import type { RemainingPageProps } from "../../showcase/model"
import { Bar, BarChart, ResponsiveContainer, Tooltip } from "recharts"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { MetricSummary } from "@easyuse-ui/ui/components/blocks/metric-summary"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@easyuse-ui/ui/components/ui/table"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect, ApModelIdentity } from "../shared"
import { useApState } from "../state"
import {
  apScope,
  apScenarios,
  apScenarioIds,
  type ApLocale,
  type ApScenario,
} from "../model"
import { apUsagePeriod } from "../fixtures/usage-ledger"
import { createApAccountData } from "../fixtures/accounts"
import {
  modelUsageHealth,
  type ModelUsageFixture,
  budgetUsageStatus,
  changeUsageRange,
  closeUsageDetail,
  confirmUsageBudget,
  createModelUsageState,
  modelUsageExport,
  modelUsageSelection,
  openUsageDetail,
  saveUsageBudget,
  usageRequests,
  usageTotals,
  type UsageModel,
  type UsagePeriod,
} from "./controller"
import styles from "./model-usage.module.css"
import { createReferenceUsageFixture } from "./fixtures"
export const pageScenarios = apScenarios

export function RemainingPageView({ scenario }: RemainingPageProps) {
  const selectedScenario =
    apScenarioIds.find((id) => id === scenario) ?? "default"
  const fixture = useMemo(
    () => createReferenceUsageFixture(selectedScenario),
    [selectedScenario],
  )
  return (
    <ModelUsageView
      key={selectedScenario}
      scenario={selectedScenario}
      fixture={fixture}
    />
  )
}

function usageMoney(value: number | null, locale: ApLocale) {
  if (value === null) return locale === "en" ? "Unknown" : "未知"
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 10_000 ? 6 : 2,
  }).format(value / 1_000_000)
}
function usageNumber(value: number | null, locale: ApLocale, compact = false) {
  if (value === null) return locale === "en" ? "Unknown" : "未知"
  return new Intl.NumberFormat(locale, {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}
function usageDate(date: string, locale: ApLocale) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: apUsagePeriod.timeZone,
  }).format(new Date(date))
}
export function ModelUsageChart({
  entry,
  locale,
  onDay,
}: {
  entry: UsageModel
  locale: ApLocale
  onDay: (date: string) => void
}) {
  const en = locale === "en",
    name = entry.model?.name ?? entry.modelId
  return (
    <div
      className={styles.chart}
      data-model-usage-chart
      role="group"
      aria-label={`${name} · ${en ? "Daily requests" : "每日请求"}`}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 396, height: 76 }}
      >
        <BarChart
          data={entry.days}
          margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
          barCategoryGap={2}
          accessibilityLayer={false}
        >
          <Tooltip
            cursor={{ fill: "var(--surface-hover)" }}
            content={({ active, payload }) => {
              const day = active
                ? (payload?.[0]?.payload as
                    UsageModel["days"][number] | undefined)
                : undefined
              return day ? (
                <div className={styles.chartTooltip}>
                  <strong>{usageDate(day.date, locale)}</strong>
                  <p>
                    {day.requests} {en ? "requests" : "次请求"} ·{" "}
                    {usageMoney(day.costMicroUsd, locale)}
                  </p>
                  <p>
                    {day.limited} {en ? "limited" : "限流"} · {day.failed}{" "}
                    {en ? "failed" : "失败"}
                  </p>
                </div>
              ) : null
            }}
          />
          <Bar
            dataKey="successful"
            stackId="requests"
            fill="var(--mu-success)"
            isAnimationActive={false}
            onClick={(_data, index) => {
              onDay(entry.days[index].date)
            }}
          />
          <Bar
            dataKey="limited"
            stackId="requests"
            fill="var(--mu-limited)"
            minPointSize={(value) => (value != null && value > 0 ? 2 : 0)}
            isAnimationActive={false}
            onClick={(_data, index) => {
              onDay(entry.days[index].date)
            }}
          />
          <Bar
            dataKey="failed"
            stackId="requests"
            minPointSize={(value) => (value != null && value > 0 ? 2 : 0)}
            fill="var(--mu-failed)"
            isAnimationActive={false}
            onClick={(_data, index) => {
              onDay(entry.days[index].date)
            }}
          />
          <Bar
            dataKey="unknown"
            stackId="requests"
            fill="var(--text-muted)"
            isAnimationActive={false}
            onClick={(_data, index) => {
              onDay(entry.days[index].date)
            }}
          />
        </BarChart>
      </ResponsiveContainer>
      <span className="sr-only">
        {entry.totals.requests}{" "}
        {en
          ? "requests. Daily values are available in Activity."
          : "次请求。每日数值可在活动详情中读取。"}
      </span>
    </div>
  )
}
export function ModelUsageView({
  scenario,
  fixture,
}: {
  scenario: ApScenario
  fixture?: ModelUsageFixture
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [state, setState] = useApState(
    (fixture ? "model-usage-reference:" : "model-usage:") + scenario,
    () => createModelUsageState(scenario, fixture),
  )
  const returnFocus = useRef<HTMLElement | null>(null)
  const activityTriggers = useRef<Map<string, HTMLButtonElement> | null>(null)
  if (activityTriggers.current == null)
    activityTriggers.current = new Map<string, HTMLButtonElement>()
  const openDetail = (
    modelId: string,
    kind: "activity" | "budget" | "model",
    date: string | null = null,
  ) => {
    if (!state.selected) {
      const active = document.activeElement
      returnFocus.current =
        date !== null
          ? activityTriggers.current!.get(modelId) ?? null
          : active instanceof HTMLElement && active !== document.body
            ? active
            : null
    }
    setState((before) => openUsageDetail(before, modelId, kind, date))
  }
  const selection = modelUsageSelection(state),
    projects = fixture?.projects ?? createApAccountData(scenario).projects
  const loading = scenario === "loading" && !state.recovered,
    refreshError = scenario === "refresh-error" && !state.recovered
  const canWrite = apScope.canWrite && scenario !== "readonly"
  const selected =
    selection.models.find(
      (model) => model.modelId === state.selected?.modelId,
    ) ?? null
  const projectName =
    state.projectId === "all"
      ? en
        ? "All projects"
        : "全部项目"
      : (projects.find((project) => project.projectId === state.projectId)
          ?.name ?? state.projectId)
  const attention = selection.models.filter(
    (entry) => !["healthy", "ready"].includes(modelUsageHealth(entry)),
  ).length
  const activeModels = selection.models.filter(
    (entry) => entry.totals.requests > 0,
  ).length
  const monthly = selected
    ? usageTotals(
        usageRequests(state, true).filter(
          (request) => request.modelId === selected.modelId,
        ),
      )
    : null
  const budget = selected ? (state.budgets[selected.modelId] ?? null) : null
  const budgetStatus = budgetUsageStatus(budget, monthly?.costMicroUsd ?? null)
  const locked =
    state.operation?.status === "pending" ||
    state.operation?.status === "unknown"
  const recovery = () => setState((before) => ({ ...before, recovered: true }))
  const exportUsage = () => {
    const url = URL.createObjectURL(
      new Blob([modelUsageExport(state)], { type: "application/json" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "model-usage-fixture.json"
    anchor.click()
    URL.revokeObjectURL(url)
    setState((before) => ({ ...before, notice: "exported" }))
  }
  const statusCopy = {
    unset: en ? "Budget not set" : "预算未设置",
    missing: en
      ? "Usage unavailable · budget cannot be evaluated"
      : "用量缺失 · 无法评估预算",
    zero: en ? "Zero budget · no spend" : "零预算 · 未消费",
    exceeded: en ? "Budget exceeded" : "预算已超额",
    within: en ? "Within budget" : "预算范围内",
  }
  return (
    <div className={styles.root}>
      <ApPage
        variant="analytics"
        pageId="model-usage"
        title={en ? "Model usage" : "模型用量"}
        description={
          en
            ? "Track usage, spend, and reliability across your models."
            : "追踪各模型的用量、费用和可靠性。"
        }
        actions={
          <Button
            className={styles.export}
            onClick={exportUsage}
            disabled={loading}
          >
            <Download size={14} aria-hidden="true" />
            {en ? "Export" : "导出"}
          </Button>
        }
        toolbar={
          <div className={styles.filters}>
            <div className={styles.filterInputs}>
              <ApSelect
                label={en ? "Project" : "项目"}
                value={state.projectId}
                options={[
                  { value: "all", label: en ? "All projects" : "全部项目" },
                  ...projects.map((project) => ({
                    value: project.projectId,
                    label: project.name,
                  })),
                ]}
                onChange={(projectId) =>
                  setState((before) => changeUsageRange(before, { projectId }))
                }
              />
              <ApSelect
                label={en ? "Usage period" : "用量周期"}
                value={state.period}
                options={[
                  { value: "14", label: en ? "Last 14 days" : "最近 14 天" },
                  { value: "30", label: en ? "Last 30 days" : "最近 30 天" },
                ]}
                onChange={(period) =>
                  setState((before) =>
                    changeUsageRange(before, { period: period as UsagePeriod }),
                  )
                }
              />
            </div>
            <span>
              {en ? "As of " : "截至 "}
              {new Intl.DateTimeFormat(locale, {
                year: "numeric",
                month: "short",
                day: "numeric",
                timeZone: state.statementPeriod.timeZone,
              }).format(
                new Date(Date.parse(state.statementPeriod.to) - 86_400_000),
              )}
            </span>
          </div>
        }
      >
        {loading && (
          <div className={styles.notice}>
            <Button variant="outline" size="sm" onClick={recovery}>
              {en ? "Finish fixture loading" : "完成样例加载"}
            </Button>
          </div>
        )}
        <DataRegion
          state={
            loading
              ? "loading"
              : refreshError
                ? "error"
                : selection.totals.missingUsage
                  ? "partial"
                  : "success"
          }
          hasContent={!loading}
          rowHeight={302}
          onRetry={recovery}
          updatedAt={state.statementPeriod.to}
          loadingLabel={en ? "Loading model usage" : "正在加载模型用量"}
          partialDescription={
            en
              ? "Some usage is missing. Unknown totals are not zero; request counts remain available."
              : "部分用量缺失。未知汇总不是零；请求计数仍可读取。"
          }
          error={{
            category: "request",
            message: en ? "Usage refresh failed." : "用量刷新失败。",
            reason: en
              ? "The local fixture read was rejected. Existing data and planning budgets are preserved."
              : "本地样例读取被拒绝。已有数据和规划预算已保留。",
          }}
        >
          <MetricSummary
            className={styles.metrics}
            items={[
              {
                id: "requests",
                label: en ? "Total requests" : "请求总数",
                value: (
                  <span data-model-usage-total-requests>
                    {usageNumber(selection.totals.requests, locale, true)}
                  </span>
                ),
                unit: `${usageNumber(selection.totals.tokens, locale, true)} ${en ? "tokens" : "Token"}`,
              },
              {
                id: "spend",
                label: en ? "Usage spend" : "用量费用",
                value: (
                  <span
                    data-model-usage-total-cost
                    data-micro-usd={selection.totals.costMicroUsd ?? "unknown"}
                  >
                    {usageMoney(selection.totals.costMicroUsd, locale)}
                  </span>
                ),
                unit: en ? "USD · this period" : "USD · 本周期",
              },
              {
                id: "models",
                label: en ? "Models in use" : "使用中的模型",
                value: (
                  <span>
                    {activeModels}
                    <span className={styles.of}>
                      {" "}
                      {en ? "of" : "/"} {selection.models.length}
                    </span>
                  </span>
                ),
                unit: (
                  <span className={attention ? styles.attention : ""}>
                    {attention
                      ? en
                        ? `${attention} needs attention`
                        : `${attention} 个需关注`
                      : en
                        ? "All healthy"
                        : "全部正常"}
                  </span>
                ),
              },
            ]}
          />
          <div className={styles.grid}>
            {selection.models.map((entry, index) => {
              const name = entry.model?.name ?? entry.modelId
              const health = modelUsageHealth(entry)
              const needsAttention = !["healthy", "ready"].includes(health)
              const healthy = entry.totals.requests > 0
              return (
                <article
                  key={entry.modelId}
                  className={styles.card}
                  aria-label={`${name} ${en ? "usage" : "用量"}`}
                  data-model-usage-id={entry.modelId}
                >
                  <header className={styles.cardHeader}>
                    <h2 title={name}>
                      {entry.model ? (
                        <ApModelIdentity model={entry.model} />
                      ) : (
                        <span className={styles.unknownModel}>{name}</span>
                      )}
                    </h2>
                    {needsAttention ? (
                      <TriangleAlert
                        size={16}
                        aria-label={en ? "Needs attention" : "需要关注"}
                        className={styles.attention}
                      />
                    ) : (
                      <span>
                        {entry.model?.provider ??
                          (en ? "Unknown model" : "未知模型")}
                      </span>
                    )}
                  </header>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTop}>
                      <p>
                        {
                          [
                            en ? "Reasoning & tools" : "推理与工具",
                            en ? "Writing & analysis" : "写作与分析",
                            en ? "Fast responses" : "快速响应",
                            en ? "Multilingual tasks" : "多语言任务",
                          ][Math.min(index, 3)]
                        }
                      </p>
                      <Badge
                        size="sm"
                        tone={needsAttention ? "warning" : "success"}
                      >
                        {
                          {
                            missing: en ? "Missing usage" : "用量缺失",
                            errors: en ? "Elevated errors" : "错误率升高",
                            limited: en ? "Rate limited" : "发生限流",
                            healthy: en ? "Healthy" : "正常",
                            ready: en ? "Ready" : "就绪",
                          }[health]
                        }
                      </Badge>
                    </div>
                    {healthy ? (
                      <>
                        <ModelUsageChart
                          entry={entry}
                          locale={locale}
                          onDay={(date) =>
                            openDetail(entry.modelId, "activity", date)
                          }
                        />
                        <div className={styles.cardNumbers}>
                          <span>
                            {usageNumber(entry.totals.requests, locale, true)}{" "}
                            {en ? "requests" : "次请求"}
                          </span>
                          <span>
                            {usageMoney(entry.totals.costMicroUsd, locale)}{" "}
                            {en ? "used" : "已使用"}
                          </span>
                        </div>
                        <p className={styles.tokens}>
                          {state.period}
                          {en ? "-day usage" : "天用量"} ·{" "}
                          {usageNumber(entry.totals.tokens, locale, true)}{" "}
                          {en ? "tokens" : "Token"}
                        </p>
                        <div className={styles.cardActions}>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`${en ? "Activity for" : "活动详情："} ${name}`}
                            ref={(element) => {
                              if (element)
                                activityTriggers.current!.set(entry.modelId, element)
                              else activityTriggers.current!.delete(entry.modelId)
                            }}
                            onClick={() =>
                              openDetail(entry.modelId, "activity")
                            }
                          >
                            {en ? "Activity" : "活动"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`${en ? "Budget for" : "预算："} ${name}`}
                            onClick={() => openDetail(entry.modelId, "budget")}
                          >
                            {en ? "Budget" : "预算"}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className={styles.emptyModel}>
                        <p>{en ? "No requests yet" : "暂无请求"}</p>
                        <p>
                          {en
                            ? "This model is available to your workspace. Its usage will appear here after your first API request."
                            : "此模型可供工作区使用。首次 API 请求后将显示用量。"}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openDetail(entry.modelId, "model")}
                        >
                          {en ? "View model" : "查看模型"}
                        </Button>
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
          <div className={styles.legend}>
            <div>
              <span>
                <i className={styles.successDot} />
                {en ? "Successful" : "成功"}
              </span>
              <span>
                <i className={styles.limitedDot} />
                {en ? "Rate limited" : "限流"}
              </span>
              <span>
                <i className={styles.failedDot} />
                {en ? "Failed" : "失败"}
              </span>
              {selection.totals.unknown > 0 && (
                <span>
                  {en ? "Unknown outcome" : "结果未知"} ·{" "}
                  {selection.totals.unknown}
                </span>
              )}
            </div>
            <a href="/showcase/usage-insights">
              {en ? "Explore usage insights ↗" : "探索用量分析 ↗"}
            </a>
          </div>
          <p className={styles.fixture}>
            {en
              ? "Demo workspace · Illustrative usage and costs. Budget changes apply to this demo session."
              : "演示工作区 · 用量和费用来自样例。预算修改仅作用于本次演示会话。"}
            <br />
            {selection.range.from.slice(0, 10)} →{" "}
            {selection.range.to.slice(0, 10)} · {apUsagePeriod.timeZone} ·{" "}
            {en
              ? "End exclusive. Input includes cached tokens; total = input + output."
              : "不含结束时刻。输入已含缓存 Token；总量 = 输入 + 输出。"}
          </p>
          {state.notice && (
            <p role="status" className={styles.fixture}>
              {state.notice === "saved"
                ? en
                  ? "Planning budget saved locally. Billing and API limits are unchanged."
                  : "规划预算已在本地保存。账单和 API 限额未改变。"
                : en
                  ? "Fixture usage exported."
                  : "样例用量已导出。"}
            </p>
          )}
          {locked && !state.selected && (
            <p className={styles.fixture}>
              {state.operation?.operationId} · {state.operation?.status}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  openDetail(state.operation!.payload.modelId, "budget")
                }
              >
                {en ? "Inspect operation" : "检查操作"}
              </Button>
            </p>
          )}
        </DataRegion>
      </ApPage>
      <Dialog
        open={state.selected !== null}
        onOpenChange={(open) => {
          if (!open) setState(closeUsageDetail)
        }}
      >
        <DialogContent className={styles.dialog} finalFocus={returnFocus}>
          {selected && (
            <>
              <DialogTitle className={styles.dialogTitle}>
                {selected.model?.name ?? selected.modelId}{" "}
                {state.selected?.kind === "budget"
                  ? en
                    ? "budget"
                    : "预算"
                  : state.selected?.kind === "model"
                    ? en
                      ? "model"
                      : "模型"
                    : en
                      ? "activity"
                      : "活动"}
              </DialogTitle>
              <DialogDescription className={styles.dialogDescription}>
                {state.selected?.kind === "budget"
                  ? en
                    ? "Set a monthly USD budget for this model across all projects in this demo."
                    : "为此模型在全部项目中设置演示月度 USD 预算。"
                  : state.selected?.kind === "model"
                    ? `${selected.model?.provider ?? selected.modelId} · ${en ? "Available in this demo workspace; no requests in the selected period." : "此演示工作区中可用；所选周期没有请求。"}`
                    : `${projectName} · ${en ? `Last ${state.period} days` : `最近 ${state.period} 天`} · ${en ? "Demo usage" : "样例用量"} · UTC`}
              </DialogDescription>
              {state.selected?.kind === "budget" ? (
                <form
                  className={styles.budgetForm}
                  onSubmit={(event) => {
                    event.preventDefault()
                    setState((before) => saveUsageBudget(before, canWrite))
                  }}
                >
                  <div className={styles.monthly}>
                    <p>
                      {en
                        ? "September spend · all projects"
                        : "9 月费用 · 全部项目"}
                    </p>
                    <strong data-model-usage-monthly-cost>
                      {usageMoney(monthly?.costMicroUsd ?? null, locale)}{" "}
                      {en ? "of" : "/"}{" "}
                      {budget === null
                        ? en
                          ? "Not set"
                          : "未设置"
                        : usageMoney(budget, locale)}
                    </strong>
                    <p
                      data-model-usage-budget-status
                      className={
                        budgetStatus === "exceeded" ? styles.attention : ""
                      }
                    >
                      {statusCopy[budgetStatus]}
                    </p>
                  </div>
                  <Field
                    label={en ? "Monthly budget (USD)" : "月度预算 (USD)"}
                    error={
                      state.budgetError
                        ? en
                          ? "Enter a non-negative USD amount with at most six decimal places, or leave blank for no budget."
                          : "请输入最多六位小数的非负 USD 金额；留空表示未设置预算。"
                        : undefined
                    }
                  >
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min="0"
                        step="0.000001"
                        value={state.drafts[selected.modelId] ?? ""}
                        readOnly={!canWrite || locked}
                        onChange={(event) =>
                          setState((before) => ({
                            ...before,
                            drafts: {
                              ...before.drafts,
                              [selected.modelId]: event.target.value,
                            },
                            budgetError: false,
                          }))
                        }
                      />
                    )}
                  </Field>
                  <p className={styles.fixture}>
                    {en
                      ? "This demo stores a planning budget only. It does not change billing or enforce a live API limit. Blank means not set; zero is an explicit zero budget."
                      : "本演示仅保存规划预算，不改变账单或实际 API 限额。留空表示未设置，0 表示明确的零预算。"}
                  </p>
                  {!canWrite && (
                    <p className={styles.fixture}>
                      {en
                        ? "Read only · budget changes are unavailable."
                        : "只读 · 无法修改预算。"}
                    </p>
                  )}
                  {state.operation &&
                    state.operation.payload.modelId === selected.modelId &&
                    state.operation.status !== "confirmed" && (
                      <div role="status" className={styles.operation}>
                        <p>
                          {state.operation.operationId} ·{" "}
                          {state.operation.status}
                        </p>
                        <p>
                          {en ? "Original budget payload" : "原预算载荷"}:{" "}
                          {state.operation.payload.budgetMicroUsd === null
                            ? en
                              ? "Not set"
                              : "未设置"
                            : `${state.operation.payload.budgetMicroUsd} microUSD`}
                        </p>
                        {state.operation.status === "rejected" ? (
                          <p>
                            {en
                              ? "Fixture save was rejected. Confirmed budget and your input are unchanged."
                              : "样例保存被拒绝。已确认预算和输入保持不变。"}
                          </p>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setState(confirmUsageBudget)}
                          >
                            {state.operation.status === "unknown"
                              ? en
                                ? "Query operation result"
                                : "查询操作结果"
                              : en
                                ? "Complete fixture operation"
                                : "完成样例操作"}
                          </Button>
                        )}
                      </div>
                    )}
                  <details className={styles.fixtureControls}>
                    <summary>{en ? "Fixture controls" : "样例控制"}</summary>
                    <ApSelect
                      label={en ? "Save result" : "保存结果"}
                      value={state.result}
                      disabled={locked || !canWrite}
                      options={[
                        {
                          value: "confirmed",
                          label: en ? "Confirmed" : "已确认",
                        },
                        { value: "pending", label: en ? "Pending" : "待处理" },
                        { value: "rejected", label: en ? "Rejected" : "拒绝" },
                        { value: "unknown", label: en ? "Unknown" : "未知" },
                      ]}
                      onChange={(result) =>
                        setState((before) => ({
                          ...before,
                          result: result as typeof before.result,
                        }))
                      }
                    />
                  </details>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setState(closeUsageDetail)}
                    >
                      {en ? "Cancel" : "取消"}
                    </Button>
                    <Button type="submit" disabled={!canWrite || locked}>
                      {en ? "Save budget" : "保存预算"}
                    </Button>
                  </DialogFooter>
                </form>
              ) : (
                <>
                  <MetricSummary
                    className={styles.detailMetrics}
                    items={[
                      {
                        id: "requests",
                        label: en ? "Requests" : "请求",
                        value: usageNumber(
                          selected.totals.requests,
                          locale,
                          true,
                        ),
                      },
                      {
                        id: "spend",
                        label: en ? "Spend" : "费用",
                        value: usageMoney(selected.totals.costMicroUsd, locale),
                      },
                      {
                        id: "latency",
                        label: en ? "Median latency" : "延迟中位数",
                        value:
                          selected.totals.latencyMs === null
                            ? "—"
                            : `${usageNumber(selected.totals.latencyMs, locale)} ms`,
                      },
                    ]}
                  />
                  {selected.totals.requests ? (
                    <div className={styles.dailyTable}>
                      <Table>
                        <TableCaption className="sr-only">
                          {en
                            ? "Daily requests, failures, rate limits, and spend"
                            : "每日请求、失败、限流和费用"}
                        </TableCaption>
                        <TableHeader>
                          <TableRow>
                            {[
                              en ? "Date" : "日期",
                              en ? "Requests" : "请求",
                              en ? "Failed" : "失败",
                              en ? "Limited" : "限流",
                              en ? "Spend" : "费用",
                            ].map((label) => (
                              <TableHead key={label}>{label}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...selected.days].reverse().map((day) => (
                            <TableRow
                              key={day.date}
                              data-selected={state.selected?.date === day.date}
                            >
                              <TableCell>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setState((before) => ({
                                      ...before,
                                      selected: before.selected
                                        ? { ...before.selected, date: day.date }
                                        : null,
                                    }))
                                  }
                                >
                                  {usageDate(day.date, locale)}
                                </Button>
                              </TableCell>
                              <TableCell>
                                {usageNumber(day.requests, locale)}
                              </TableCell>
                              <TableCell>{day.failed}</TableCell>
                              <TableCell>{day.limited}</TableCell>
                              <TableCell>
                                {usageMoney(day.costMicroUsd, locale)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className={styles.emptyActivity}>
                      {en
                        ? `No requests were recorded for ${selected.model?.name ?? selected.modelId} in this period. Browse the catalog to compare capabilities before using this model.`
                        : `本周期未记录 ${selected.model?.name ?? selected.modelId} 的请求。使用前可浏览目录比较模型能力。`}
                    </p>
                  )}
                  {state.selected?.date && (
                    <section
                      className={styles.dayDetails}
                      aria-label={en ? "Selected day usage" : "所选日期用量"}
                    >
                      <h3>{usageDate(state.selected.date, locale)} · UTC</h3>
                      {(() => {
                        const day = selected.days.find(
                          (day) => day.date === state.selected?.date,
                        )
                        return day ? (
                          <>
                            <p>
                              {en ? "Input" : "输入"}:{" "}
                              {usageNumber(day.inputTokens, locale)} ·{" "}
                              {en ? "Output" : "输出"}:{" "}
                              {usageNumber(day.outputTokens, locale)} ·{" "}
                              {en
                                ? "Cached (included in input)"
                                : "缓存（包含在输入）"}
                              : {usageNumber(day.cachedTokens, locale)}
                            </p>
                            <p>
                              {day.requestIds.length
                                ? day.requestIds.join(" · ")
                                : en
                                  ? "No requests recorded."
                                  : "没有请求记录。"}
                            </p>
                          </>
                        ) : null
                      })()}
                    </section>
                  )}
                  {selected.totals.missingUsage > 0 && (
                    <p className={styles.fixture}>
                      {en
                        ? "Missing usage fields remain unknown, not zero. Unknown outcomes are not successes."
                        : "缺失用量保持未知，不补成零。未知结果不视为成功。"}
                    </p>
                  )}
                  <DialogFooter>
                    {selected.totals.requests === 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openDetail(selected.modelId, "budget")}
                      >
                        {en ? "Budget" : "预算"}
                      </Button>
                    )}
                    <a
                      className={styles.catalogLink}
                      href="/showcase/model-catalog"
                    >
                      {en ? "Model catalog" : "模型目录"}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </DialogFooter>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
