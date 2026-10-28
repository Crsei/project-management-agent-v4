// Usage dashboard adapted from t3code UsagePage.tsx and usageBreakdown.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useProviders } from "@/hooks/use-providers";
import { useTheme } from "@/hooks/use-theme";
import type { UsageBucket, UsageLimitsReport, UsageSummary } from "@agent-workspace/contracts/usage";
import { usageApi } from "./api";
import { aggregate, summaryInput, type Period } from "./page-data";
import { UsageLimitsPage } from "./UsageLimitsPage";
import { UsageTrendChart, UsageShareBar } from "./UsageCharts";
import { UsageModelDetail } from "./UsageModelDetail";
import "./usage-page.css";

type Metric = "cost" | "tokens" | "limits";
const periods: { value: Period; label: string }[] = [{ value: 1, label: "24 小时" }, { value: 7, label: "7 天" }, { value: 30, label: "30 天" }, { value: 90, label: "90 天" }];
const money = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const count = (value: number) => value.toLocaleString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);


function UsageBreakdown({ buckets, metric }: { buckets: UsageBucket[]; metric: "cost" | "tokens" }) {
  const [model, setModel] = useState<string | null>(null);
  const groups = useMemo(() => {
    const result = new Map<string, UsageBucket[]>();
    for (const bucket of buckets) { const key = `${bucket.provider}\u0000${bucket.model}`; result.set(key, [...(result.get(key) ?? []), bucket]); }
    return [...result.entries()].map(([key, rows]) => ({ key, rows, provider: rows[0]!.provider, model: rows[0]!.model, totals: aggregate(rows) }))
      .sort((a, b) => metric === "cost" ? b.totals.cost - a.totals.cost : b.totals.tokens - a.totals.tokens);
  }, [buckets, metric]);
  const selected = groups.find(group => group.key === model);
  const all = aggregate(buckets);
  return <>
    <section className="usage-panel"><h2>分类</h2><p className="usage-muted">Reasoning 是 output 的子集，不重复计入总量。成本为 API 等价估算，不是账单。</p>
      <UsageShareBar label={metric === "tokens" ? "Token 分类" : "成本分类"} format={metric === "tokens" ? count : money} segments={metric === "tokens" ? [
        { label: "未缓存输入", value: all.input, color: "#4f8dde" }, { label: "缓存读取", value: all.cacheRead, color: "#3cae93" },
        { label: "缓存写入", value: all.cacheWrite, color: "#d6a344" }, { label: "输出", value: all.output, color: "#a879d4" },
      ] : [
        { label: "输入", value: all.costInput, color: "#4f8dde" }, { label: "缓存读取", value: all.costRead, color: "#3cae93" },
        { label: "缓存写入", value: all.costWrite, color: "#d6a344" }, { label: "输出", value: all.costOutput, color: "#a879d4" },
        { label: "其他未拆分", value: all.costOther, color: "#969ca7" },
      ]} />
      {metric === "cost" && <UsageShareBar label="速度成本" format={money} segments={[
        { label: "Standard", value: Math.max(0, all.cost - all.fast - all.ultrafast), color: "#4f8dde" },
        { label: "Fast", value: all.fast, color: "#3cae93" }, { label: "Ultrafast", value: all.ultrafast, color: "#a879d4" },
      ]} />}
      <div className="usage-stat-grid">{(metric === "tokens" ? [["未缓存输入", count(all.input)], ["缓存读取", count(all.cacheRead)], ["缓存写入", count(all.cacheWrite)], ["输出", count(all.output)], ["其中 reasoning", count(all.reasoning)]] : [["输入", money(all.costInput)], ["缓存读取", money(all.costRead)], ["缓存写入", money(all.costWrite)], ["输出", money(all.costOutput)], ["其他未拆分", money(all.costOther)], ["缓存节省估算", money(all.savings)], ["Standard", money(Math.max(0, all.cost - all.fast - all.ultrafast))], ["Fast", money(all.fast)], ["Ultrafast", money(all.ultrafast)], ["速度溢价", money(all.premium)]]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    </section>
    <section className="usage-panel"><h2>模型明细</h2>{groups.length === 0 ? <p>所选时间内没有 usage 记录。</p> : <div className="usage-table-wrap"><table><thead><tr><th>Provider / 模型</th><th>Tokens</th><th>估算成本</th><th>未定价记录</th></tr></thead><tbody>{groups.map(group => <tr key={group.key}><th><button className="usage-text-button" type="button" onClick={() => setModel(group.key)}>{group.provider} / {group.model}</button></th><td>{count(group.totals.tokens)}</td><td>{group.totals.unpriced === group.totals.records && group.totals.records > 0 ? "未定价" : money(group.totals.cost)}{group.totals.unpriced > 0 && group.totals.unpriced < group.totals.records ? " + 未定价" : ""}</td><td>{count(group.totals.unpriced)}</td></tr>)}</tbody></table></div>}</section>
    <section className="usage-panel"><h2>Provider / 模型趋势</h2><p className="usage-muted">按{buckets.some(b => b.hourStart) ? "小时" : "日"}显示；未定价记录不计入已知成本。</p><UsageTrendChart buckets={buckets} metric={metric} /></section>
    <UsageModelDetail model={selected ? `${selected.provider} / ${selected.model}` : null} buckets={selected?.rows ?? []} metric={metric} onClose={() => setModel(null)} />
  </>;
}

// Survive route remounts: failed automatic probes also consume the five-minute interval.
const automaticQuotaRefresh = new Map<string, number>();

export default function UsagePage() {
  useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const returnState = location.state as { usageReturnTo?: unknown; usageReturnState?: unknown } | null;
  const returnTo = typeof returnState?.usageReturnTo === "string" && returnState.usageReturnTo.startsWith("/") && !returnState.usageReturnTo.startsWith("//") ? returnState.usageReturnTo : "/workspace";
  const { providers, error: providersError } = useProviders();
  const [metric, setMetric] = useState<Metric>("cost");
  const [period, setPeriod] = useState<Period>(30);
  const [instanceId, setInstanceId] = useState("");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [report, setReport] = useState<UsageLimitsReport | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [limitsError, setLimitsError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [limitsRefreshing, setLimitsRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const epoch = useRef(0);
  const limitsEpoch = useRef(0);
  const lastAutomaticRefresh = useRef(automaticQuotaRefresh);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const input = useMemo(() => summaryInput(period, timeZone, instanceId), [period, timeZone, instanceId]);
  useEffect(() => {
    const id = ++epoch.current; let timer: ReturnType<typeof setTimeout> | undefined; let cancelled = false;
    setLoading(true); setSummary(null); setSummaryError(""); setRefreshing(false);
    const load = async () => {
      try {
        const result = await usageApi.summary(input);
        if (cancelled || epoch.current !== id) return;
        setSummary(result); setSummaryError(""); setLoading(false);
        if (result.sources.some(source => source.refreshing)) timer = setTimeout(() => void load(), 1500);
      } catch (error) { if (!cancelled && epoch.current === id) { setLoading(false); setSummaryError(errorText(error)); } }
    };
    void load();
    return () => { cancelled = true; epoch.current++; clearTimeout(timer); };
  }, [input]);

  const refreshSummary = async () => {
    const id = ++epoch.current; setRefreshing(true); setSummaryError("");
    const refreshInput = summaryInput(period, timeZone, instanceId);
    let active = true;
    // Keep rendering cached partial results while the forced scan is in flight.
    const timer = setInterval(() => { void usageApi.summary(refreshInput).then(result => { if (active && epoch.current === id) setSummary(result); }).catch(() => {}); }, 1500);
    try { const result = await usageApi.summary(refreshInput, true); if (epoch.current === id) setSummary(result); }
    catch (error) { if (epoch.current === id) setSummaryError(errorText(error)); }
    finally { active = false; clearInterval(timer); if (epoch.current === id) { setLoading(false); setRefreshing(false); } }
  };

  const refreshLimits = useCallback(async () => {
    const id = ++limitsEpoch.current; lastAutomaticRefresh.current.set(instanceId ? `instance:${instanceId}` : "all", Date.now()); setLimitsRefreshing(true); setLimitsError("");
    try { const next = await usageApi.refreshLimits(instanceId ? [instanceId] : undefined); if (limitsEpoch.current === id) setReport(next); }
    catch (error) { if (limitsEpoch.current === id) setLimitsError(errorText(error)); }
    finally { if (limitsEpoch.current === id) setLimitsRefreshing(false); }
  }, [instanceId]);
  useEffect(() => {
    if (metric !== "limits") return;
    let cancelled = false;
    const initialEpoch = limitsEpoch.current;
    setLimitsRefreshing(false);
    const load = async () => {
      try { const next = await usageApi.limits(); if (!cancelled && limitsEpoch.current === initialEpoch) { setReport(next); setLimitsError(""); } }
      catch (error) { if (!cancelled && limitsEpoch.current === initialEpoch) setLimitsError(errorText(error)); }
      const key = instanceId ? `instance:${instanceId}` : "all";
      const last = Math.max(lastAutomaticRefresh.current.get(key) ?? 0, lastAutomaticRefresh.current.get("all") ?? 0);
      if (!cancelled && limitsEpoch.current === initialEpoch && Date.now() - last >= 300_000) {
        lastAutomaticRefresh.current.set(key, Date.now()); void refreshLimits();
      }
    };
    void load();
    return () => { cancelled = true; limitsEpoch.current++; };
  }, [metric, instanceId, refreshLimits]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable], [role='dialog'], [aria-modal='true']"))) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); if (returnState?.usageReturnTo) navigate(returnTo, { state: returnState.usageReturnState }); else if (window.history.state?.idx > 0) navigate(-1); else navigate("/workspace"); return; }
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) { const key = event.key.toLowerCase(); if (key === "c" || key === "t" || key === "l") { event.preventDefault(); setMetric(key === "c" ? "cost" : key === "t" ? "tokens" : "limits"); } return; }
      if (metric !== "limits" && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey) {
        const index = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(event.code);
        if (index >= 0) { event.preventDefault(); setPeriod(periods[index]!.value); }
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [metric, navigate, returnTo, returnState]);
  const totals = summary ? aggregate(summary.buckets) : null;
  const updating = refreshing || Boolean(summary?.sources.some(source => source.refreshing));
  return <main className="usage-page"><header className="usage-header"><div><Link to={returnTo} state={returnState?.usageReturnState}>← 返回对话</Link><h1>Usage</h1><p>本机实例的历史使用与订阅额度</p></div><Link to="/settings/usage">模型价格与 Usage 来源设置</Link></header>
    <div className="usage-toolbar"><div role="tablist" aria-label="Usage 视图" className="usage-tabs">{([ ["cost", "Cost"], ["tokens", "Tokens"], ["limits", "Limits"] ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={metric === value} onClick={() => setMetric(value)}>{label}</button>)}</div>
      <label>实例 <select value={instanceId} onChange={event => setInstanceId(event.target.value)}><option value="">所有实例</option>{providers.map(provider => <option key={provider.instanceId} value={provider.instanceId}>{provider.label}{provider.enabled ? "" : "（已停用）"}</option>)}</select></label>
      <button type="button" disabled={metric === "limits" ? limitsRefreshing : refreshing} onClick={() => void (metric === "limits" ? refreshLimits() : refreshSummary())}>{(metric === "limits" ? limitsRefreshing : refreshing) ? "刷新中…" : "刷新"}</button>
    </div>
    {providersError && <p role="alert" className="usage-notice">实例列表不可用：{providersError}</p>}
    {metric !== "limits" && <><div className="usage-periods" aria-label="时间范围">{periods.map(item => <button type="button" key={item.value} aria-pressed={period === item.value} onClick={() => setPeriod(item.value)}>{item.label}</button>)}</div>
      {loading && <p role="status">正在读取历史 usage…</p>}{summaryError && <p role="alert" className="usage-notice">读取失败：{summaryError}{summary ? "；以下为旧快照。" : ""}</p>}
      {summary && totals && <div className={updating ? "usage-updating" : undefined}><section className="usage-hero"><div><span>{metric === "cost" ? "估算 API 等价成本" : "总 Tokens"}</span><strong>{metric === "cost" ? (totals.unpriced === totals.records && totals.records > 0 ? "未定价" : money(totals.cost)) : count(totals.tokens)}</strong>{totals.unpriced > 0 && <p>{count(totals.unpriced)} 条记录未定价，成本不完整</p>}</div><div><span>{metric === "cost" ? "总 Tokens" : "估算成本"}</span><strong>{metric === "cost" ? count(totals.tokens) : totals.unpriced === totals.records && totals.records > 0 ? "未定价" : money(totals.cost)}</strong></div></section>
        {updating && <p role="status">来源仍在刷新，显示当前可用结果。</p>}
        <UsageBreakdown buckets={summary.buckets} metric={metric} />
        <section className="usage-panel"><h2>来源与价格状态</h2><p className="usage-muted">读取于 {new Date(summary.readAt).toLocaleString()} · 时区 {summary.timeZone} · 价格 {summary.pricing.status}（{summary.pricing.source}，{count(summary.pricing.knownModels)} 个模型）</p>{summary.sources.length === 0 ? <p>没有可用来源。</p> : <ul className="usage-rows">{summary.sources.map((source, index) => <li key={`${source.fingerprint.provider}:${source.fingerprint.volumeId}:${index}`}><span>{source.label || source.fingerprint.provider} · {source.status}{source.refreshing ? " · 刷新中" : ""}</span><span>{count(source.scannedFiles)} 文件 · {count(source.skippedFiles)} 跳过 · {count(source.malformedRecords)} 异常{source.message ? ` · ${source.message}` : ""}{source.action === "enableCursorKeychain" && <> · <Link to="/settings/usage">检查授权设置</Link></>}</span></li>)}</ul>}</section>
      </div>}</>}
    {metric === "limits" && <>{limitsRefreshing && <p role="status">正在刷新额度，先显示已有快照…</p>}{limitsError && <p role="alert" className="usage-notice">额度读取失败：{limitsError}{report ? "；以下为旧快照。" : ""}</p>}{report ? <UsageLimitsPage report={report} instanceId={instanceId} now={now} onRefresh={refreshLimits} /> : !limitsError && <p role="status">正在读取额度…</p>}</>}
    <p className="usage-shortcuts">快捷键：C / T / L 切换视图；Ctrl/Cmd + Shift + 1–4 切换时间；Esc 返回。</p>
  </main>;
}
