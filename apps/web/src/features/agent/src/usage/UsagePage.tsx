// Usage dashboard adapted from t3code UsagePage.tsx and usagePagePreferences.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw, X } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useProviders } from "@agent/hooks/use-providers";
import { useTheme } from "@agent/hooks/use-theme";
import { useAgentText } from "../i18n";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usageProviderKindSchema, type UsageLimitsReport, type UsageProviderKind } from "@agent-workspace/contracts/usage";
import { usageApi } from "./api";
import { USAGE_CONFIG_PATH } from "./navigation";
import type { Period } from "./page-data";
import { UsageLimitsPage } from "./UsageLimitsPage";
import { UsageOverview } from "./UsageOverview";
import { useUsageSummary } from "./use-usage-summary";
import { buildUsageView } from "./usage-view-model";
import { formatUsageExact, formatUsageShare } from "./usage-display";
import { providerPresentation, UsageProviderIcon } from "./usage-presentation";
import "./usage-page.css";
import { RadixSelect } from "@/components/ui/radix-select"

type Metric = "cost" | "tokens" | "limits";
type Preferences = { metric: Metric; period: Period; hiddenProviders: UsageProviderKind[] };
const preferenceKey = "agent-workspace:usage-page:v1";
const periods: { value: Period; zh: string; en: string }[] = [{ value: 1, zh: "24 小时", en: "24 hours" }, { value: 7, zh: "7 天", en: "7 days" }, { value: 30, zh: "30 天", en: "30 days" }, { value: 90, zh: "90 天", en: "90 days" }];
const metrics = [["cost", "Cost"], ["tokens", "Tokens"], ["limits", "Limits"]] as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function readPreferences(): Preferences {
  const defaults: Preferences = { metric: "cost", period: 30, hiddenProviders: [] };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
    if (!value || typeof value !== "object") return defaults;
    const stored = value as Record<string, unknown>;
    const hidden = stored.hiddenProviders;
    return {
      metric: metrics.some(([metric]) => metric === stored.metric) ? stored.metric as Metric : defaults.metric,
      period: periods.some(period => period.value === stored.period) ? stored.period as Period : defaults.period,
      hiddenProviders: Array.isArray(hidden) ? usageProviderKindSchema.options.filter(provider => hidden.includes(provider)) : [],
    };
  } catch { return defaults; }
}

// Failed automatic probes also consume the interval, including across route remounts.
const automaticQuotaRefresh = new Map<string, number>();

export default function UsagePage() {
  useTheme();
  const t = useAgentText();
  const navigate = useNavigate();
  const location = useLocation();
  const returnState = location.state as { usageReturnTo?: unknown; usageReturnState?: unknown } | null;
  const returnTo = typeof returnState?.usageReturnTo === "string" && returnState.usageReturnTo.startsWith("/") && !returnState.usageReturnTo.startsWith("//") ? returnState.usageReturnTo : null;
  const close = useCallback(() => {
    if (returnTo) navigate(returnTo, { state: returnState?.usageReturnState });
    else if (window.history.state?.idx > 0) navigate(-1);
    else navigate("/agent/workspace");
  }, [navigate, returnTo, returnState?.usageReturnState]);
  const { providers, error: providersError } = useProviders();
  const [preferences, setPreferences] = useState(readPreferences);
  const { metric, period, hiddenProviders } = preferences;
  const [instanceId, setInstanceId] = useState("");
  const { summary, input, loading, refreshing, error: summaryError, refresh: refreshSummary } = useUsageSummary({ period, instanceId });
  const view = useMemo(() => buildUsageView(summary, input, hiddenProviders), [summary, input, hiddenProviders]);
  const [report, setReport] = useState<UsageLimitsReport | null>(null);
  const [limitsError, setLimitsError] = useState("");
  const [limitsRefreshing, setLimitsRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const limitsEpoch = useRef(0);
  const limitsInFlight = useRef<{ scope: string; id: number; promise: Promise<void> } | null>(null);
  const setMetric = useCallback((next: Metric) => setPreferences(current => ({ ...current, metric: next })), []);
  const setPeriod = useCallback((next: Period) => setPreferences(current => ({ ...current, period: next })), []);
  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); }
    catch { /* Display preferences remain usable in memory when storage is unavailable. */ }
  }, [preferences]);

  const refreshLimits = useCallback((): Promise<void> => {
    if (limitsInFlight.current?.scope === instanceId) return limitsInFlight.current.promise;
    const id = ++limitsEpoch.current;
    automaticQuotaRefresh.set(instanceId ? `instance:${instanceId}` : "all", Date.now());
    setLimitsRefreshing(true);
    setLimitsError("");
    const promise = usageApi.refreshLimits(instanceId ? [instanceId] : undefined).then(next => {
      if (limitsEpoch.current === id) setReport(next);
    }).catch(error => {
      if (limitsEpoch.current === id) setLimitsError(errorText(error));
    }).finally(() => {
      if (limitsInFlight.current?.id === id) limitsInFlight.current = null;
      if (limitsEpoch.current === id) setLimitsRefreshing(false);
    });
    limitsInFlight.current = { scope: instanceId, id, promise };
    return promise;
  }, [instanceId]);

  useEffect(() => {
    if (metric !== "limits") return;
    let cancelled = false;
    const initialEpoch = ++limitsEpoch.current;
    setLimitsRefreshing(false);
    setLimitsError("");
    const automaticCheck = () => {
      const key = instanceId ? `instance:${instanceId}` : "all";
      const last = Math.max(automaticQuotaRefresh.get(key) ?? 0, automaticQuotaRefresh.get("all") ?? 0);
      if (!cancelled && Date.now() - last >= 300_000) void refreshLimits();
    };
    const load = async () => {
      try {
        const next = await usageApi.limits();
        if (!cancelled && limitsEpoch.current === initialEpoch) setReport(next);
      } catch (error) {
        if (!cancelled && limitsEpoch.current === initialEpoch) setLimitsError(errorText(error));
      }
      if (!cancelled) automaticCheck();
    };
    void load();
    const timer = setInterval(automaticCheck, 30_000);
    return () => { cancelled = true; limitsEpoch.current++; limitsInFlight.current = null; clearInterval(timer); };
  }, [metric, instanceId, refreshLimits]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='searchbox']")) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); close(); return; }
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "c" || key === "t" || key === "l") { event.preventDefault(); setMetric(key === "c" ? "cost" : key === "t" ? "tokens" : "limits"); }
        return;
      }
      if (metric !== "limits" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        const index = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(event.code);
        if (index >= 0) { event.preventDefault(); setPeriod(periods[index]!.value); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [metric, close, setMetric, setPeriod]);

  const visibleProviders = usageProviderKindSchema.options.filter(provider => !hiddenProviders.includes(provider));
  const filterLabel = hiddenProviders.length === 0 ? t("全部 Provider", "All providers") : visibleProviders.length === 1 ? providerPresentation(visibleProviders[0]!).label : t(`${visibleProviders.length} 个 Provider`, `${visibleProviders.length} providers`);
  const filteredReport = useMemo(() => report ? { ...report, accounts: report.accounts.filter(account => !hiddenProviders.includes(account.driver)) } : null, [report, hiddenProviders]);
  const sourceWarnings = view.sources.filter(source => source.status !== "ok" && source.message).map(source => `${source.label || providerPresentation(source.fingerprint.provider).label}${t("：", ": ")}${source.message}`);
  const warnings = [...new Set([...view.warnings, ...sourceWarnings])];
  const updating = refreshing || view.refreshingProviders.length > 0;
  const busy = metric === "limits" ? limitsRefreshing : updating;

  return <div className="usage-page">
    <header className="usage-topbar desktop-titlebar desktop-titlebar-reserve-controls">
      <div className="usage-breadcrumbs">
        <h1>Usage</h1><span className="usage-breadcrumb-divider" aria-hidden="true">/</span>
        <DropdownMenu><DropdownMenuTrigger className="usage-filter-trigger">{t("本机环境", "Local environment")}<ChevronDown size={13} aria-hidden="true" /></DropdownMenuTrigger>
          <DropdownMenuContent className="usage-filter-menu">
            <DropdownMenuLabel className="usage-menu-label">{t("本机环境", "Local environment")}</DropdownMenuLabel>
            <p className="usage-menu-note">{t("原生来源可能包含本机账号在其他工具中的历史，不仅限于当前 PM 项目。", "Native sources may include history from this machine's accounts in other tools, not only the current PM project.")}</p>
            <label className="usage-instance-filter">{t("实例", "Instance")}<RadixSelect value={instanceId} onKeyDown={event => event.stopPropagation()} onChange={event => setInstanceId(event.target.value)}><option value="">{t("所有实例", "All instances")}</option>{instanceId && !providers.some(provider => provider.instanceId === instanceId) && <option value={instanceId}>{t("当前实例（列表不可用或已移除）", "Current instance (list unavailable or removed)")}</option>}{providers.map(provider => <option key={provider.instanceId} value={provider.instanceId}>{provider.label}{provider.enabled ? "" : t("（已停用）", " (disabled)")}</option>)}</RadixSelect></label>
            <p className="usage-menu-note">{metric === "limits" ? t("额度不受时间范围影响；每 5 分钟自动检查。", "Limits are independent of the time range; checked automatically every 5 minutes.") : summary ? t(`${view.sources.length} 个选中来源 · ${view.partial ? "部分数据" : "当前快照"}`, `${view.sources.length} selected sources · ${view.partial ? "partial data" : "current snapshot"}`) : t("正在读取来源状态", "Loading source status")}</p>
            <DropdownMenuSeparator className="usage-menu-separator" />
            <DropdownMenuItem render={<Link to={USAGE_CONFIG_PATH} />}>{t("模型价格与 Usage 来源设置", "Model pricing and Usage source settings")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="usage-breadcrumb-divider" aria-hidden="true">/</span>
        <DropdownMenu><DropdownMenuTrigger className="usage-filter-trigger">{filterLabel}<ChevronDown size={13} aria-hidden="true" /></DropdownMenuTrigger>
          <DropdownMenuContent className="usage-filter-menu">
            <DropdownMenuLabel className="usage-menu-label">{t("Provider 多选", "Provider selection")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setPreferences(current => ({ ...current, hiddenProviders: [] }))}>{t("显示全部 Provider", "Show all providers")}</DropdownMenuItem>
            <DropdownMenuSeparator className="usage-menu-separator" />
            {usageProviderKindSchema.options.map(provider => <DropdownMenuCheckboxItem key={provider} checked={!hiddenProviders.includes(provider)} onSelect={event => event.preventDefault()} onCheckedChange={checked => setPreferences(current => ({ ...current, hiddenProviders: checked ? current.hiddenProviders.filter(value => value !== provider) : [...current.hiddenProviders, provider] }))}><UsageProviderIcon provider={provider} size={16} />{providerPresentation(provider).label}</DropdownMenuCheckboxItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        {instanceId && <span className="usage-instance-badge" title={providers.find(provider => provider.instanceId === instanceId)?.label ?? instanceId}>{providers.find(provider => provider.instanceId === instanceId)?.label ?? t("选定实例", "Selected instance")}</span>}
      </div>
      <div className="usage-topbar-controls">
        <div className="usage-segmented usage-periods" role="group" aria-label={metric === "limits" ? t("时间范围（不适用于额度）", "Time range (not applicable to limits)") : t("时间范围", "Time range")}>{periods.map((item, index) => <button type="button" key={item.value} disabled={metric === "limits"} aria-pressed={period === item.value} title={metric === "limits" ? t("额度不受历史时间范围影响", "Limits are independent of the historical time range") : `${t(item.zh, item.en)} · Ctrl/Cmd + Shift + ${index + 1}`} onClick={() => setPeriod(item.value)}>{t(item.zh, item.en)}</button>)}</div>
        <div className="usage-segmented usage-tabs" role="group" aria-label={t("Usage 视图", "Usage view")}>{metrics.map(([value, label]) => <button key={value} type="button" aria-pressed={metric === value} title={`${label} · ${value === "cost" ? "C" : value === "tokens" ? "T" : "L"}`} onClick={() => setMetric(value)}>{label}</button>)}</div>
        <button type="button" className="usage-icon-button" aria-label={busy ? t("刷新中", "Refreshing") : t("刷新 Usage", "Refresh Usage")} title={t("刷新", "Refresh")} disabled={metric === "limits" ? limitsRefreshing : refreshing} onClick={() => void (metric === "limits" ? refreshLimits() : refreshSummary())}><RefreshCw size={16} className={busy ? "usage-refresh-spinning" : undefined} aria-hidden="true" /></button>
        <button type="button" className="usage-icon-button" aria-label={t("关闭 Usage，返回对话", "Close Usage and return to chat")} title={t("关闭 · Esc", "Close · Esc")} onClick={close}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>

    <div className="usage-content">
      {providersError && <p role="alert" className="usage-notice">{t("实例列表不可用：", "Instance list unavailable: ")}{providersError}</p>}
      {metric !== "limits" ? <>
        {loading && !summary && <p className="usage-loading" role="status">{t("正在读取历史 Usage…", "Loading historical Usage…")}</p>}
        {summaryError && <p role="alert" className="usage-notice">{t("读取失败：", "Load failed: ")}{summaryError}{summary ? t("；以下为同一范围的旧快照。", "; the following is an older snapshot of the same range.") : ""}</p>}
        {warnings.map(warning => <p role="status" className="usage-notice" key={warning}>{warning}</p>)}
        {summary && view.compatible && <>
          {summary.pricing.status === "unavailable" && <p className="usage-notice" role="status">{t("价格来源不可用；已知成本不含无法计价的记录。", "The pricing source is unavailable; known cost excludes records that cannot be priced.")}<Link to={USAGE_CONFIG_PATH}>{t("检查模型价格", "Check model pricing")}</Link></p>}
          {summary.pricing.status === "cached" && <p className="usage-status" role="status">{t("当前使用缓存价格", "Using cached prices")}{summary.pricing.fetchedAt ? t(`（${new Date(summary.pricing.fetchedAt).toLocaleString()}）`, ` (${new Date(summary.pricing.fetchedAt).toLocaleString()})`) : ""}{t("，不保证为最新费率。", "; rates may not be current.")}</p>}
          {view.totals.unpriced > 0 && <p className="usage-notice" role="status">{formatUsageExact(view.totals.unpriced)} {t("条记录未定价，成本与缓存节省不完整；Share 仅按已知成本计算。", "records are unpriced, so cost and cache savings are incomplete; Share uses known cost only.")}<Link to={USAGE_CONFIG_PATH}>{t("设置模型价格", "Set model pricing")}</Link></p>}
          {refreshing && !view.partial && <p role="status" className="usage-status">{t("正在刷新，暂时显示同一范围的已有快照。", "Refreshing; showing the existing snapshot for the same range for now.")}</p>}
          <UsageOverview key={`${instanceId}:${period}:${hiddenProviders.join(",")}`} view={view} input={input} metric={metric} />
          <details className="usage-source-details"><summary>{t("来源与价格状态", "Source and pricing status")}{view.partial ? t(" · 部分结果", " · partial result") : ""}</summary>
            <p className="usage-muted">{t("读取于", "Read at")} {new Date(summary.readAt).toLocaleString()} · {t("时区", "Time zone")} {input.timeZone} · {t("价格", "Pricing")} {summary.pricing.status}{t("（", " (")}{summary.pricing.source}{t("，", "; ")}{formatUsageExact(summary.pricing.knownModels)} {t("个模型", "models")}{summary.pricing.fetchedAt ? t(`，更新于 ${new Date(summary.pricing.fetchedAt).toLocaleString()}`, `, updated ${new Date(summary.pricing.fetchedAt).toLocaleString()}`) : ""}{t("）", ")")}</p>
            <p className="usage-muted">{t("记录成本来源：供应商报告", "Recorded cost sources: provider-reported")} {formatUsageShare(view.costQuality.providerReportedShare)} · {t("模型估价", "model-priced")} {formatUsageShare(view.costQuality.modelPricedShare)} · {t("未定价", "unpriced")} {formatUsageShare(view.costQuality.unpricedShare)}{t("。", ". ")}<Link to={USAGE_CONFIG_PATH}>{t("模型价格与来源设置", "Model pricing and source settings")}</Link></p>
            {view.sources.length === 0 ? <p className="usage-muted">{t("当前筛选没有可用来源。", "No sources are available for the current filter.")}</p> : <ul className="usage-rows">{view.sources.map((source, index) => <li key={`${source.fingerprint.provider}:${source.fingerprint.volumeId}:${index}`}><span>{source.label || providerPresentation(source.fingerprint.provider).label} · {source.status}{source.refreshing ? t(" · 刷新中", " · refreshing") : ""}</span><span>{formatUsageExact(source.scannedFiles)} {t("文件", "files")} · {formatUsageExact(source.skippedFiles)} {t("跳过", "skipped")} · {formatUsageExact(source.malformedRecords)} {t("异常", "malformed")}{source.message ? ` · ${source.message}` : ""}{source.action === "enableCursorKeychain" && <> · <Link to={USAGE_CONFIG_PATH}>{t("检查授权设置", "Check authorization settings")}</Link></>}</span></li>)}</ul>}
          </details>
        </>}
      </> : <>
        <p className="usage-muted">{t("本机账号订阅额度 · 每 5 分钟自动检查 · 与历史时间范围无关。", "Local account subscription limits · checked every 5 minutes · independent of the historical time range.")}<Link to={USAGE_CONFIG_PATH}>{t("来源设置", "Source settings")}</Link></p>
        {limitsRefreshing && <p role="status" className="usage-status">{t("正在刷新额度，先显示已有快照…", "Refreshing limits; showing the existing snapshot…")}</p>}
        {limitsError && <p role="alert" className="usage-notice">{t("额度读取失败：", "Failed to load limits: ")}{limitsError}{report ? t("；以下为旧快照。", "; the following is an older snapshot.") : ""}</p>}
        {filteredReport ? <UsageLimitsPage key={`${instanceId}:${hiddenProviders.join(",")}`} report={filteredReport} instanceId={instanceId} now={now} onRefresh={refreshLimits} /> : !limitsError && <p role="status">{t("正在读取额度…", "Loading limits…")}</p>}
      </>}
      <p className="usage-shortcuts">{t("C / T / L 切换视图 · Ctrl/Cmd + Shift + 1–4 切换时间 · Esc 返回", "C / T / L switch view · Ctrl/Cmd + Shift + 1–4 switch time range · Esc to go back")}</p>
    </div>
  </div>;
}
