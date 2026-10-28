// Usage chart and share bar adapted from t3code UsageProviderChart.tsx and UsageShareBar.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useMemo, useState } from "react";
import type { UsageBucket } from "@agent-workspace/contracts/usage";
import { tokenTotal } from "./page-data";
import "./usage-charts.css";

type Metric = "cost" | "tokens";
type ChartValue = { value: number; records: number; unpriced: number; unknown: boolean; known: boolean };
type Series = { key: string; label: string; color: string };
type Column = { time: string; values: Map<string, ChartValue> };

const colors = ["#3b82f6", "#a855f7", "#e8793e", "#0d9488", "#db4b78", "#7c9b28", "#ca8a04", "#6478d4", "#b65fba", "#0891b2"];

function colorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return colors[(hash >>> 0) % colors.length]!;
}

function buildChart(buckets: readonly UsageBucket[], metric: Metric): { series: Series[]; columns: Column[] } {
  const series = new Map<string, Series>();
  const columns = new Map<string, Column>();
  for (const bucket of buckets) {
    const key = `${bucket.provider}\u0000${bucket.model}`;
    if (!series.has(key)) series.set(key, { key, label: `${bucket.provider} / ${bucket.model}`, color: colorFor(key) });
    const time = bucket.hourStart ?? bucket.day;
    let column = columns.get(time);
    if (!column) { column = { time, values: new Map() }; columns.set(time, column); }
    let value = column.values.get(key);
    if (!value) { value = { value: 0, records: 0, unpriced: 0, unknown: false, known: false }; column.values.set(key, value); }
    value.value += metric === "tokens" ? tokenTotal(bucket) : bucket.costUsd;
    value.records += bucket.records;
    value.unpriced += bucket.unpricedRecords;
    value.unknown ||= bucket.unpricedRecords > 0 || bucket.costSource === "unpriced";
    value.known ||= bucket.costUsd > 0 || (bucket.costSource !== "unpriced" && (bucket.records === 0 || bucket.unpricedRecords < bucket.records));
  }
  return { series: [...series.values()].sort((a, b) => a.label.localeCompare(b.label)), columns: [...columns.values()].sort((a, b) => a.time.localeCompare(b.time)) };
}

function formatValue(value: number, metric: Metric): string {
  if (metric === "tokens") return `${value.toLocaleString()} tokens`;
  if (value > 0 && value < 0.00000001) return `$${value.toExponential(2)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function describeValue(value: ChartValue, metric: Metric): string {
  if (metric === "tokens") return formatValue(value.value, metric);
  if (!value.unknown) return formatValue(value.value, metric);
  const unknown = value.unpriced > 0 ? `未定价 ${value.unpriced.toLocaleString()} 条` : "未定价";
  if (!value.known) return unknown;
  return `${formatValue(value.value, metric)}（已知） + ${unknown}`;
}
function combineValues(values: readonly ChartValue[]): ChartValue {
  return values.reduce<ChartValue>((sum, value) => ({ value: sum.value + value.value, records: sum.records + value.records, unpriced: sum.unpriced + value.unpriced, unknown: sum.unknown || value.unknown, known: sum.known || value.known }), { value: 0, records: 0, unpriced: 0, unknown: false, known: false });
}

export function UsageTrendChart({ buckets, metric }: { buckets: UsageBucket[]; metric: Metric }) {
  const { series, columns } = useMemo(() => buildChart(buckets, metric), [buckets, metric]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = focused ?? hovered;
  const visible = series.filter(item => !hidden.has(item.key));
  const totals = columns.map(column => combineValues(visible.flatMap(item => {
    const value = column.values.get(item.key);
    return value ? [value] : [];
  })));
  const peak = Math.max(0, ...totals.map(total => total.value));
  const activeColumn = columns.find(column => column.time === active);
  const activeValues = activeColumn ? visible.flatMap(item => {
    const value = activeColumn.values.get(item.key);
    return value ? [{ item, value }] : [];
  }) : [];
  const toggle = (key: string) => setHidden(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (columns.length === 0) return <p className="usage-chart-empty">暂无趋势数据。</p>;
  return <div className="usage-chart">
    <p className="usage-chart-note">按记录的时间段显示；未出现的时间段不会补零。{metric === "cost" && "柱高仅反映已知成本，未定价记录以 * 标记；成本不是账单。"}</p>
    <div className="usage-chart-legend" aria-label="显示或隐藏趋势系列">
      {series.map(item => <button key={item.key} type="button" className="usage-chart-series" aria-pressed={!hidden.has(item.key)} onClick={() => toggle(item.key)}>
        <span className="usage-chart-swatch" style={{ backgroundColor: item.color }} aria-hidden="true" />{item.label}
      </button>)}
    </div>
    <div className="usage-chart-scroll">
      <div className="usage-chart-plot" style={{ minWidth: `${Math.max(280, columns.length * 32)}px` }}>
        <div className="usage-chart-scale" aria-hidden="true"><span>{formatValue(peak, metric)}</span><span>0</span></div>
        <div className="usage-chart-columns">
          {columns.map((column, index) => {
            const total = totals[index]!;
            const entries = visible.flatMap(item => {
              const value = column.values.get(item.key);
              return value ? [{ item, value }] : [];
            });
            const description = entries.length ? `${column.time}: ${entries.map(({ item, value }) => `${item.label}: ${describeValue(value, metric)}`).join("; ")}. 合计: ${describeValue(total, metric)}` : `${column.time}: 所选系列无记录`;
            return <div className="usage-chart-column" key={column.time}>
              <button type="button" className="usage-chart-column-button" aria-label={description} onMouseEnter={() => setHovered(column.time)} onMouseLeave={() => setHovered(null)} onFocus={() => setFocused(column.time)} onBlur={() => setFocused(null)}>
                {metric === "cost" && total.unknown && <span className="usage-chart-unknown" aria-hidden="true">*</span>}
                <span className="usage-chart-stack" aria-hidden="true">{entries.map(({ item, value }) => value.value > 0 && <span key={item.key} className="usage-chart-band" style={{ height: `${peak ? value.value / peak * 100 : 0}%`, backgroundColor: item.color }} />)}</span>
              </button>
              <span className="usage-chart-time" aria-hidden="true">{index === 0 || (columns.length >= 16 && index === Math.floor(columns.length / 2)) || index === columns.length - 1 ? column.time : ""}</span>
            </div>;
          })}
        </div>
      </div>
    </div>
    <div className="usage-chart-detail" aria-hidden="true">
      {activeColumn ? <><strong>{activeColumn.time}</strong>{activeValues.length ? <><ul>{activeValues.map(({ item, value }) => <li key={item.key}><span><span className="usage-chart-swatch" style={{ backgroundColor: item.color }} />{item.label}</span><span>{describeValue(value, metric)}</span></li>)}</ul><strong>合计：{describeValue(combineValues(activeValues.map(entry => entry.value)), metric)}</strong></> : <span>所选系列无记录</span>}</> : <span>悬停或聚焦柱形查看详情。</span>}
    </div>
    <details className="usage-chart-table-details"><summary>查看趋势数据表</summary><div className="usage-chart-table-scroll"><table><caption>按时间和 provider / 模型列出的{metric === "cost" ? "已知成本及未定价记录" : "tokens"}；破折号表示无记录。</caption><thead><tr><th scope="col">时间</th>{series.map(item => <th scope="col" key={item.key}>{item.label}</th>)}</tr></thead><tbody>{columns.map(column => <tr key={column.time}><th scope="row">{column.time}</th>{series.map(item => { const value = column.values.get(item.key); return <td key={item.key}>{value ? describeValue(value, metric) : "—"}</td>; })}</tr>)}</tbody></table></div></details>
  </div>;
}

type ShareSegment = { label: string; value: number; color: string };
export function UsageShareBar({ label, segments, format }: { label: string; segments: ShareSegment[]; format: (v: number) => string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const visible = segments.map((segment, index) => ({ ...segment, index })).filter(segment => Number.isFinite(segment.value) && segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) return null;
  const describe = (segment: ShareSegment) => `${segment.label} · ${format(segment.value)} · ${(segment.value / total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  const active = visible.find(segment => segment.index === (focused ?? hovered));
  return <section className="usage-share" aria-label={label}>
    <h3 className="usage-share-heading">{label}</h3>
    <div className="usage-share-bar">{visible.map(segment => <button type="button" key={segment.index} className="usage-share-segment" style={{ flexGrow: segment.value, backgroundColor: segment.color }} aria-label={describe(segment)} title={describe(segment)} onMouseEnter={() => setHovered(segment.index)} onMouseLeave={() => setHovered(null)} onFocus={() => setFocused(segment.index)} onBlur={() => setFocused(null)} />)}</div>
    <div className="usage-share-detail" aria-hidden="true">{active ? describe(active) : "悬停或聚焦分段查看占比。"}</div>
    <ul className="usage-share-legend">{visible.map(segment => <li key={segment.index}><span className="usage-chart-swatch" style={{ backgroundColor: segment.color }} aria-hidden="true" /><span>{describe(segment)}</span></li>)}</ul>
  </section>;
}
