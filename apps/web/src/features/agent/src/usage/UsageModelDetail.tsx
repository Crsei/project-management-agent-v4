// Usage model dialog adapted from t3code UsageModelDialog.tsx and usageBreakdown.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageProviderKind, UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Link } from "react-router-dom";
import { useAgentText } from "../i18n";
import { UsageShareBar, UsageTrendChart } from "./UsageCharts";
import { modelDetailData } from "./usage-model-detail-data";
import { formatUsageCost, formatUsageCount, formatUsageExact, formatUsageMoney, usageInk } from "./usage-display";
import { providerPresentation, UsageProviderIcon } from "./usage-presentation";
import { USAGE_CONFIG_PATH } from "./navigation";
import type { UsageMetric, UsageModelView } from "./usage-view-model";
import "./usage-model-detail.css";

type DetailView = {
  model: UsageModelView;
  metric: UsageMetric;
  input: UsageSummaryInput;
  partial: boolean;
  refreshingProviders: readonly UsageProviderKind[];
};

function UsageModelDetailBody({ model, metric, input, partial, refreshingProviders }: DetailView) {
  const t = useAgentText();
  const { rows, totals, unknown, entirelyUnpriced, mixed, cacheHit, perMillion } = modelDetailData(model);
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
  return <div className="usage-model-detail-body">
    {rows.length === 0 ? <p>{t("所选时间内没有此模型的 Usage 记录。", "No Usage records for this model in the selected time range.")}</p> : <>
      <dl className="usage-model-detail-stats">
        <div><dt>{t("成本", "Cost")}</dt><dd title={t(`已知成本 $${formatUsageExact(totals.cost)}`, `Known cost $${formatUsageExact(totals.cost)}`)}>{formatUsageCost(totals, t)}</dd></div>
        <div><dt>Tokens</dt><dd title={formatUsageExact(totals.tokens)}>{formatUsageCount(totals.tokens)}</dd></div>
        <div><dt>{t("每百万已定价 tokens 实际成本", "Realized cost per million priced tokens")}</dt><dd title={perMillion === null ? t("无法从当前计数确定", "Cannot be determined from the current counts") : `$${formatUsageExact(perMillion)}`}>{perMillion === null ? t("不可用", "Unavailable") : formatUsageMoney(perMillion)}</dd></div>
        <div><dt>{t("缓存命中率", "Cache hit rate")}</dt><dd>{cacheHit === null ? t("不可用", "Unavailable") : `${(cacheHit * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</dd></div>
      </dl>
      {partial && <p role="status" className="usage-model-detail-note">{t("当前来源数据不完整；未完成扫描的时段不代表 0。", "Current source data is incomplete; periods not yet scanned do not mean 0.")}</p>}
      {mixed && <p className="usage-model-detail-note">{t("部分时间桶同时包含已定价与未定价记录，无法区分已定价 tokens，因此实际每百万成本不可用。", "Some time buckets contain both priced and unpriced records, so priced tokens cannot be isolated and the realized cost per million is unavailable.")}</p>}
      {unknown && <p className="usage-model-detail-note">{totals.unpriced > 0 ? t(`${formatUsageExact(totals.unpriced)} 条记录未定价；`, `${formatUsageExact(totals.unpriced)} records are unpriced; `) : t("部分成本未知；", "Some costs are unknown; ")}{t("已知成本不含这些记录。", "known cost excludes these records.")}</p>}
      <section aria-label={t("模型趋势", "Model trend")}>
        <h3>{input.resolution === "hour" ? t("每小时", "Hourly") : t("每日", "Daily")}{t("模型趋势", " model trend")}</h3>
        {entirelyUnpriced && metric === "cost" && <p className="usage-model-detail-note">{t("成本未知，显示 Tokens 趋势。", "Cost is unknown; showing the tokens trend.")}</p>}
        <UsageTrendChart buckets={rows} metric={entirelyUnpriced ? "tokens" : metric} input={input} partial={partial} refreshingProviders={refreshingProviders.filter(provider => provider === model.provider)} />
      </section>
      <div className="usage-model-detail-breakdowns">
        {!entirelyUnpriced && <UsageShareBar label={unknown ? t("已知成本分类", "Known cost categories") : t("成本分类", "Cost categories")} segments={costSegments} format={formatUsageMoney} />}
        <UsageShareBar label={t("Tokens 分类", "Token categories")} segments={tokenSegments} format={formatUsageCount} />
        {(totals.fast > 0 || totals.ultrafast > 0) && <UsageShareBar label={unknown ? t("已知成本按速度", "Known cost by speed") : t("成本按速度", "Cost by speed")} format={formatUsageMoney} aside={<span title={t("溢价已包含在总成本中，不重复相加。", "The premium is already included in total cost and is not added again.")}>Premium {formatUsageMoney(totals.premium)}</span>} segments={[
          { label: "Standard", value: Math.max(0, totals.cost - totals.fast - totals.ultrafast), color: usageInk(34) },
          { label: "Fast", value: totals.fast, color: usageInk(66) },
          { label: "Ultrafast", value: totals.ultrafast, color: usageInk(100) },
        ]} />}
      </div>
      <p className="usage-model-detail-note">{t("缓存写入计为未命中；reasoning 是输出的子集（", "Cache writes count as misses; reasoning is a subset of output (")}{formatUsageExact(totals.reasoning)} tokens{t("），不重复计入总量。", ") and is not double-counted in totals.")}</p>
    </>}
  </div>;
}

export function UsageModelDetail({ model, onClose, ...view }: Omit<DetailView, "model"> & { model: UsageModelView | null; onClose: () => void }) {
  const t = useAgentText();
  return <Dialog open={model !== null} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="usage-model-detail">
      <DialogHeader>
        <DialogTitle className="usage-model-detail-title">{model ? <><UsageProviderIcon provider={model.provider} size={20} /><span>{model.model}<small>{providerPresentation(model.provider).label}</small></span></> : t("模型明细", "Model details")}</DialogTitle>
        <DialogDescription>{t("当前筛选时间内的使用明细；成本为 API 等价估算，不是账单。", "Usage details for the current filtered time range; cost is an API-equivalent estimate, not a bill.")}</DialogDescription>
      </DialogHeader>
      {model && <UsageModelDetailBody model={model} {...view} />}
      <p><Link to={USAGE_CONFIG_PATH}>{t("设置模型价格", "Set model pricing")}</Link></p>
    </DialogContent>
  </Dialog>;
}
