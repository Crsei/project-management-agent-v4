import { useEffect, useState } from "react";
import { Activity, CalendarClock, Clock3, Filter, GitBranch, LayoutGrid, List, Play, Plus, Search, Workflow } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import type { StudioDefinition, StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio";
import { useAgentText } from "../../i18n";
import { useAutomationQuery } from "./query";
import { automationDateTime } from "./format";
import { executionDuration, studioExecutionNeedsRefresh, studioStatusLabel, studioTriggerLabel } from "./studio-view";
import styles from "./studio.module.css";
import { RadixSelect } from "@/components/ui/radix-select"

export type DashboardFilters = { search: string; status: string; trigger: string; tag: string; sort: string; view: string };
export type DashboardAction = "view" | "edit" | "run" | "status" | "remove" | "export";
export function StudioDashboard({ definitions, executions, executionError, api, filters, onFilters, onAction, onNew, onTemplates, onImport, onGit, onHistory, onMore, hasMore, loadingMore, writableFor, locked, onAccessFailure }: {
  definitions: StudioDefinition[]; executions?: StudioExecution[]; executionError: boolean; api: StudioClient; filters: DashboardFilters; onFilters: (patch: Partial<DashboardFilters>) => void; onAction: (action: DashboardAction, item: StudioDefinition) => void; onNew: () => void; onTemplates: () => void; onImport: () => void; onGit: () => void; onHistory: () => void; onMore: () => void; hasMore: boolean; loadingMore: boolean; writableFor: (projectId: string) => boolean; locked: boolean; onAccessFailure: (cause: unknown) => void;
}) {
  const t = useAgentText(); const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState(filters.search);
  useEffect(() => { setSearch(filters.search); }, [filters.search]);
  const items = definitions;
  const latestExecutions = executions?.slice(0, 20);
  const durations = latestExecutions?.flatMap(run => { const duration = executionDuration(run); return duration === null ? [] : [duration]; }) ?? [];
  const attention = new Set<string>();
  for (const run of latestExecutions ?? []) if (["failed", "outcome_unknown"].includes(run.status)) attention.add(run.definitionId);
  const statsReady = !executionError && latestExecutions !== undefined;
  const tags = [...new Set(definitions.flatMap(definition => definition.config.tags))].sort();
  if (filters.tag && !tags.includes(filters.tag)) tags.push(filters.tag);
  const filtered = items.filter(item => {
    const config = item.config;
    if (filters.search && !`${config.name} ${config.description} ${config.projectId} ${config.tags.join(" ")}`.toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase())) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.trigger && config.trigger.kind !== filters.trigger) return false;
    return !filters.tag || config.tags.includes(filters.tag);
  }).sort((a, b) => filters.sort === "name" ? a.config.name.localeCompare(b.config.name) : filters.sort === "lastRun" ? (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") : filters.sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : b.updatedAt.localeCompare(a.updatedAt));
  const activeFilters = [filters.status, filters.trigger, filters.tag].filter(Boolean).length;
  return <div className={styles.stack}>
    <header className={styles.heading}><div><h1>{t("自动化", "Automations")}</h1><p>{t("让 Agent 和脚本按计划工作。", "Put agents and scripts on a schedule.")}</p></div><div className={styles.headerActions}><Button variant="outline" size="sm" onClick={onGit}><GitBranch size={14} />Git Sync</Button><details className={styles.menu}><summary className={styles.primaryMenu}><Plus size={14} />{t("添加自动化", "Add Automation")}</summary><div className={styles.menuPanel}><button type="button" onClick={onNew}>{t("从空白创建", "Create from scratch")}</button><button type="button" onClick={onTemplates}>{t("浏览模板", "Browse templates")}</button><button type="button" onClick={onImport}>{t("导入定义", "Import definition")}</button></div></details></div></header>
    <div className={styles.stats} aria-label={t("自动化概览", "Automation overview")}>
      {[{ label: t("自动化", "Automations"), value: items.length, Icon: Workflow }, { label: t("需要关注", "Needs attention"), value: statsReady ? attention.size : "—", Icon: Activity }, { label: t("近期运行", "Recent runs"), value: statsReady ? latestExecutions.length : "—", Icon: CalendarClock }, { label: t("平均耗时", "Avg. duration"), value: statsReady && durations.length ? `${(durations.reduce((a, b) => a + b, 0) / durations.length / 1000).toFixed(1)}s` : "—", Icon: Clock3 }].map(stat => <div className={styles.stat} key={stat.label}><div><span>{stat.label}</span><stat.Icon size={15} /></div><strong>{stat.value}</strong></div>)}
    </div>
    <p className={styles.scopeNote}>{t(`数量：已加载 ${definitions.length} 条执行定义${hasMore ? "（还有未加载定义）" : ""}。运行统计：最近最多20条执行的样本，非全库统计；需关注为样本内失败或未知的自动化。`, `Counts: ${definitions.length} loaded execution definitions${hasMore ? " (more definitions available)" : ""}. Run metrics sample at most the latest 20 executions, not all-time totals; attention means failed or unknown in that sample.`)}</p>
    <div className={styles.controls}><label className={styles.search}><Search size={16} /><Input aria-label={t("搜索自动化", "Search automations")} value={search} placeholder={t("搜索自动化…", "Search automations…")} onChange={event => { const value = event.target.value; setSearch(value); onFilters({ search: value }); }} /></label><div className={styles.filterContainer}><Button variant="outline" size="sm" aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}><Filter size={14} />{t("筛选", "Filters")}{activeFilters ? ` (${activeFilters})` : ""}</Button>{filterOpen && <div className={styles.filterPanel} onKeyDown={event => { if (event.key === "Escape") setFilterOpen(false); }}>
      <label>{t("状态", "Status")}<RadixSelect value={filters.status} onChange={event => onFilters({ status: event.target.value })}><option value="">{t("所有状态", "All statuses")}</option><option value="enabled">{t("活跃", "Active")}</option><option value="paused">{t("已暂停", "Inactive")}</option><option value="draft">{t("已存草稿", "Saved drafts")}</option></RadixSelect></label>
      <label>{t("触发方式", "Trigger")}<RadixSelect value={filters.trigger} onChange={event => onFilters({ trigger: event.target.value })}><option value="">{t("所有触发器", "All triggers")}</option><option value="manual">{t("手动", "Manual")}</option><option value="once">{t("单次", "Once")}</option><option value="cron">Cron</option><option value="event">{t("事件", "Event")}</option></RadixSelect></label>
      <label>{t("标签", "Tag")}<RadixSelect value={filters.tag} onChange={event => onFilters({ tag: event.target.value })}><option value="">{t("所有标签", "All tags")}</option>{tags.map(tag => <option key={tag}>{tag}</option>)}</RadixSelect></label>
      <p className={styles.muted}>{t("定义按当前创建者授权可见，不提供误导性的跨创建者筛选。", "Definitions are scoped to the authorized creator; no misleading cross-creator filter is offered.")}</p><Button variant="ghost" size="sm" onClick={() => onFilters({ status: "", trigger: "", tag: "", sort: "updated" })}>{t("重置筛选", "Reset filters")}</Button>
    </div>}</div><label className={styles.sort}><span className="sr-only">{t("排序", "Sort")}</span><RadixSelect aria-label={t("排序", "Sort")} value={filters.sort} onChange={event => onFilters({ sort: event.target.value })}><option value="updated">{t("最近更新", "Recently updated")}</option><option value="name">{t("名称", "Name")}</option><option value="lastRun">{t("最近运行", "Last run")}</option><option value="oldest">{t("最早创建", "Oldest first")}</option></RadixSelect></label><div className={styles.viewToggle} role="group" aria-label={t("显示模式", "View mode")}><button type="button" aria-label={t("网格", "Grid")} aria-pressed={filters.view !== "list"} onClick={() => onFilters({ view: "grid" })}><LayoutGrid size={16} /></button><button type="button" aria-label={t("列表", "List")} aria-pressed={filters.view === "list"} onClick={() => onFilters({ view: "list" })}><List size={16} /></button></div></div>
    {!items.length ? <div className={styles.empty}><Workflow size={32} /><h2>{t("把重复工作交给自动化", "Let automations handle the routine")}</h2><p>{t("从模板开始，或创建 Prompt / Python 自动化。浏览不会启动执行。", "Start with a template, or create a prompt / Python automation. Browsing never dispatches a run.")}</p><Button onClick={onTemplates}>{t("浏览模板", "Browse templates")}</Button></div> : !filtered.length ? <div className={styles.empty}><Search size={26} /><h2>{t("没有匹配的自动化", "No matching automations")}</h2><p>{t("搜索和筛选仅应用于已加载的定义。", "Search and filters apply to loaded definitions.")}</p><Button variant="outline" onClick={() => onFilters({ search: "", status: "", trigger: "", tag: "" })}>{t("清除筛选", "Clear filters")}</Button></div> : ["enabled", "paused", "draft"].map(status => {
      const group = filtered.filter(item => item.status === status); if (!group.length) return null;
      return <section className={styles.group} key={status}><h2>{status === "enabled" ? t("活跃", "Active") : status === "paused" ? t("未活跃", "Inactive") : t("已存草稿", "Saved Drafts")}<span className={styles.count}>{group.length}</span></h2><ul className={filters.view === "list" ? styles.list : styles.grid}>{group.map(item => <DashboardCard key={item.id} item={item} api={api} onAction={action => onAction(action, item)} writable={writableFor(item.config.projectId)} locked={locked} onAccessFailure={onAccessFailure} />)}</ul></section>;
    })}
    {hasMore && <Button variant="outline" disabled={loadingMore} onClick={onMore}>{loadingMore ? t("正在加载…", "Loading…") : t("加载更多定义", "Load more definitions")}</Button>}
    <button type="button" className={styles.backLink} onClick={onHistory}>{t("查看全部历史（包括已删除定义）", "View all history (including deleted definitions)")}</button>
  </div>;
}
function DashboardCard({ item, api, onAction, writable, locked, onAccessFailure }: { item: StudioDefinition; api: StudioClient; onAction: (action: DashboardAction) => void; writable: boolean; locked: boolean; onAccessFailure: (cause: unknown) => void }) {
  const t = useAgentText();
  const sample = useAutomationQuery(`studio-card:${item.id}:${item.revision}:${item.lastRunAt}`, async signal => {
    try {
      return (await api.executions(item.id, undefined, { signal })).items.slice(0, 20);
    } catch (cause) { onAccessFailure(cause); throw cause; }
  }, true, runs => runs.some(studioExecutionNeedsRefresh));
  const runs = sample.error ? [] : sample.data ?? []; const latest = runs[0];
  const completed = runs.filter(run => run.status === "completed").length; const outcomes = runs.filter(run => ["completed", "failed"].includes(run.status)).length;
  const durations = runs.flatMap(run => { const duration = executionDuration(run); return duration === null ? [] : [duration]; });
  const definition = item; const config = definition.config;
  return <li className={styles.card}>
    <header className={styles.cardHeader}><button type="button" className={styles.cardTitle} onClick={() => onAction("view")}><h3 title={config.name}>{config.name}</h3></button><div className={styles.cardActions}><button type="button" aria-label={t(`运行 ${config.name}`, `Run ${config.name}`)} disabled={!writable || locked || definition.status === "draft"} onClick={() => onAction("run")}><Play size={15} /></button><details className={styles.menu}><summary aria-label={t(`操作 ${config.name}`, `Actions for ${config.name}`)}>•••</summary><div className={styles.menuPanel}><button type="button" onClick={() => onAction("view")}>{t("查看", "View")}</button><button type="button" disabled={!writable || locked} onClick={() => onAction("edit")}>{t("编辑", "Edit")}</button><button type="button" onClick={() => onAction("export")}>{t("导出", "Export")}</button><button type="button" disabled={!writable || locked} onClick={() => onAction("status")}>{definition.status === "enabled" ? t("暂停", "Turn off") : t("启用", "Turn on")}</button><button type="button" className={styles.dangerText} disabled={!writable || locked} onClick={() => onAction("remove")}>{t("删除", "Delete")}</button></div></details></div></header>
    <p className={styles.cardDescription}>{config.description || (config.action.kind === "prompt" ? config.action.prompt : config.action.kind === "script" ? config.action.entrypoint : config.action.templateId)}</p>
    <div className={styles.pills}><span className={styles.badge}>{config.action.kind === "prompt" ? "Agent" : config.action.kind === "script" ? "Python" : t("原生模板", "Native template")}</span><span className={styles.badge} title={studioTriggerLabel(config.trigger, t)}>{config.trigger.kind === "manual" ? t("手动", "Manual") : config.trigger.kind === "cron" ? "Cron" : config.trigger.kind === "once" ? t("单次", "Once") : t("事件", "Event")}</span>{config.tags.slice(0, 3).map(tag => <span className={styles.badge} key={tag}>#{tag}</span>)}</div>
    {!!runs.length && !sample.error && <div className={styles.activityStrip} role="img" aria-label={t(`最近 ${runs.length} 次运行状态，由旧到新`, `Latest ${runs.length} run outcomes, oldest to newest`)}>{[...runs].reverse().map(run => <span key={run.id} data-status={run.status} title={`${studioStatusLabel(run.status, t)} · ${automationDateTime(run.startedAt ?? run.createdAt)}`} />)}</div>}
    <div className={styles.cardStatus}>{sample.loading ? <span>{t("读取近期运行…", "Loading recent runs…")}</span> : sample.error ? <button type="button" onClick={sample.refetch}>{t("运行摘要不可用，重试", "Run summary unavailable; retry")}</button> : latest ? <><span className={styles.statusDot} data-status={latest.status} /><span>{studioStatusLabel(latest.status, t)}</span><time dateTime={latest.startedAt ?? latest.createdAt}>{automationDateTime(latest.startedAt ?? latest.createdAt)}</time></> : <span>{t("尚未运行", "Not run yet")}</span>}</div>
    {latest && "error" in latest && latest.error && <p className={styles.cardError} title={latest.error}>{latest.error}</p>}
    <footer className={styles.cardFooter}><span>{outcomes ? `${Math.round(completed / outcomes * 100)}%` : "—"} {t("成功率", "success")}</span><span>{durations.length ? `${(durations.reduce((a, b) => a + b, 0) / durations.length / 1000).toFixed(1)}s` : "—"} {t("平均", "avg")}</span><small>{sample.loading || sample.error ? t("摘要未就绪", "Summary unavailable") : t(`最近 ${runs.length} 条`, `Latest ${runs.length}`)}</small></footer>
  </li>;
}
