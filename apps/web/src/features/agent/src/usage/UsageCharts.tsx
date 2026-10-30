// Usage chart and share bar adapted from t3code UsageProviderChart.tsx and UsageShareBar.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { UsageBucket, UsageProviderKind, UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { useAgentText, type AgentText } from "../i18n";
import { buildUsageChart, combineChartValues, type ChartMetric, type UsageChartValue } from "./usage-chart-data";
import { curvePath, knownPointRuns, niceScale } from "./usage-chart-math";
import { providerPresentation, UsageProviderIcon } from "./usage-presentation";
import "./usage-charts.css";

const WIDTH = 960;
const HEIGHT = 260;
const TOP = 8;
const NO_REFRESHING: readonly UsageProviderKind[] = [];

function compact(value: number): string {
  const unit = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return `${(value / unit).toLocaleString(undefined, { maximumFractionDigits: unit === 1 ? 2 : 1 })}${unit === 1e9 ? "B" : unit === 1e6 ? "M" : unit === 1e3 ? "K" : ""}`;
}

function axisValue(value: number, metric: ChartMetric): string {
  if (value === 0) return "0";
  if (metric === "tokens") return compact(value);
  return `$${value >= 1000 ? compact(value) : value < .01 ? value.toLocaleString(undefined, { maximumSignificantDigits: 3 }) : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function exactValue(value: number, metric: ChartMetric): string {
  if (metric === "tokens") return `${value.toLocaleString()} tokens`;
  return `$${value > 0 && value < 1e-8 ? value.toString() : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 20 })}`;
}

function describeValue(value: UsageChartValue, metric: ChartMetric, t: AgentText): string {
  const unpriced = metric === "cost" && value.unknownCost ? t(`未定价${value.unpriced > 0 ? ` ${value.unpriced.toLocaleString()} 条` : ""}`, `unpriced${value.unpriced > 0 ? ` ${value.unpriced.toLocaleString()} records` : ""}`) : "";
  if (value.value === null) return `${unpriced || t("未知", "unknown")}${value.incomplete ? t("（数据未完整）", " (data incomplete)") : ""}`;
  return `${exactValue(value.value, metric)}${unpriced ? t(`（已知） + ${unpriced}`, ` (known) + ${unpriced}`) : ""}${value.incomplete ? t("（部分已观测）", " (partially observed)") : ""}`;
}

export function UsageTrendChart({ buckets, metric, input, partial = false, refreshingProviders = NO_REFRESHING }: {
  buckets: UsageBucket[];
  metric: ChartMetric;
  input?: UsageSummaryInput;
  partial?: boolean;
  refreshingProviders?: readonly UsageProviderKind[];
}) {
  const t = useAgentText();
  const data = useMemo(() => buildUsageChart(buckets, metric, input, partial, refreshingProviders), [buckets, metric, input, partial, refreshingProviders]);
  const { columns, providers, resolution } = data;
  const scale = useMemo(() => niceScale(data.peak), [data.peak]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const instructionsId = useId();
  const tooltipId = useId();
  const activeIndex = columns.findIndex(column => column.key === (hovered ?? focused));
  const activeColumn = columns[activeIndex];
  const timeZone = input?.timeZone ?? "UTC";
  const periodFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, resolution === "hour"
    ? { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { timeZone: "UTC", month: "short", day: "numeric" }), [resolution, timeZone]);
  const detailFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, { timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }), [timeZone]);
  const periodLabel = (key: string) => {
    const date = new Date(resolution === "hour" ? key : `${key}T12:00:00Z`);
    return Number.isFinite(date.getTime()) ? periodFormatter.format(date) : key;
  };
  const detailLabel = (key: string) => {
    if (resolution !== "hour") return key;
    const date = new Date(key);
    return Number.isFinite(date.getTime()) ? detailFormatter.format(date) : key;
  };
  const totalFor = (index: number): UsageChartValue => providers.length
    ? combineChartValues([...columns[index]!.values.values()])
    : { value: partial ? null : 0, records: 0, unpriced: 0, unknownCost: false, incomplete: partial };
  const describeColumn = (index: number) => {
    const column = columns[index];
    if (!column) return t("暂无趋势数据", "No trend data");
    return `${detailLabel(column.key)}${t("；", "; ")}${providers.map(provider => `${providerPresentation(provider).label}${t("：", ": ")}${describeValue(column.values.get(provider)!, metric, t)}`).join(t("；", "; "))}${t("；合计：", "; total: ")}${describeValue(totalFor(index), metric, t)}`;
  };
  const { paths, positionX, positionY } = useMemo(() => {
    const positionX = (index: number) => columns.length < 2 ? WIDTH / 2 : index * WIDTH / (columns.length - 1);
    const positionY = (value: number) => scale.max === 0 ? HEIGHT : HEIGHT - value / scale.max * (HEIGHT - TOP);
    const paths = providers.map(provider => {
      const values = columns.map(column => column.values.get(provider)!);
      const runs = knownPointRuns(values.map((value, index) => value.value === null ? null : { x: positionX(index), y: positionY(value.value) }));
      return {
        provider,
        color: providerPresentation(provider).color,
        incomplete: values.some(value => value.incomplete || (metric === "cost" && value.unknownCost)),
        total: values.reduce((sum, value) => sum + (value.value ?? 0), 0),
        runs: runs.map(points => ({ points, line: curvePath(points) })),
      };
    }).sort((a, b) => b.total - a.total);
    return { paths, positionX, positionY };
  }, [columns, providers, metric, scale.max]);
  const hourly = resolution === "hour";
  const title = t(`${hourly ? "每小时" : "每日"}${metric === "cost" ? "成本" : "处理 tokens"}（按 Provider）`, `${hourly ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "tokens processed"} (by provider)`);
  const incomplete = partial || refreshingProviders.length > 0;
  const unknownScale = scale.max === 0 && (incomplete || (metric === "cost" && data.unknownCost));
  const ticks = unknownScale ? [0, .25, .5, .75, 1] : scale.ticks;
  const tickY = (value: number) => unknownScale ? HEIGHT - value * (HEIGHT - TOP) : positionY(value);
  const labels = [...new Set([0, Math.floor(columns.length / 2), columns.length - 1])].filter(index => index >= 0 && index < columns.length);

  const pointAt = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || !columns.length) return;
    const index = Math.max(0, Math.min(columns.length - 1, Math.round((event.clientX - bounds.left) / bounds.width * (columns.length - 1))));
    const key = columns[index]!.key;
    if (event.pointerType === "touch") { setHovered(null); setFocused(key); } else setHovered(key);
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { setFocused(null); setHovered(null); event.preventDefault(); event.stopPropagation(); return; }
    const current = Math.max(0, activeIndex);
    let next: number;
    switch (event.key) {
      case "ArrowRight": case "ArrowUp": next = current + 1; break;
      case "ArrowLeft": case "ArrowDown": next = current - 1; break;
      case "Home": next = 0; break;
      case "End": next = columns.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setHovered(null);
    setFocused(columns[Math.max(0, Math.min(columns.length - 1, next))]?.key ?? null);
  };

  if (!columns.length) return <p className="usage-chart-empty">{incomplete ? t("趋势数据尚未完整。", "Trend data is not complete yet.") : t("暂无趋势数据。", "No trend data yet.")}</p>;
  return <div className="usage-chart">
    <p id={instructionsId} className="usage-chart-sr-only">{title}{t("。聚焦后用方向键逐时段查看精确值，Home/End 跳到两端，Esc 收起详情；也可悬停或轻触图表。", ". After focusing, use the arrow keys to inspect exact values period by period, Home/End to jump to either end, and Esc to dismiss details; hovering or tapping the chart also works.")}</p>
    <div className="usage-chart-frame">
      <div className="usage-chart-scale" aria-hidden="true">{!unknownScale && ticks.map(tick => <span key={tick} style={{ top: `${tickY(tick) / HEIGHT * 100}%` }}>{axisValue(tick, metric)}</span>)}</div>
      <div className="usage-chart-plot" role="slider" aria-label={t(`${title}时间点`, `${title} time points`)} aria-roledescription={t("交互式趋势图", "interactive trend chart")} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={columns.length} aria-valuenow={Math.max(0, activeIndex) + 1} aria-valuetext={describeColumn(Math.max(0, activeIndex))} aria-describedby={instructionsId} aria-controls={activeColumn ? tooltipId : undefined} tabIndex={0}
        onPointerMove={pointAt} onPointerDown={event => { pointAt(event); if (event.pointerType === "touch") event.currentTarget.focus({ preventScroll: true }); }} onPointerLeave={() => setHovered(null)}
        onFocus={() => setFocused(previous => columns.some(column => column.key === previous) ? previous : columns[0]!.key)} onBlur={() => setFocused(null)} onKeyDown={navigate}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          {ticks.map(tick => <line key={tick} className="usage-chart-grid" x1={0} x2={WIDTH} y1={tickY(tick)} y2={tickY(tick)} vectorEffect="non-scaling-stroke" />)}
          {paths.map(path => <g key={path.provider} className={path.incomplete ? "usage-chart-path-partial" : undefined}>
            {path.runs.map((run, index) => run.points.length > 1 && <path key={index} d={`${run.line} L${run.points[run.points.length - 1]!.x},${HEIGHT} L${run.points[0]!.x},${HEIGHT} Z`} fill={path.color} fillOpacity={path.incomplete ? .05 : .1} />)}
          </g>)}
          {paths.map(path => <g key={path.provider} className={path.incomplete ? "usage-chart-path-partial" : undefined}>
            {path.runs.map((run, index) => run.points.length > 1
              ? <path key={index} d={run.line} fill="none" stroke={path.color} strokeWidth={2} strokeDasharray={path.incomplete ? "4 4" : undefined} vectorEffect="non-scaling-stroke" />
              : <circle key={index} cx={run.points[0]!.x} cy={run.points[0]!.y} r={3} fill={path.color} />)}
          </g>)}
          {activeColumn && <g><line className="usage-chart-crosshair" x1={positionX(activeIndex)} x2={positionX(activeIndex)} y1={TOP} y2={HEIGHT} vectorEffect="non-scaling-stroke" />{providers.map(provider => {
            const value = activeColumn.values.get(provider)!;
            return value.value === null ? null : <circle key={provider} cx={positionX(activeIndex)} cy={positionY(value.value)} r={3.5} fill={providerPresentation(provider).color} stroke="var(--background)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
          })}</g>}
        </svg>
        {activeColumn && <div id={tooltipId} role="tooltip" className="usage-chart-tooltip" style={{ left: `${positionX(activeIndex) / WIDTH * 100}%`, transform: `translateX(-${positionX(activeIndex) / WIDTH * 100}%)` }}>
          <strong className="usage-chart-tooltip-time">{detailLabel(activeColumn.key)}</strong>
          <ul>{providers.map(provider => <li key={provider}><span><UsageProviderIcon provider={provider} size={13} />{providerPresentation(provider).label}</span><span>{describeValue(activeColumn.values.get(provider)!, metric, t)}</span></li>)}</ul>
          <div className="usage-chart-tooltip-total"><span>{t("合计", "Total")}</span><strong>{describeValue(totalFor(activeIndex), metric, t)}</strong></div>
        </div>}
      </div>
      <div className="usage-chart-time-axis" aria-hidden="true">{labels.map(index => <span key={columns[index]!.key} style={{ left: `${positionX(index) / WIDTH * 100}%`, transform: `translateX(-${positionX(index) / WIDTH * 100}%)` }}>{periodLabel(columns[index]!.key)}</span>)}</div>
    </div>
    {(incomplete || (metric === "cost" && data.unknownCost) || data.observedRange || providers.length === 0) && <p className="usage-chart-note">
      {incomplete && t("数据未完整；空缺时段未知，虚线只代表已观测值。", "Data is incomplete; empty periods are unknown, and dashed lines represent observed values only.")}
      {metric === "cost" && data.unknownCost && t("未定价成本未知，不绘为零；混合定价曲线仅含已知成本。", "Unpriced cost is unknown and is not drawn as zero; mixed-pricing lines include known cost only.")}
      {data.observedRange && t("仅显示已观测区间。", "Showing the observed range only.")}
      {providers.length === 0 && !incomplete && t("所选时间内没有 usage 记录。", "No usage records in the selected time range.")}
    </p>}
  </div>;
}

type ShareSegment = { label: string; value: number; color: string };
export function UsageShareBar({ label, segments, format, aside }: { label: string; segments: ShareSegment[]; format: (v: number) => string; aside?: ReactNode }) {
  const t = useAgentText();
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const tooltipId = useId();
  const visible = segments.map((segment, index) => ({ ...segment, index })).filter(segment => Number.isFinite(segment.value) && segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) return null;
  const describe = (segment: ShareSegment) => {
    const percent = segment.value / total * 100;
    return `${segment.label} · ${format(segment.value)} · ${percent > 0 && percent < 1e-8 ? percent.toExponential(8) : percent.toLocaleString(undefined, { maximumFractionDigits: 12 })}% · ${t("原始值", "raw value")} ${segment.value.toLocaleString(undefined, { maximumFractionDigits: 20 })}`;
  };
  const active = visible.find(segment => segment.index === (focused ?? hovered));
  return <section className="usage-share" aria-label={label}>
    <div className="usage-share-header"><h3 className="usage-share-heading">{label}</h3>{aside && <div className="usage-share-aside">{aside}</div>}</div>
    <div className="usage-share-bar" aria-label={t(`${label}占比`, `${label} share`)}>{visible.map(segment => <button type="button" tabIndex={-1} key={segment.index} className="usage-share-segment" style={{ flexGrow: segment.value / total, backgroundColor: segment.color }} aria-label={describe(segment)} title={describe(segment)} onPointerEnter={() => setHovered(segment.index)} onPointerLeave={() => setHovered(null)} onClick={() => setFocused(segment.index)} onFocus={() => setFocused(segment.index)} onBlur={() => setFocused(null)} />)}</div>
    <ul className="usage-share-legend">{visible.map(segment => <li key={segment.index}><button type="button" aria-label={describe(segment)} aria-describedby={active?.index === segment.index ? tooltipId : undefined} onPointerEnter={() => setHovered(segment.index)} onPointerLeave={() => setHovered(null)} onFocus={() => setFocused(segment.index)} onBlur={() => setFocused(null)} onClick={() => setFocused(segment.index)} onKeyDown={event => { if (event.key === "Escape") { setFocused(null); setHovered(null); event.stopPropagation(); } }}>
      <span className="usage-share-swatch" style={{ backgroundColor: segment.color }} aria-hidden="true" /><span className="usage-share-label">{segment.label}</span><span className="usage-share-value">{format(segment.value)}</span>
    </button></li>)}</ul>
    {active && <div id={tooltipId} role="tooltip" className="usage-share-detail">{describe(active)}</div>}
  </section>;
}
