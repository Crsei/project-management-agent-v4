// Usage overview adapted from t3code UsagePage.tsx and usageBreakdown.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useMemo, useState } from "react";
import type { UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { useAgentText, type AgentText } from "../i18n";
import { UsageShareBar, UsageTrendChart } from "./UsageCharts";
import { UsageModelDetail } from "./UsageModelDetail";
import { providerPresentation, UsageProviderIcon } from "./usage-presentation";
import {
  formatUsageCost, formatUsageCount, formatUsageExact, formatUsageMoney, formatUsageShare,
  isUsageUnpriced, usageInk,
} from "./usage-display";
import type { UsageTotals } from "./page-data";
import type { UsageMetric, UsageViewModel } from "./usage-view-model";

function exactCost(totals: UsageTotals, t: AgentText) {
  return isUsageUnpriced(totals) ? t("未定价", "Unpriced") : `$${formatUsageExact(totals.cost)}${totals.unpriced > 0 ? t("；不含未定价记录", "; excludes unpriced records") : ""}`;
}

function MetricValue({ label, value, exact }: { label: string; value: string; exact: string }) {
  return <div><dt>{label}</dt><dd title={exact}>{value}</dd></div>;
}

export function UsageOverview({ view, input, metric }: { view: UsageViewModel; input: UsageSummaryInput; metric: UsageMetric }) {
  const t = useAgentText();
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [modelKey, setModelKey] = useState<string | null>(null);
  const models = useMemo(() => [...view.models].sort((a, b) => {
    if (metric === "cost" && (a.costShare === null) !== (b.costShare === null)) return a.costShare === null ? 1 : -1;
    return (metric === "cost" ? b.totals.cost - a.totals.cost : b.totals.tokens - a.totals.tokens)
      || a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider);
  }), [view.models, metric]);
  const providers = useMemo(() => [...view.providers].sort((a, b) => {
    if (metric === "cost" && (a.costShare === null) !== (b.costShare === null)) return a.costShare === null ? 1 : -1;
    return (metric === "cost" ? b.totals.cost - a.totals.cost : b.totals.tokens - a.totals.tokens) || a.provider.localeCompare(b.provider);
  }), [view.providers, metric]);
  const peak = models.reduce((max, model) => Math.max(max, metric === "cost" ? model.totals.cost : model.totals.tokens), 0);
  const selected = view.models.find(model => model.key === modelKey) ?? null;
  const totals = view.totals;
  const hourly = input.resolution === "hour";
  const tokenSegments = [
    { label: t("未缓存输入", "Uncached input"), value: totals.input, color: usageInk(60) },
    { label: t("缓存读取", "Cache read"), value: totals.cacheRead, color: usageInk(30) },
    { label: t("缓存写入", "Cache write"), value: totals.cacheWrite, color: usageInk(74) },
    { label: t("输出", "Output"), value: totals.output, color: usageInk(100) },
  ];
  const costSegments = [
    { label: t("输入", "Input"), value: totals.costInput, color: usageInk(60) },
    { label: t("缓存读取", "Cache read"), value: totals.costRead, color: usageInk(30) },
    { label: t("缓存写入", "Cache write"), value: totals.costWrite, color: usageInk(74) },
    { label: t("输出", "Output"), value: totals.costOutput, color: usageInk(100) },
    { label: t("其他未拆分", "Other unsplit"), value: totals.costOther, color: usageInk(44) },
  ];
  const periodLabel = (period: UsageViewModel["periods"][number]) => period.hourStart
    ? new Date(period.hourStart).toLocaleString(undefined, { timeZone: input.timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    : new Date(`${period.day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
  const periodValue = (value: UsageTotals | undefined) => {
    if (!value || value.records === 0) return view.partial ? "—" : metric === "cost" ? formatUsageMoney(0) : "0";
    return metric === "cost" ? formatUsageCost(value, t) : formatUsageCount(value.tokens);
  };

  return <div className="usage-overview">
    {view.partial && <p className="usage-status" role="status">{t("当前为部分结果；缺失或尚未完成扫描的时段不代表 0。", "These are partial results; missing periods or periods not yet scanned do not mean 0.")}{view.refreshingProviders.length > 0 && t(` 正在刷新：${view.refreshingProviders.map(provider => providerPresentation(provider).label).join("、")}。`, ` Refreshing: ${view.refreshingProviders.map(provider => providerPresentation(provider).label).join(", ")}.`)}</p>}
    <section className="usage-summary-layout" aria-label={t("Usage 概览", "Usage overview")}>
      <div className="usage-summary-column">
        <div className="usage-main-total">
          <strong title={metric === "cost" ? exactCost(totals, t) : formatUsageExact(totals.tokens)}>{metric === "cost" ? formatUsageCost(totals, t) : formatUsageCount(totals.tokens)}</strong>
          <p className="usage-muted">{formatUsageExact(view.sessions)} {t("个会话", "sessions")}{metric === "cost" && <span title={t("API 等价成本估算，不是账单；未定价记录不计入已知成本。", "API-equivalent cost estimate, not a bill; unpriced records are excluded from known cost.")}> · {t("API 等价估算", "API-equivalent estimate")} ⓘ</span>}</p>
        </div>
        <ul className="usage-provider-summary">
          {providers.map(row => {
            const presentation = providerPresentation(row.provider);
            const share = metric === "cost" ? row.costShare : row.tokenShare;
            const pending = view.refreshingProviders.includes(row.provider);
            const awaiting = pending && row.totals.records === 0;
            return <li key={row.provider} className={pending ? "usage-provider-pending" : undefined}>
              <div className="usage-provider-summary-line">
                <span className="usage-provider-identity"><span className="usage-provider-dot" style={{ backgroundColor: presentation.color }} aria-hidden="true" /><UsageProviderIcon provider={row.provider} size={17} /><span>{presentation.label}</span><small>{formatUsageExact(row.sessions)} {t("个会话", "sessions")}</small></span>
                <strong title={metric === "cost" ? exactCost(row.totals, t) : formatUsageExact(row.totals.tokens)}>{awaiting ? t("读取中…", "Loading…") : metric === "cost" ? formatUsageCost(row.totals, t) : formatUsageCount(row.totals.tokens)}</strong>
              </div>
              <p className="usage-muted" title={share === null ? t("未定价成本无法计算占比", "Share cannot be computed for unpriced cost") : `${formatUsageExact(share * 100)}%`}>{awaiting ? t("等待来源结果", "Waiting for source results") : <>{share === null ? t("成本占比未知", "Cost share unknown") : `${formatUsageShare(share)} ${metric === "cost" ? (totals.unpriced > 0 ? t("已知成本", "known cost") : t("成本", "cost")) : "Tokens"}`} · {metric === "cost" ? `${formatUsageCount(row.totals.tokens)} tokens` : formatUsageCost(row.totals, t)}</>}</p>
            </li>;
          })}
        </ul>
      </div>
      <div className="usage-trend-column">
        <h2>{hourly ? t("每小时", "Hourly ") : t("每日", "Daily ")}{metric === "cost" ? t("成本", "cost") : t("处理 Tokens", "tokens processed")}</h2>
        <UsageTrendChart buckets={view.buckets} metric={metric} input={input} partial={view.partial} refreshingProviders={view.refreshingProviders} />
      </div>
    </section>

    <section className="usage-totals-section" aria-labelledby="usage-totals-title">
      <h2 id="usage-totals-title">Totals</h2>
      <dl className="usage-totals-grid">
        <MetricValue label={t("处理 Tokens", "Tokens processed")} value={formatUsageCount(totals.tokens)} exact={formatUsageExact(totals.tokens)} />
        <MetricValue label={t("缓存输入", "Cached input")} value={formatUsageCount(totals.cacheRead)} exact={formatUsageExact(totals.cacheRead)} />
        <MetricValue label={t("未缓存输入", "Uncached input")} value={formatUsageCount(totals.input)} exact={formatUsageExact(totals.input)} />
        <MetricValue label={t("输出", "Output")} value={formatUsageCount(totals.output)} exact={formatUsageExact(totals.output)} />
        <MetricValue label={t("缓存节省估算", "Estimated cache savings")} value={isUsageUnpriced(totals) ? t("不可用", "Unavailable") : formatUsageMoney(totals.savings)} exact={isUsageUnpriced(totals) ? t("没有已定价记录，无法估算缓存节省", "No priced records; cache savings cannot be estimated") : `$${formatUsageExact(totals.savings)}${totals.unpriced > 0 ? t("；仅含已知价格", "; known prices only") : ""}`} />
      </dl>
    </section>

    {(totals.tokens > 0 || totals.cost > 0) && <section className="usage-type-layout" aria-label={t("使用分类", "Usage categories")}>
      {metric === "tokens" ? <UsageShareBar label={t("Tokens 分类", "Token categories")} segments={tokenSegments} format={formatUsageCount} /> : <>
        {!isUsageUnpriced(totals) && <UsageShareBar label={totals.unpriced > 0 ? t("已知成本分类", "Known cost categories") : t("成本分类", "Cost categories")} segments={costSegments} format={formatUsageMoney} />}
        {(totals.fast > 0 || totals.ultrafast > 0) && <UsageShareBar label={t("成本按速度", "Cost by speed")} format={formatUsageMoney} aside={<span title={t(`速度溢价 $${formatUsageExact(totals.premium)}，已包含在总成本中，不重复相加。`, `Speed premium $${formatUsageExact(totals.premium)}, already included in total cost and not added again.`)}>Premium <strong>{formatUsageMoney(totals.premium)}</strong></span>} segments={[
          { label: "Standard", value: Math.max(0, totals.cost - totals.fast - totals.ultrafast), color: usageInk(34) },
          { label: "Fast", value: totals.fast, color: usageInk(66) },
          { label: "Ultrafast", value: totals.ultrafast, color: usageInk(100) },
        ]} />}
      </>}
    </section>}

    <section className="usage-breakdown" aria-labelledby="usage-breakdown-title">
      <div className="usage-section-heading"><h2 id="usage-breakdown-title">Breakdown</h2><div className="usage-segmented" role="group" aria-label={t("明细分组", "Breakdown grouping")}>
        <button type="button" aria-pressed={breakdown === "model"} onClick={() => setBreakdown("model")}>Model</button>
        <button type="button" aria-pressed={breakdown === "time"} onClick={() => setBreakdown("time")}>{hourly ? "Hour" : "Day"}</button>
      </div></div>
      {breakdown === "model" ? <div className="usage-table-wrap" role="region" aria-label={t("模型使用明细", "Model usage breakdown")} tabIndex={0}>
        <table className="usage-breakdown-table usage-model-table"><thead><tr><th scope="col">#</th><th scope="col">Model</th><th scope="col">Cost</th><th scope="col">Share</th><th scope="col">Tokens</th></tr></thead>
          <tbody>{models.length === 0 ? <tr><td colSpan={5} className="usage-empty">{view.partial ? t("尚无可用记录，来源未完成。", "No records available yet; sources have not finished.") : t("所选范围没有使用记录。", "No usage records in the selected range.")}</td></tr> : models.map((model, index) => {
            const value = metric === "cost" ? model.totals.cost : model.totals.tokens;
            const share = metric === "cost" ? model.costShare : model.tokenShare;
            return <tr key={model.key}>
              <td>{index + 1}</td>
              <th scope="row"><button type="button" className="usage-model-button" onClick={() => setModelKey(model.key)} title={`${providerPresentation(model.provider).label} / ${model.model}`}><UsageProviderIcon provider={model.provider} size={15} /><span>{model.model}</span></button>
                {value > 0 && peak > 0 && <div className="usage-model-row-bar" aria-hidden="true"><span style={{ width: `${value / peak * 100}%`, backgroundColor: providerPresentation(model.provider).color }} /></div>}
              </th>
              <td className="usage-cost-cell" title={exactCost(model.totals, t)}>{formatUsageCost(model.totals, t)}</td>
              <td title={share === null ? t("成本未知，无法计算占比", "Cost unknown; share cannot be computed") : `${formatUsageExact(share * 100)}%${metric === "cost" && totals.unpriced > 0 ? t(" 已知成本占比", " known cost share") : ""}`}>{formatUsageShare(share)}</td>
              <td title={formatUsageExact(model.totals.tokens)}>{formatUsageCount(model.totals.tokens)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <div className="usage-table-wrap" role="region" aria-label={t("按时间使用明细", "Usage breakdown by time")} tabIndex={0}>
        <table className="usage-breakdown-table usage-time-table"><thead><tr><th scope="col">{hourly ? "Hour" : "Day"}</th>{providers.map(row => <th scope="col" key={row.provider}><span className="usage-time-provider"><UsageProviderIcon provider={row.provider} size={14} />{providerPresentation(row.provider).label}</span></th>)}<th scope="col">Total {metric === "cost" ? "cost" : "tokens"}</th><th scope="col">Tokens</th></tr></thead>
          <tbody>{view.periods.length === 0 ? <tr><td colSpan={view.providers.length + 3} className="usage-empty">{view.partial ? t("时段数据尚不完整。", "Period data is not complete yet.") : t("所选范围没有使用记录。", "No usage records in the selected range.")}</td></tr> : [...view.periods].reverse().map(period => <tr key={period.key}>
            <th scope="row">{periodLabel(period)}</th>
            {providers.map(row => { const value = period.byProvider.get(row.provider); return <td key={row.provider} title={value ? metric === "cost" ? exactCost(value, t) : formatUsageExact(value.tokens) : view.partial ? t("该时段尚未确认完整", "This period is not yet confirmed complete") : "0"}>{periodValue(value)}</td>; })}
            <td className="usage-cost-cell" title={metric === "cost" ? exactCost(period.totals, t) : formatUsageExact(period.totals.tokens)}>{periodValue(period.totals)}</td>
            <td title={formatUsageExact(period.totals.tokens)}>{view.partial && period.totals.records === 0 ? "—" : formatUsageCount(period.totals.tokens)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p className="usage-footnote">{metric === "cost" ? t("Share 按已知成本计算；未定价不是免费。", "Share uses known cost; unpriced is not free.") : t("Share 按全部 Tokens 计算。", "Share uses all tokens.")} {t("模型细条相对本表最大值；reasoning 已计入输出，不重复相加。", "Model bars are relative to this table's maximum; reasoning is included in output and not added again.")}{totals.cacheWrite > 0 && t(` 缓存写入 ${formatUsageCount(totals.cacheWrite)} tokens 单独计入处理总量。`, ` Cache write of ${formatUsageCount(totals.cacheWrite)} tokens is counted separately in tokens processed.`)}</p>
    </section>
    <UsageModelDetail model={selected} metric={metric} input={input} partial={view.partial} refreshingProviders={view.refreshingProviders} onClose={() => setModelKey(null)} />
  </div>;
}
