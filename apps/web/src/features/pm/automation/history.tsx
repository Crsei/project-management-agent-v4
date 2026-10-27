import { useEffect, useId, useState } from "react"
import { useQueryClient, type QueryKey } from "@tanstack/react-query"
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileClock, Minus, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NativeSelect } from "@/components/ui/native-select"
import type { AutomationClient } from "../../../../../../packages/contracts/src/automation-client"
import type { AutomationRule, AutomationRun } from "../../../../../../packages/contracts/src/automation"
import { automationRunSchema } from "../../../../../../packages/contracts/src/automation"
import { usePrivateQuery } from "../service/pm-service"
import { useText } from "../service/pm-ui"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { readAutomation } from "./data"
import { RunDetails, RunStatus } from "./run-details"
import styles from "./history.module.css"

type Props = { api: AutomationClient; queryKey: QueryKey; rules: AutomationRule[]; root: string; ruleId: string; runId: string | null; onFilter: (id: string) => void; onSelect: (id: string) => void; onRule: (id: string) => void; onAccessFailure: () => void }
type ReadProps = Pick<Props, "api" | "queryKey" | "root" | "onRule" | "onAccessFailure">

export function AutomationHistory(props: Props) {
  return <HistoryContent key={props.ruleId} {...props} />
}

function HistoryContent({ api, queryKey, rules, root, ruleId, runId, onFilter, onSelect, onRule, onAccessFailure }: Props) {
  const t = useText()
  const display = useDisplayDateTime()
  const queryClient = useQueryClient()
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState(() => new Set(runId ? [runId] : []))
  const cursor = cursors[page]
  const history = usePrivateQuery([...queryKey, "runs", ruleId, cursor ?? null], "domain.read", undefined, (_client, _workspace, signal) => readAutomation(async () => {
    const result = await api.runs(ruleId || undefined, cursor, { signal })
    return { ...result, items: result.items.map(item => automationRunSchema.parse(item)) }
  }, onAccessFailure))
  const pageRuns = history.error ? [] : history.data?.items ?? []
  const linkedRunId = runId && !pageRuns.some(run => run.id === runId) ? runId : null
  const linked = usePrivateQuery([...queryKey, "run", linkedRunId], "domain.read", undefined, (_client, _workspace, signal) => readAutomation(async () => automationRunSchema.parse(await api.detail(linkedRunId!, { signal })), onAccessFailure), !!linkedRunId)
  const next = history.data?.nextCursor
  const runs = linked.data && !linked.error ? [...pageRuns, linked.data] : [...pageRuns]
  const groups = new Map<string, AutomationRun[]>()
  for (const run of runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id))) {
    const day = new Date(run.startedAt).toDateString()
    const group = groups.get(day)
    if (group) group.push(run)
    else groups.set(day, [run])
  }

  useEffect(() => {
    if (runId) setExpanded(current => new Set(current).add(runId))
  }, [runId])

  const toggle = (id: string) => {
    const opening = !expanded.has(id)
    setExpanded(current => {
      const nextExpanded = new Set(current)
      if (opening) nextExpanded.add(id)
      else nextExpanded.delete(id)
      return nextExpanded
    })
    if (opening) onSelect(id)
  }

  return <section className={styles.history} aria-label={t("运行历史", "Run history")}>
    <header className={styles.heading}>
      <h1>{t("运行历史", "Run history")}</h1>
      <Button className={styles.control} variant="outline" size="sm" disabled={history.isFetching || linked.isFetching} onClick={() => {
        void history.refetch()
        void queryClient.invalidateQueries({ queryKey: [...queryKey, "run"], refetchType: "active" })
      }}><RefreshCw size={14} aria-hidden="true" />{t("刷新", "Refresh")}</Button>
    </header>
    <div className={styles.toolbar}>
      <label className={styles.filterLabel}>
        <span>{t("规则", "Rule")}</span>
        <NativeSelect className={styles.select} value={ruleId} onChange={event => onFilter(event.target.value)}>
          <option value="">{t("所有规则（含已删除）", "All rules, including deleted")}</option>
          {ruleId && !rules.some(rule => rule.id === ruleId) && <option value={ruleId}>{t("已删除或不可用", "Deleted or unavailable")} / {ruleId}</option>}
          {rules.map(rule => <option key={rule.id} value={rule.id}>{rule.config.name}</option>)}
        </NativeSelect>
      </label>
      <span className={styles.pageCount}>{t("本页", "This page:")} {history.data?.items.length ?? "—"} {t("条", "runs")}</span>
    </div>
    {history.isPending && <p className={styles.empty} role="status">{t("加载运行记录…", "Loading runs…")}</p>}
    {history.error && <div className={styles.errorBlock} role="alert">
      <p>{t("运行历史读取失败", "Could not load run history")}</p>
      <Button className={styles.control} variant="outline" size="sm" onClick={() => { void history.refetch() }}>{t("重试", "Retry")}</Button>
    </div>}
    {history.data && !history.error && !pageRuns.length && <div className={styles.empty}>
      <FileClock size={20} aria-hidden="true" />
      <p>{next || page > 0 ? t("本页没有可读取的记录", "No readable runs on this page") : t("暂无运行记录", "No runs yet")}</p>
    </div>}
    {linkedRunId && linked.isPending && <p className={styles.linkNotice} role="status">{t("加载链接记录…", "Loading linked run…")}</p>}
    {linkedRunId && linked.error && <div className={styles.errorBlock} role="alert">
      <p>{t("链接记录不可用或读取失败", "Linked run is unavailable or could not be loaded")}</p>
      <Button className={styles.control} variant="outline" size="sm" onClick={() => { void linked.refetch() }}>{t("重试", "Retry")}</Button>
    </div>}
    <div className={styles.timeline}>
      {[...groups].map(([day, items]) => <section className={styles.dateGroup} key={day} aria-label={display.date(items[0].startedAt)}>
        <h2><time dateTime={items[0].startedAt}>{display.date(items[0].startedAt)}</time></h2>
        <ul className={styles.runList}>
          {items.map(run => <HistoryRunRow key={run.id} run={run} api={api} queryKey={queryKey} root={root} onRule={onRule} onAccessFailure={onAccessFailure} expanded={expanded.has(run.id)} linked={run.id === linkedRunId} onToggle={() => toggle(run.id)} />)}
        </ul>
      </section>)}
    </div>
    {history.data && !history.error && <nav className={styles.pagination} aria-label={t("历史分页", "History pagination")}>
      <Button className={styles.control} size="sm" variant="outline" disabled={page === 0 || history.isFetching} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14} aria-hidden="true" />{t("上一页", "Previous")}</Button>
      <span>{t("第", "Page")} {page + 1}{t(" 页", "")}</span>
      <Button className={styles.control} size="sm" variant="outline" disabled={!next || history.isFetching || cursors.slice(0, page + 1).includes(next ?? undefined)} onClick={() => {
        if (!next) return
        setCursors(current => [...current.slice(0, page + 1), next])
        setPage(value => value + 1)
      }}>{t("下一页", "Next")}<ChevronRight size={14} aria-hidden="true" /></Button>
    </nav>}
  </section>
}

function HistoryRunRow({ run, expanded, linked, onToggle, ...readProps }: ReadProps & { run: AutomationRun; expanded: boolean; linked: boolean; onToggle: () => void }) {
  const t = useText()
  const display = useDisplayDateTime()
  const id = useId()
  const duration = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
  const StatusIcon = run.status === "completed" ? Check : run.status === "failed" ? X : Minus
  return <li className={styles.runRow}>
    <time className={styles.timeGutter} dateTime={run.startedAt}>{display.time(run.startedAt)}</time>
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
            {linked && <><span>/</span><span>{t("链接记录，本页之外", "Linked run, outside this page")}</span></>}
          </span>
        </span>
        <span className={styles.runDuration}>{duration.toFixed(1)}{t("秒", "s")}</span>
        {expanded ? <ChevronUp className={styles.chevron} size={14} aria-hidden="true" /> : <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />}
      </button>
      {expanded && <div className={styles.expansion} id={`${id}-details`} role="region" aria-labelledby={`${id}-heading`}>
        <RunDetailsLoader {...readProps} id={run.id} />
      </div>}
    </div>
  </li>
}

function RunDetailsLoader({ api, queryKey, root, onRule, onAccessFailure, id }: ReadProps & { id: string }) {
  const t = useText()
  const detail = usePrivateQuery([...queryKey, "run", id], "domain.read", undefined, (_client, _workspace, signal) => readAutomation(async () => automationRunSchema.parse(await api.detail(id, { signal })), onAccessFailure))
  if (detail.error) return <div className={styles.errorBlock} role="alert">
    <p>{t("运行详情不可用或读取失败", "Run details are unavailable or could not be loaded")}</p>
    <Button className={styles.control} variant="outline" size="sm" onClick={() => { void detail.refetch() }}>{t("重试", "Retry")}</Button>
  </div>
  if (detail.isPending || detail.isFetching) return <p className={styles.loading} role="status">{t("加载运行详情…", "Loading run details…")}</p>
  return detail.data ? <RunDetails run={detail.data} root={root} onRule={onRule} /> : null
}
