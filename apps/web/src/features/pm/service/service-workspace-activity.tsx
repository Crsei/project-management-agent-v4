import { useEffect, useMemo, useState } from "react"
import { Link, useLocation, useParams } from "react-router"
import { Activity, ArrowRight, ListFilter, RefreshCw } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { useI18n } from "@/lib/i18n-provider"
import { actionLabels } from "./activity-action-labels"
import { useWorkspaceActivity } from "./pm-activity-hooks"
import { usePmService } from "./pm-service"
import { ServiceGuard, useText } from "./pm-ui"
import type { ActivityEntry } from "./workspace-activity-model"
import styles from "./service-workspace-activity.module.css"

type Text = (zh: string, en: string) => string
const dayMilliseconds = 86_400_000
/** Read-only workspace history; the personal notification inbox remains a separate surface. */
export function ServiceWorkspaceActivity() {
  const { actor, workspace, actorEpoch } = usePmService()
  return <ServiceGuard>{actor && workspace && <WorkspaceActivity key={`${actor.id}:${workspace.id}:${workspace.version}:${actorEpoch}`} />}</ServiceGuard>
}

function WorkspaceActivity() {
  const activity = useWorkspaceActivity()
  const t = useText()
  const locale = useI18n().locale === "en" ? "en-US" : "zh-CN"
  const { workspaceSlug } = useParams()
  const location = useLocation()
  const root = `/pm/${encodeURIComponent(workspaceSlug ?? "")}`
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  const inboxParams = new URLSearchParams(location.search)
  inboxParams.set("section", "notifications")
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // UTC is an explicitly labelled display boundary, never a guessed personal preference.
  const timeZone = activity.timeZone ?? "UTC"
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone, month: "long", day: "numeric", year: "numeric" }), [locale, timeZone])
  const timestampFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }), [locale, timeZone])
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }), [timeZone])
  const relativeFormatter = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }), [locale])
  const people = useMemo(() => new Map(activity.people.map(person => [person.id, person.name])), [activity.people])
  const visible = useMemo(() => activity.entries.filter(entry => conditions.every(condition => matchesActivityCondition(entry, condition)),
  ).sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt)
    const rightTime = Date.parse(right.occurredAt)
    return (Number.isFinite(rightTime) ? rightTime : -Infinity) - (Number.isFinite(leftTime) ? leftTime : -Infinity) || right.id.localeCompare(left.id)
  }), [activity.entries, conditions])
  const groups = useMemo(() => {
    const result = new Map<number | null, ActivityEntry[]>()
    for (const entry of visible) {
      const timestamp = Date.parse(entry.occurredAt)
      const day = Number.isFinite(timestamp) ? calendarDay(timestamp, dayFormatter) : null
      const entries = result.get(day)
      if (entries) entries.push(entry)
      else result.set(day, [entry])
    }
    return Array.from(result, ([day, entries]) => ({ day, entries }))
  }, [visible, dayFormatter])
  const currentDay = calendarDay(now, dayFormatter)
  const activeConditions = conditions.filter(condition => condition.values.length > 0).length
  const filterFields: readonly FilterField[] = [
    { id: "type", label: t("类型", "Type"), options: [
      { value: "status", label: t("状态变更", "Status changes") },
      { value: "comments", label: t("评论", "Comments") },
      { value: "projects", label: t("项目", "Projects") },
    ] },
    { id: "person", label: t("人员", "Person"), options: activity.people.map(person => ({ value: person.id, label: person.name || t("未命名成员", "Unnamed member") })) },
  ]
  const zoneLabel = activity.timeZone ?? t("UTC（个人时区暂不可用）", "UTC (personal time zone unavailable)")

  return <section className={styles.page} aria-label={t("工作区动态", "Workspace activity")} data-pm-workspace-activity>
    <div className={styles.content}>
      <header className={styles.heading}>
        <div className={styles.headingText}><h1>{t("动态", "Activity")}</h1></div>
        <div className={styles.headerActions}>
          <Link to={`${root}/notifications?${inboxParams}`} className={styles.inboxLink}>{t("个人通知", "Personal inbox")}<ArrowRight size={12} aria-hidden="true" /></Link>
          <button type="button" className={styles.refresh} onClick={activity.refetch} disabled={activity.isFetching} aria-label={t("刷新动态", "Refresh activity")} title={t("刷新动态", "Refresh activity")}><RefreshCw size={14} aria-hidden="true" /></button>
        </div>
      </header>
      <div className={styles.toolbar}>
        <Popover>
          <PopoverTrigger render={<button type="button" className={styles.filterTrigger} aria-pressed={activeConditions > 0} aria-label={t(`筛选动态，已启用 ${activeConditions} 个条件`, `Filter activity, ${activeConditions} active`)} />}>
            <ListFilter size={14} aria-hidden="true" />
            <span>{t("筛选", "Filter")}</span>
            {activeConditions > 0 && <span className={styles.filterCount}>{activeConditions}</span>}
          </PopoverTrigger>
          <PopoverContent align="start" className={styles.filterPopover} aria-label={t("动态筛选", "Activity filters")}>
            <FilterCard title={t("筛选动态", "Filter activity")} fields={filterFields} conditions={conditions} onChange={setConditions} emptyHint={t("尚未添加条件；列表显示全部可见动态。", "No conditions yet; every visible entry is listed.")} addLabel={t("添加条件", "Add condition")} clearLabel={t("清除", "Clear")} whereLabel={t("条件", "Where")} andLabel={t("且", "and")} anyLabel={t("任意", "Any")} removeLabel={t("删除条件", "Remove condition")} />
          </PopoverContent>
        </Popover>
      </div>
      <div className={styles.readStatus}>
        <span>{t("时间：", "Times in ")}{zoneLabel}</span>
        <span role="status" aria-live="polite">{activity.isFetching && !activity.isPending ? t("正在刷新…", "Refreshing…") : !activity.isPending && !activity.error ? t(`${visible.length} 条动态`, `${visible.length} ${visible.length === 1 ? "entry" : "entries"}`) : ""}</span>
      </div>
      {activity.error && <div className={styles.error} role="alert">
        <div><strong>{t("未能完整读取动态", "Activity could not be fully loaded")}</strong><p>{activity.error.message}</p>{activity.entries.length > 0 && <p>{t("可见记录可能不完整或已过期。", "Visible records may be incomplete or out of date.")}</p>}</div>
        <button type="button" onClick={activity.refetch} disabled={activity.isFetching}>{t("重试读取", "Retry")}</button>
      </div>}
      <div aria-busy={activity.isPending}>
        {activity.isPending ? <div className={styles.loading} role="status"><Activity size={20} aria-hidden="true" /><p>{t("正在加载工作区动态…", "Loading workspace activity…")}</p></div>
          : visible.length > 0 ? groups.map(group => {
            const heading = group.day === null ? t("日期未知", "Unknown date")
              : group.day === currentDay ? t("今天", "Today")
                : group.day === currentDay - dayMilliseconds ? t("昨天", "Yesterday")
                  : dateFormatter.format(new Date(group.entries[0].occurredAt))
            return <section key={group.day ?? "unknown"} className={styles.dayGroup} aria-label={heading}>
              <h2 className={styles.dayHeading}>{heading}</h2>
              <ol className={styles.feed}>{group.entries.map(entry => <ActivityRow key={entry.id} entry={entry} actorId={activity.actorId} people={people} root={root} returnTo={returnTo} now={now} timestampFormatter={timestampFormatter} relativeFormatter={relativeFormatter} timeZone={timeZone} t={t} />)}</ol>
            </section>
          }) : !activity.error && <div className={styles.empty} role="status">
            <Activity size={24} strokeWidth={1.5} aria-hidden="true" />
            <h2>{activity.entries.length > 0 ? t("没有符合条件的动态", "No matching activity") : t("暂无可见动态", "No activity yet")}</h2>
            <p>{activity.entries.length > 0 ? t("试试其他动态类型或人员。", "Try a different activity type or person.") : t("可访问的任务和项目变化将显示在这里。", "Visible changes to tasks and projects will appear here.")}</p>
            {activeConditions > 0 && <button type="button" onClick={() => setConditions([])}>{t("清除筛选", "Clear filters")}</button>}
          </div>}
      </div>
      <footer className={styles.boundary}>
        <p>{t("仅显示当前有权访问的记录，不代表完整历史；查看动态不会改变任务或通知状态。", "Visible, authorized records only—not a complete history. Viewing activity never changes tasks or notification state.")}</p>
        {activity.notices.length > 0 && <details><summary>{t("历史与可见范围", "History & visibility")}</summary><ul>{activity.notices.map((notice, index) => <li key={`${index}:${notice}`}>{notice}</li>)}</ul></details>}
      </footer>
    </div>
  </section>
}

/** Values inside one condition are OR; conditions are AND; unknown fields never match. */
function matchesActivityCondition(entry: ActivityEntry, condition: FilterCondition) {
  if (!condition.values.length) return true
  const matched = condition.values.some(value =>
    condition.field === "person"
      ? entry.actorId === value
      : value === "status"
        ? entry.category === "status" || !!entry.changes?.some(change => change.field === "status" && change.before !== null && change.after !== null && change.before !== change.after)
        : value === "comments"
          ? entry.category === "comments"
          : value === "projects" && entry.targetKind === "project",
  )
  return condition.operator === "is" ? matched : !matched
}

function calendarDay(timestamp: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(timestamp)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(value => value.type === type)?.value)
  return Date.UTC(part("year"), part("month") - 1, part("day"))
}

function relativeTime(timestamp: number, now: number, formatter: Intl.RelativeTimeFormat, t: Text) {
  const seconds = (timestamp - now) / 1_000
  const magnitude = Math.abs(seconds)
  if (magnitude < 60) return t("刚刚", "Just now")
  if (magnitude < 3_600) return formatter.format(Math.trunc(seconds / 60), "minute")
  if (magnitude < 86_400) return formatter.format(Math.trunc(seconds / 3_600), "hour")
  if (magnitude < 2_592_000) return formatter.format(Math.trunc(seconds / 86_400), "day")
  if (magnitude < 31_536_000) return formatter.format(Math.trunc(seconds / 2_592_000), "month")
  return formatter.format(Math.trunc(seconds / 31_536_000), "year")
}

function ActivityRow({ entry, actorId, people, root, returnTo, now, timestampFormatter, relativeFormatter, timeZone, t }: {
  entry: ActivityEntry
  actorId: string | undefined
  people: ReadonlyMap<string, string>
  root: string
  returnTo: string
  now: number
  timestampFormatter: Intl.DateTimeFormat
  relativeFormatter: Intl.RelativeTimeFormat
  timeZone: string
  t: Text
}) {
  const self = entry.actorId !== null && entry.actorId === actorId
  const knownName = entry.actorName || (entry.actorId ? people.get(entry.actorId) : null)
  const name = self ? t("你", "You") : knownName || t("未知操作者", "Someone")
  const title = entry.targetTitle || entry.targetId || t("未知对象", "Unknown target")
  const timestamp = Date.parse(entry.occurredAt)
  const absolute = Number.isFinite(timestamp) ? `${timestampFormatter.format(timestamp)} · ${timeZone}` : t("时间未知", "Time unknown")
  const relative = Number.isFinite(timestamp) ? relativeTime(timestamp, now, relativeFormatter, t) : t("时间未知", "Time unknown")
  const diffs = entry.changes?.filter(change => change.field === "status" && change.before !== null && change.after !== null && change.before !== change.after) ?? []
  const projectHref = entry.projectId ? `${root}/projects/${encodeURIComponent(entry.projectId)}?${new URLSearchParams({ returnTo })}` : null
  const projectTitle = entry.projectTitle || entry.projectId
  const valueLabel = (value: string | number | boolean | null) => value === null ? t("未记录", "Not recorded") : typeof value === "boolean" ? value ? t("是", "Yes") : t("否", "No") : String(value)
  const action = actionLabels[entry.action]
  const verb = action ? t(...action) : entry.category === "status" ? t("更改了状态，位于", "changed the status of") : t("记录了动态，位于", "recorded activity on")
  return <li className={styles.row} data-activity-source={entry.source}>
    <span className={styles.avatar} aria-hidden="true"><Avatar size={20} name={knownName || name} initials={!knownName && !self ? "?" : undefined} /></span>
    <div className={styles.rowMain}>
      <span className={styles.actor} title={knownName || t("未记录操作者", "Actor not recorded")}>{name}</span>{" "}<span className={styles.verb} title={entry.action}>{verb}</span>{" "}
      {entry.href ? <Link className={styles.target} to={entry.href} state={{ returnTo }} title={`${title} · ${entry.targetId}`}>{title}</Link> : <span className={styles.targetUnavailable} title={t("目标不存在或当前不可访问", "Target no longer exists or is not currently accessible")}>{title}</span>}
      {projectTitle && entry.targetKind !== "project" && <span className={styles.projectContext}>{" "}{t("位于", "in")}{" "}{projectHref ? <Link to={projectHref} state={{ returnTo }}>{projectTitle}</Link> : projectTitle}</span>}
      {diffs.length > 0 && <span className={styles.statusChanges}>{diffs.map((change, index) => <span className={styles.statusDiff} key={`${change.field}:${index}`} aria-label={`${t("状态", "Status")}: ${valueLabel(change.before)} → ${valueLabel(change.after)}`}><span>{valueLabel(change.before)}</span><ArrowRight size={11} aria-hidden="true" /><span>{valueLabel(change.after)}</span></span>)}</span>}
      {entry.source === "changes" && <span className={styles.observed} title={t("保留的服务事件不是完整审计记录；未推断操作者或字段差异。", "A retained service event is not a full audit record; actor and field differences are not inferred.")}>{t("服务事件", "Service event")}</span>}
    </div>
    <time className={styles.time} dateTime={Number.isFinite(timestamp) ? entry.occurredAt : undefined} title={absolute} tabIndex={0} aria-label={`${relative} · ${absolute}`}>{relative}<span className={styles.absolute} aria-hidden="true">{absolute}</span></time>
  </li>
}
