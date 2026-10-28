// Usage model dialog adapted from t3code UsageModelDialog.tsx and usageBreakdown.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageBucket } from "@agent-workspace/contracts/usage";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "react-router-dom";
import { UsageShareBar, UsageTrendChart } from "./UsageCharts";
import { modelDetailData } from "./usage-model-detail-data";
import "./usage-model-detail.css";

const money = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const count = (value: number) => value.toLocaleString();
const ink = (percent: number) => `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

export function UsageModelDetail({ model, buckets, metric, onClose }: {
  model: string | null;
  buckets: UsageBucket[];
  metric: "cost" | "tokens";
  onClose: () => void;
}) {
  const { rows, totals, unknown, entirelyUnpriced, mixed, cacheHit, perMillion } = modelDetailData(model, buckets);
  const tokenSegments = [
    { label: "未缓存输入", value: totals.input, color: ink(60) },
    { label: "缓存读取", value: totals.cacheRead, color: ink(30) },
    { label: "缓存写入", value: totals.cacheWrite, color: ink(72) },
    { label: "输出", value: totals.output, color: ink(100) },
  ];
  const costSegments = [
    { label: "输入", value: totals.costInput, color: ink(60) },
    { label: "缓存读取", value: totals.costRead, color: ink(30) },
    { label: "缓存写入", value: totals.costWrite, color: ink(72) },
    { label: "输出", value: totals.costOutput, color: ink(100) },
    { label: "其他未拆分", value: totals.costOther, color: ink(44) },
  ];
  const speedSegments = [
    { label: "Standard", value: Math.max(0, totals.cost - totals.fast - totals.ultrafast), color: ink(34) },
    { label: "Fast", value: totals.fast, color: ink(66) },
    { label: "Ultrafast", value: totals.ultrafast, color: ink(100) },
  ];
  return <Dialog open={model !== null} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="usage-model-detail">
      <DialogHeader>
        <DialogTitle className="usage-model-detail-title">{model ?? "模型明细"}</DialogTitle>
        <DialogDescription>所选时间内的使用明细；成本为 API 等价估算，不是账单。</DialogDescription>
      </DialogHeader>
      {model !== null && <div className="usage-model-detail-body">
        {rows.length === 0 ? <p>所选时间内没有此模型的 usage 记录。</p> : <>
          <div className="usage-model-detail-stats">
            <div><span>成本</span><strong>{entirelyUnpriced ? "未定价" : money(totals.cost)}{unknown && !entirelyUnpriced ? " + 未定价" : ""}</strong></div>
            <div><span>Tokens</span><strong>{count(totals.tokens)}</strong></div>
            <div><span>每百万已定价 tokens 实际成本</span><strong>{perMillion === null ? "不可用" : money(perMillion)}</strong></div>
            <div><span>缓存命中率</span><strong>{cacheHit === null ? "不可用" : `${(cacheHit * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</strong></div>
          </div>
          {mixed && <p className="usage-model-detail-note">部分时间桶同时包含已定价与未定价记录，无法区分已定价 tokens，因此实际每百万成本不可用。</p>}
          {unknown && <p className="usage-model-detail-note">{totals.unpriced > 0 ? `${count(totals.unpriced)} 条记录未定价；` : "部分成本未知；"}已知成本不含这些记录。</p>}
          <section aria-label="模型趋势">
            <h3>模型趋势</h3>
            {entirelyUnpriced && metric === "cost" && <p className="usage-model-detail-note">成本未知，显示 tokens 趋势。</p>}
            <UsageTrendChart buckets={rows} metric={entirelyUnpriced ? "tokens" : metric} />
          </section>
          <div className="usage-model-detail-breakdowns">
            {!entirelyUnpriced && <UsageShareBar label={unknown ? "已知成本分类" : "成本分类"} segments={costSegments} format={money} />}
            <UsageShareBar label="Tokens 分类" segments={tokenSegments} format={count} />
            {(totals.fast > 0 || totals.ultrafast > 0) && <div><UsageShareBar label={unknown ? "已知成本按速度" : "成本按速度"} segments={speedSegments} format={money} /><p className="usage-model-detail-note">速度溢价 {money(totals.premium)}</p></div>}
          </div>
          <p className="usage-model-detail-note">缓存写入计为未命中；reasoning 是输出的子集（{count(totals.reasoning)} tokens），不重复计入总量。</p>
        </>}
      </div>}
          <p><Link to="/settings/usage">设置模型价格</Link></p>
    </DialogContent>
  </Dialog>;
}
