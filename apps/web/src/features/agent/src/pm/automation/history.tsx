import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileClock, Minus, RefreshCw, X } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import type { AutomationClient } from "../../../../../../../../packages/contracts/src/automation-client";
import type { AutomationRule, AutomationRun } from "../../../../../../../../packages/contracts/src/automation";
import { automationRunSchema } from "../../../../../../../../packages/contracts/src/automation";
import { readAutomation } from "./data";
import { useAutomationQuery } from "./query";
import { automationDate, automationTime } from "./format";
import { RunDetails, RunStatus } from "./run-details";
import { useAgentText } from "../../i18n";
import styles from "./history.module.css";

type Props = { api: AutomationClient; rules: AutomationRule[]; root: string; ruleId: string; runId: string | null; reloadKey: number; onFilter: (id: string) => void; onSelect: (id: string) => void; onRule: (id: string) => void; onAccessFailure: () => void };

export function AutomationHistory({ api, rules, root, ruleId, runId, reloadKey, onFilter, onSelect, onRule, onAccessFailure }: Props) {
  const t = useAgentText();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set(runId ? [runId] : []));
  const cursor = cursors[page];
  const history = useAutomationQuery(`runs:${ruleId}:${cursor ?? ""}:${reloadKey}`, signal => readAutomation(async () => {
    const result = await api.runs(ruleId || undefined, cursor, { signal });
    return { ...result, items: result.items.map(item => automationRunSchema.parse(item)) };
  }, onAccessFailure));
  const pageRuns = history.error ? [] : history.data?.items ?? [];
  const linkedRunId = runId && !pageRuns.some(run => run.id === runId) ? runId : null;
  const linked = useAutomationQuery(`run:${linkedRunId ?? ""}:${reloadKey}`, signal => readAutomation(async () => automationRunSchema.parse(await api.detail(linkedRunId!, { signal })), onAccessFailure), !!linkedRunId);
  const next = history.data?.nextCursor;
  const runs = linked.data && !linked.error ? [...pageRuns, linked.data] : [...pageRuns];
  const groups = new Map<string, AutomationRun[]>();
  for (const run of runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id))) {
    const day = new Date(run.startedAt).toDateString();
    const group = groups.get(day);
    if (group) group.push(run);
    else groups.set(day, [run]);
  }

  useEffect(() => {
    if (runId) setExpanded(current => new Set(current).add(runId));
  }, [runId]);

  const toggle = (id: string) => {
    const opening = !expanded.has(id);
    setExpanded(current => {
      const nextExpanded = new Set(current);
      if (opening) nextExpanded.add(id);
      else nextExpanded.delete(id);
      return nextExpanded;
    });
    if (opening) onSelect(id);
  };

  return <section className={styles.history} aria-label={t("运行历史", "Run history")}>
    <header className={styles.heading}>
      <h1>{t("运行历史", "Run history")}</h1>
      <Button className={styles.control} variant="outline" size="sm" disabled={history.loading || linked.loading} onClick={() => { history.refetch(); linked.refetch(); }}><RefreshCw size={14} aria-hidden="true" />{t("刷新", "Refresh")}</Button>
    </header>
    <div className={styles.toolbar}>
      <label className={styles.filterLabel}>
        <span>{t("规则", "Rule")}</span>
        <select className={styles.select} value={ruleId} onChange={event => onFilter(event.target.value)}>
          <option value="">{t("所有规则（含已删除）", "All rules (including deleted)")}</option>
          {ruleId && !rules.some(rule => rule.id === ruleId) && <option value={ruleId}>{t(`已删除或不可用 / ${ruleId}`, `Deleted or unavailable / ${ruleId}`)}</option>}
          {rules.map(rule => <option key={rule.id} value={rule.id}>{rule.config.name}</option>)}
        </select>
      </label>
      <span className={styles.pageCount}>{t(`本页 ${history.data?.items.length ?? "—"} 条`, `${history.data?.items.length ?? "—"} on this page`)}</span>
    </div>
    {history.loading && !history.data && <p className={styles.empty} role="status">{t("加载运行记录…", "Loading run history…")}</p>}
    {!!history.error && <div className={styles.errorBlock} role="alert">
      <p>{t("运行历史读取失败", "Failed to load run history")}</p>
      <Button className={styles.control} variant="outline" size="sm" onClick={history.refetch}>{t("重试", "Retry")}</Button>
    </div>}
    {history.data && !history.error && !pageRuns.length && <div className={styles.empty}>
      <FileClock size={20} aria-hidden="true" />
      <p>{next || page > 0 ? t("本页没有可读取的记录", "No records on this page") : t("暂无运行记录", "No runs yet")}</p>
    </div>}
    {linkedRunId && linked.loading && !linked.data && <p className={styles.linkNotice} role="status">{t("加载链接记录…", "Loading linked record…")}</p>}
    {linkedRunId && !!linked.error && <div className={styles.errorBlock} role="alert">
      <p>{t("链接记录不可用或读取失败", "Linked record unavailable or failed to load")}</p>
      <Button className={styles.control} variant="outline" size="sm" onClick={linked.refetch}>{t("重试", "Retry")}</Button>
    </div>}
    <div className={styles.timeline}>
      {[...groups].map(([day, items]) => <section className={styles.dateGroup} key={day} aria-label={automationDate(items[0]!.startedAt)}>
        <h2><time dateTime={items[0]!.startedAt}>{automationDate(items[0]!.startedAt)}</time></h2>
        <ul className={styles.runList}>
          {items.map(run => <HistoryRunRow key={run.id} run={run} root={root} onRule={onRule} expanded={expanded.has(run.id)} linked={run.id === linkedRunId} onToggle={() => toggle(run.id)} />)}
        </ul>
      </section>)}
    </div>
    {history.data && !history.error && <nav className={styles.pagination} aria-label={t("历史分页", "History pagination")}>
      <Button className={styles.control} size="sm" variant="outline" disabled={page === 0 || history.loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14} aria-hidden="true" />{t("上一页", "Previous")}</Button>
      <span>{t(`第 ${page + 1} 页`, `Page ${page + 1}`)}</span>
      <Button className={styles.control} size="sm" variant="outline" disabled={!next || history.loading || cursors.slice(0, page + 1).includes(next ?? undefined)} onClick={() => {
        if (!next) return;
        setCursors(current => [...current.slice(0, page + 1), next]);
        setPage(value => value + 1);
      }}>{t("下一页", "Next")}<ChevronRight size={14} aria-hidden="true" /></Button>
    </nav>}
  </section>;
}

function HistoryRunRow({ run, root, linked, onToggle, onRule, expanded }: { run: AutomationRun; root: string; linked: boolean; expanded: boolean; onToggle: () => void; onRule: (id: string) => void }) {
  const t = useAgentText();
  const id = useId();
  const duration = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
  const StatusIcon = run.status === "completed" ? Check : run.status === "failed" ? X : Minus;
  return <li className={styles.runRow}>
    <time className={styles.timeGutter} dateTime={run.startedAt}>{automationTime(run.startedAt)}</time>
    <div className={styles.runCard}>
      <button type="button" className={styles.runToggle} aria-expanded={expanded} aria-controls={expanded ? `${id}-details` : undefined} id={`${id}-heading`} onClick={onToggle}>
        <span className={`${styles.statusIcon} ${run.status === "failed" ? styles.negative : run.status === "completed" ? styles.positive : styles.neutral}`}><StatusIcon size={14} aria-hidden="true" /></span>
        <span className={styles.runContent}>
          <span className={styles.runTitle}><strong>{run.ruleName}</strong><RunStatus value={run.status} /></span>
          <span className={styles.runMetadata}>
            <code title={run.id}>{run.id.slice(0, 8)}</code>
            <span>/</span><span>{run.config.projectId}</span>
            <span>/</span><span>v{run.ruleRevision}</span>
            <span>/</span><span>{run.trigger === "scheduled" ? t("定时", "Scheduled") : t("手动", "Manual")}</span>
            {linked && <><span>/</span><span>{t("链接记录，本页之外", "Linked record, outside this page")}</span></>}
          </span>
        </span>
        <span className={styles.runDuration}>{t(`${duration.toFixed(1)} 秒`, `${duration.toFixed(1)}s`)}</span>
        {expanded ? <ChevronUp className={styles.chevron} size={14} aria-hidden="true" /> : <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />}
      </button>
      {expanded && <div className={styles.expansion} id={`${id}-details`} role="region" aria-labelledby={`${id}-heading`}>
        <RunDetails run={run} root={root} onRule={onRule} />
      </div>}
    </div>
  </li>;
}
