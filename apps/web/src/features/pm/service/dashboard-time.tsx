import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { type Entity, type TimeDashboard } from "@contracts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { PmCommandStore } from "./pm-command-store"
import { usePmService, useTimeDashboard } from "./pm-service"
import { Choice, CommandNotice, Field, Form, makeCommand, useAction, useDraftState, useText } from "./pm-ui"

export type TimerPanelProps = { issues?: Entity[]; className?: string }
export type TimeTrackingPanelProps = { issues?: Entity[]; className?: string }
export type PresencePanelProps = { className?: string }

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}

type TimeQuery = { data: TimeDashboard | undefined; isPending: boolean; error: Error | null; refetch: () => unknown }
function TimeReadNotice({ query }: { query: TimeQuery }) {
  const t = useText()
  return <>{query.isPending && !query.data && <p role="status">{t("加载中…", "Loading…")}</p>}{query.error && <div role="alert" className="space-y-2 text-sm"><p>{query.data ? t("上次快照可能已过期：", "Previous snapshot may be stale: ") : ""}{query.error.message}</p><Button size="sm" variant="outline" onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>}</>
}

export function TimerPanel({ issues = [], className = "" }: TimerPanelProps) {
  const query = useTimeDashboard(), action = useAction(), t = useText()
  const [taskId, setTaskId] = useDraftState("dashboard-timer", "task", "")
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(() => performance.now())
  const anchor = useMemo(() => ({ instant: Date.parse(query.data?.serverNow ?? ""), received: performance.now() }), [query.data?.serverNow])
  const timer = query.data?.activeTimer
  useEffect(() => {
    if (!timer) return
    const interval = window.setInterval(() => setTick(performance.now()), 1000)
    return () => window.clearInterval(interval)
  }, [timer?.id])
  const selected = issues.some(issue => issue.id === taskId) ? taskId : issues[0]?.id ?? ""
  const elapsed = timer ? Math.max(0, anchor.instant + Math.max(0, tick - anchor.received) - Date.parse(timer.startedAt)) : 0
  return <section className={`min-w-0 space-y-3 ${className}`} aria-label={t("计时器", "Timer")}>
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{t("计时器", "Timer")}</h3><span className="text-xs text-muted-foreground">{t("服务器计时", "Server clock")}</span></div>
    <TimeReadNotice query={query} />
    {query.data && <><p className="font-mono text-3xl tabular-nums" aria-live="off">{duration(elapsed)}</p><p className="truncate text-sm">{timer ? timer.task.title ?? t("任务已不可访问 · 仍可停止", "Task unavailable · you can still stop") : t("没有正在运行的计时器", "No running timer")}</p>
      {timer ? <Button size="sm" disabled={action.locked || !!query.error} onClick={() => { void action.run(() => action.execute({ commandId: crypto.randomUUID(), commandType: "StopTimer", targetId: timer.id, expectedVersions: { [timer.id]: timer.version }, payload: {} })) }}>{t("停止并记录工时", "Stop and log time")}</Button> : <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button size="sm" disabled={action.locked || !!query.error || !issues.length} />}>{t("开始计时", "Start timer")}</DialogTrigger><DialogContent><DialogTitle>{t("开始任务计时", "Start task timer")}</DialogTitle><DialogDescription>{t("开始时间由服务器记录；刷新不会重置计时器。", "The server records the start. Refreshing will not reset it.")}</DialogDescription><Form disabled={action.locked || !selected} label={t("开始", "Start")} onSubmit={async () => { await action.execute(makeCommand("StartTimer", { taskId: selected })); setOpen(false) }}><Choice label={t("任务", "Task")} value={selected} onChange={setTaskId} options={issues.map(issue => ({ value: issue.id, label: `${issue.id} · ${String(issue.data.title ?? issue.id)}` }))} /></Form></DialogContent></Dialog>}
      {!timer && !issues.length && <p className="text-xs text-muted-foreground">{t("需要一个当前可访问的任务。", "An accessible task is required.")}</p>}</>}
    {action.localError && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}<CommandNotice />
  </section>
}

export function TimeTrackingPanel({ issues = [], className = "" }: TimeTrackingPanelProps) {
  const query = useTimeDashboard(), action = useAction(), t = useText()
  const display = useDisplayDateTime(query.data?.timeZone)
  const [taskId, setTaskId] = useDraftState("dashboard-manual-time", "task", "")
  const [startedAt, setStartedAt] = useDraftState("dashboard-manual-time", "start", "")
  const [endedAt, setEndedAt] = useDraftState("dashboard-manual-time", "end", "")
  const [note, setNote] = useDraftState("dashboard-manual-time", "note", "")
  const [open, setOpen] = useState(false)
  const selected = issues.some(issue => issue.id === taskId) ? taskId : issues[0]?.id ?? ""
  return <section className={`min-w-0 space-y-3 ${className}`} aria-label={t("工时记录", "Time tracking")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t("工时记录", "Time tracking")}</h3><Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button size="sm" variant="outline" disabled={!query.data} />}>{t("记录与历史", "Log and history")}</DialogTrigger><DialogContent className="max-w-xl"><DialogTitle>{t("我的工时", "My worklogs")}</DialogTitle><DialogDescription>{t("记录不可修改。补录使用带 UTC 偏移的真实起止时间，避免夏令时歧义。", "Worklogs are immutable. Enter actual timestamps with UTC offsets to avoid DST ambiguity.")}</DialogDescription><div className="mt-4 space-y-5">
      <Form title={t("人工补录", "Manual interval")} disabled={action.locked || !selected || !!query.error} label={t("记录工时", "Record time")} onSubmit={async () => { await action.execute(makeCommand("RecordManualWorklog", { taskId: selected, startedAt, endedAt, note })); setStartedAt(""); setEndedAt(""); setNote("") }}>
        <Choice label={t("任务", "Task")} value={selected} onChange={setTaskId} options={issues.map(issue => ({ value: issue.id, label: `${issue.id} · ${String(issue.data.title ?? issue.id)}` }))} />
        <Field label={t("开始（例 2026-10-20T09:00:00+08:00）", "Start (e.g. 2026-10-20T09:00:00+08:00)")} value={startedAt} onChange={setStartedAt} required /><Field label={t("结束（含 UTC 偏移）", "End (include UTC offset)")} value={endedAt} onChange={setEndedAt} required /><Field label={t("说明", "Note")} value={note} onChange={setNote} />
      </Form>
      <div className="space-y-2"><h4 className="font-medium">{t("不可变历史", "Immutable history")}</h4>{query.data?.worklogs.length === 0 && <p className="text-sm text-muted-foreground">{t("尚无工时记录。", "No worklogs yet.")}</p>}{query.data?.worklogs.map(log => <article key={log.id} className="min-w-0 space-y-1 rounded-md border p-3 text-sm"><p className="break-words font-medium">{log.task.title ?? t("任务已不可访问", "Task unavailable")} · {duration(log.durationMs)}</p><p className="break-words text-xs text-muted-foreground">{display.dateTime(log.startedAt)} → {display.dateTime(log.endedAt)} · {log.source}</p>{log.note && <p className="break-words">{log.note}</p>}</article>)}</div><CommandNotice />
    </div></DialogContent></Dialog></div>
    <TimeReadNotice query={query} />{query.data && <div className="grid grid-cols-3 gap-3">{([['day', t("今日", "Today")], ['week', t("本周", "This week")], ['month', t("本月", "This month")]] as const).map(([period, label]) => <div key={period} className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="font-mono text-lg tabular-nums">{(query.data!.totals[period].durationMs / 3_600_000).toFixed(2)}h</p></div>)}</div>}
  </section>
}

/** A distinct persistent namespace prevents background heartbeats from replacing
 * the interactive unknown-command journal. Unknown writes only query receipts. */
const heartbeatStores = new Map<string, PmCommandStore>()
function usePresenceHeartbeat(query: TimeQuery) {
  const { client, actor, workspace, actorEpoch } = usePmService()
  const instance = window.location.origin
  let store = heartbeatStores.get(instance)
  if (!store) { store = new PmCommandStore(`${instance}/dashboard-presence-heartbeat`); heartbeatStores.set(instance, store) }
  const heartbeatStore = store
  const scope = actor && workspace ? `${actor.id}:${workspace.id}` : null
  const readable = !!query.data && !query.error
  const getSnapshot = useCallback(() => heartbeatStore.getSnapshot(scope), [heartbeatStore, scope])
  const state = useSyncExternalStore(heartbeatStore.subscribe, getSnapshot, getSnapshot)
  const [ready, setReady] = useState<string | null>(null)
  const [recoveryError, setRecoveryError] = useState<Error | null>(null)
  const latestQuery = useRef(query)
  useEffect(() => { latestQuery.current = query }, [query])
  useEffect(() => {
    if (!actor || !scope) return
    let cancelled = false
    void heartbeatStore.restore(actor.id).then(() => { if (!cancelled) { setReady(`${scope}:${actorEpoch}`); setRecoveryError(null) } }).catch((error: unknown) => { if (!cancelled) { setReady(null); setRecoveryError(error instanceof Error ? error : new Error(String(error))) } })
    return () => { cancelled = true }
  }, [actor?.id, actorEpoch, heartbeatStore, scope])
  const settle = useCallback(() => { void latestQuery.current.refetch() }, [])
  useEffect(() => {
    if (!actor || !workspace || !scope || ready !== `${scope}:${actorEpoch}`) return
    let cancelled = false
    const pulse = async () => {
      if (cancelled || document.visibilityState !== "visible" || !navigator.onLine) return
      const current = heartbeatStore.getSnapshot(scope)
      if (current.pending) return
      try {
        if (current.unknownCommand) { await heartbeatStore.reconcile(scope, workspace.id, client, settle, () => {}); return }
        const snapshot = latestQuery.current
        if (!snapshot.data || snapshot.error) return
        const self = snapshot.data.presence.self
        await heartbeatStore.execute(scope, workspace.id, { commandId: crypto.randomUUID(), commandType: "HeartbeatPresence", payload: {}, ...(self.heartbeatId ? { targetId: self.heartbeatId, expectedVersions: { [self.heartbeatId]: self.heartbeatVersion! } } : {}) }, client, settle, () => {})
      } catch { /* Store retains the real error and original unknown command. */ }
    }
    void pulse()
    const interval = window.setInterval(() => { void pulse() }, 25_000)
    document.addEventListener("visibilitychange", pulse)
    return () => { cancelled = true; window.clearInterval(interval); document.removeEventListener("visibilitychange", pulse) }
  }, [actor?.id, actorEpoch, client, heartbeatStore, readable, ready, scope, settle, workspace?.id])
  return { ...state, error: recoveryError ?? state.error, reconcile: async () => { if (workspace && scope) await heartbeatStore.reconcile(scope, workspace.id, client, settle, () => {}) } }
}

export function DashboardPresenceHeartbeat() {
  const query = useTimeDashboard(), t = useText()
  const heartbeat = usePresenceHeartbeat(query)
  useEffect(() => {
    const interval = window.setInterval(() => { void query.refetch() }, 30_000)
    return () => window.clearInterval(interval)
  }, [query.refetch])
  if (!heartbeat.error && !heartbeat.unknownCommand) return null
  return <div className="min-w-0 space-y-2">
    {heartbeat.error && <p role="alert" className="break-words text-xs text-destructive">{t("心跳：", "Heartbeat: ")}{heartbeat.error.message}</p>}
    {heartbeat.unknownCommand && <Button size="sm" variant="outline" disabled={heartbeat.pending} onClick={() => { void heartbeat.reconcile().catch(() => {}) }}>{t("核对心跳收据", "Reconcile heartbeat receipt")}</Button>}
  </div>
}

export function PresencePanel({ className = "" }: PresencePanelProps) {
  const query = useTimeDashboard(), action = useAction(), t = useText()
  const self = query.data?.presence.self
  const labels = { online: t("在线", "Online"), away: t("离开", "Away"), offline: t("离线", "Offline") }
  return <section className={`min-w-0 space-y-3 ${className}`} aria-label={t("在线状态", "Presence")}>
    <h3 className="font-medium">{t("在线状态", "Presence")}</h3><TimeReadNotice query={query} />
    {self && <><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{t("我的状态", "My status")}: {labels[self.status]}</p><select aria-label={t("我的在线意图", "My presence preference")} value={self.preference} disabled={action.locked || !!query.error} className="min-h-9 rounded-md border bg-background px-2 text-sm" onChange={event => { const preference = event.target.value as "online" | "away"; void action.run(() => action.execute({ commandId: crypto.randomUUID(), commandType: "SetPresencePreference", payload: { preference }, ...(self.preferenceId ? { targetId: self.preferenceId, expectedVersions: { [self.preferenceId]: self.preferenceVersion! } } : {}) })) }}><option value="online">{labels.online}</option><option value="away">{labels.away}</option></select></div>
      <p className="text-xs text-muted-foreground">{t("心跳超过90秒即离线；其他标签页不会覆盖离开意图。", "Offline after 90s without a heartbeat; other tabs cannot overwrite away intent.")}</p>
      {query.data!.presence.directoryVisible ? <ul className="space-y-2">{query.data!.presence.members.map(member => <li key={member.userId} className="flex min-w-0 justify-between gap-2 text-sm"><span className="truncate">{member.name}</span><span className="text-muted-foreground">{labels[member.status]}</span></li>)}</ul> : <p className="text-xs text-muted-foreground">{t("仅显示本人；成员目录需要 access.manage。", "Self only; the member directory requires access.manage.")}</p>}</>}
    {action.localError && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}<CommandNotice />
  </section>
}
