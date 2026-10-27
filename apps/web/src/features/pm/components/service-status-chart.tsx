import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { Entity } from "@contracts"
import { useI18n } from "@/lib/i18n-provider"
import { Button } from "@/components/ui/button"
import { statusLabel, workItemStatuses } from "./service-collection-shared"

export function ServiceStatusChart({ items, onSelect }: { items: Entity[] | undefined; onSelect: (state: string) => void }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const data = useMemo(() => workItemStatuses.map(state => ({ state, name: statusLabel(state, locale), count: items?.filter(item => item.data.status === state).length ?? null })), [items, locale])
  return <section className="min-w-0 rounded-module border bg-surface p-4">
    <h2 className="mb-3 font-medium">{en ? "Task status distribution" : "任务状态分布"}</h2>
    {items ? <><div className="h-60 w-full" aria-hidden="true"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 12, right: 12, bottom: 12, left: 0 }}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="name" tick={{ fill: "var(--text-secondary)", fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fill: "var(--text-secondary)", fontSize: 12 }} width={32} /><Tooltip contentStyle={{ background: "var(--surface)", borderColor: "var(--border)", borderRadius: 6 }} /><Bar dataKey="count" name={en ? "Tasks" : "任务"} fill="var(--chart-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{data.map(row => <Button key={row.state} variant="ghost" className="justify-between" onClick={() => onSelect(row.state)}><span>{row.name}</span><span className="tabular-nums">{row.count}</span></Button>)}</div></> : <p role="status" className="text-sm text-muted-foreground">{en ? "Loading authoritative counts…" : "正在读取权威统计…"}</p>}
    <p className="mt-3 text-xs text-muted-foreground">{en ? "Counts use the current authorized task collection; no invented trends or effort estimates." : "统计来自当前授权任务集合；不伪造趋势或工时。"}</p>
  </section>
}
