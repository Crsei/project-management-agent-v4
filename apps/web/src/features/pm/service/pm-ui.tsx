import { useEffect, useId, useRef, useState, type ReactNode, type FormEvent } from "react"
import { z } from "zod"
import type { Command, CommandType, CommandPayloadMap, Entity, Workspace, Member } from "@contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n-provider"
import type { ControlledIssueRecord, ControlledIssueCatalog, PmControlledData } from "@/views/pm/controlled-contracts"
import type { ProjectCollectionRecord } from "@/views/pm/project-collection-contracts"
import { usePmCommand, usePmService } from "./pm-service"
import { usePmNoticeCenter } from "./pm-notice-center"
import { LocalProjectCommandRecovery } from "./local-project-command-recovery"
import { RadixSelect } from "@/components/ui/radix-select"

// In-memory editor state is deliberately separate from authoritative Query data.
// It survives view switches/remounts, and is partitioned by actor and workspace.
const retainedDrafts = new Map<string, unknown>()
export function useDraftState<T>(scope: string, field: string, initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
  const { actor, workspace } = usePmService()
  const key = `${actor?.id ?? "anonymous"}:${workspace?.id ?? "none"}:${scope}:${field}`
  const [, redraw] = useState(0)
  if (!retainedDrafts.has(key)) retainedDrafts.set(key, typeof initial === "function" ? (initial as () => T)() : initial)
  // Entries only originate from this typed hook; this is in-process state, not parsed input.
  const value = retainedDrafts.get(key) as T
  const setValue = (next: T | ((previous: T) => T)) => {
    const previous = retainedDrafts.get(key) as T
    retainedDrafts.set(key, typeof next === "function" ? (next as (previous: T) => T)(previous) : next)
    redraw(version => version + 1)
  }
  return [value, setValue]
}
export const entityReference = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, 'Expected an entity ID')
export const criterionReference = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+(?:-AC-\d+)?|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, 'Expected a criterion ID')
export const entitySchema = z.object({ id: entityReference, workspaceId: z.string().uuid(), projectId: entityReference.nullable(), kind: z.enum(["project", "work_item", "milestone", "conversation", "intent", "decision", "upload", "artifact", "artifact_version", "evidence", "submission", "review"]), version: z.number().int(), data: z.record(z.string(), z.unknown()), createdAt: z.string().nullable(), updatedAt: z.string().nullable(), createdBy: z.string() })
export function useText() { const { locale } = useI18n(); return (zh: string, en: string) => locale === "en" ? en : zh }
export const string = (value: unknown) => typeof value === "string" ? value : ""
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
export const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object") : []
export const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean)
export const today = () => new Date().toISOString().slice(0, 10)
export const required = z.string().trim().min(1).max(16000)
export const uuid = z.string().uuid()
export const nullableUuid = z.union([uuid, z.literal("")]).transform(value => value || null)
export function allowed(workspace: Workspace | null, capability: string, projectId?: string | null) { return !!workspace?.capabilities.includes(capability) && (workspace.projectIds === null || !!projectId && workspace.projectIds.includes(projectId)) }
export const writable = (entity?: Entity) => !!entity && !entity.data.archivedAt
export function makeCommand<K extends CommandType>(commandType: K, payload: CommandPayloadMap[K], entity?: Entity, projectId?: string, other: Entity[] = []): Command {
  return { commandId: crypto.randomUUID(), commandType, payload, ...(entity ? { targetId: entity.id } : {}), ...(projectId ? { projectId } : {}), expectedVersions: Object.fromEntries([...(entity ? [entity] : []), ...other].map(item => [item.id, item.version])) } as Command
}
export function useAction() {
  const command = usePmCommand(); const [localError, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => { setError(null); try { return await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)); return undefined } }
  return { ...command, localError, setError, run, locked: command.pending || !!command.unknownCommand }
}
/** Command feedback lives in the top-right notice center; this keeps existing page composition unchanged. */
export function CommandNotice() {
  return null
}
/** Workspace-level recovery stays reachable after refresh without shifting page layout. */
export function PmCommandRecovery() {
  const command = usePmCommand(); const en = useI18n().locale === "en"
  const { actor, actorEpoch, capabilities } = usePmService()
  const { upsert, resolve } = usePmNoticeCenter()
  const lastKey = useRef<string | null>(null)
  const unknown = command.unknownCommand
  const message = command.error && !unknown ? command.error.message : null
  useEffect(() => {
    if (message) upsert({ key: "command:error", severity: "error", title: en ? "Command failed" : "命令未完成", detail: message, source: "command" })
    else resolve("command:error")
  }, [en, message, resolve, upsert])
  useEffect(() => {
    if (!unknown) {
      if (lastKey.current) resolve(lastKey.current)
      lastKey.current = null
      return
    }
    const key = `command:unknown:${unknown.commandId}`
    if (lastKey.current && lastKey.current !== key) resolve(lastKey.current)
    lastKey.current = key
    const local = unknown.commandType === "CreateProject" && (capabilities?.localProjects.enabled || "localDirectory" in unknown.payload)
    upsert({
      key,
      severity: "error",
      title: en ? "Command outcome unknown" : "命令结果未知",
      detail: `${unknown.commandType} · ${unknown.commandId}${command.error ? ` · ${command.error.message}` : ""}`,
      source: "command",
      sticky: true,
      action: { label: command.pending ? (en ? "Checking original command…" : "正在核对原命令…") : (en ? "Check original command receipt" : "查询原命令收据"), run: () => { void command.reconcile().catch(() => undefined) } },
      content: local ? <LocalProjectCommandRecovery key={`${actor?.id}:${actorEpoch}:${unknown.commandId}`} commandId={unknown.commandId} /> : undefined,
    })
  }, [actor?.id, actorEpoch, capabilities?.localProjects.enabled, command.error, command.pending, command.reconcile, en, resolve, unknown, upsert])
  return null
}
export function Field({ label, value, onChange, multiline = false, type = "text", required: needed = false, disabled = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; type?: string; required?: boolean; disabled?: boolean }) { return <label className="grid min-w-0 gap-1 text-sm"><span>{label}</span>{multiline ? <Textarea value={value} onChange={event => onChange(event.target.value)} required={needed} disabled={disabled} /> : <Input type={type} value={value} onChange={event => onChange(event.target.value)} required={needed} disabled={disabled} />}</label> }
export function Choice({ label, value, onChange, options, disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) { return <label className="grid gap-1 text-sm"><span>{label}</span><RadixSelect className="min-h-9 rounded-md border bg-background px-2" value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</RadixSelect></label> }
export function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="min-w-0 space-y-4 rounded-lg border bg-surface p-4"><h2 className="text-base font-medium">{title}</h2>{children}</section> }
export function Form({ title, onSubmit, children, disabled = false, label }: { title?: string; onSubmit: () => Promise<unknown>; children: ReactNode; disabled?: boolean; label?: string }) {
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const t = useText()
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy || disabled) return; setBusy(true); setError(null); try { await onSubmit() } catch (error) { setError(error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  return <form onSubmit={submit} className="space-y-3">{title && <h3 className="font-medium">{title}</h3>}<fieldset disabled={disabled || busy} className="space-y-3">{children}<Button type="submit">{label ?? t("保存", "Save")}</Button></fieldset>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</form>
}
export type QueryState = { data: unknown[] | undefined; isPending: boolean; isFetching: boolean; error: Error | null; refetch: () => unknown }
export function queryData(query: QueryState, count = query.data?.length ?? 0): PmControlledData { return { state: query.error ? "error" : query.data ? count ? "success" : "empty" : "loading", refreshing: query.isFetching && !!query.data, error: query.error ? { category: "request", message: query.error.message, reason: query.data ? "The previous snapshot is retained and may be stale." : "No service snapshot is available." } : undefined, onRetry: () => { void query.refetch() } } }
/** Supplemental query status is visible in the notice center, never as an extra line in the page. */
export function usePmReadStatus({ label, query, source = "read" }: { label: string; query: Pick<QueryState, "isPending" | "error" | "refetch"> & { data: unknown }; source?: string }) {
  const en = useI18n().locale === "en"
  const { upsert, resolve } = usePmNoticeCenter()
  const id = useId()
  const refetch = useRef(query.refetch); refetch.current = query.refetch
  const pendingKey = `read:${id}:pending`
  const errorKey = `read:${id}:error`
  const pending = query.isPending && !query.data
  const message = query.error?.message ?? null
  useEffect(() => {
    if (pending) upsert({ key: pendingKey, severity: "info", title: `${label} · ${en ? "Loading…" : "正在读取…"}`, source, silent: true, transient: true })
    else resolve(pendingKey)
    if (message) upsert({ key: errorKey, severity: "error", title: `${label} · ${query.data ? (en ? "Refresh failed" : "刷新失败") : (en ? "Read failed" : "读取失败")}`, detail: `${message}${query.data ? (en ? " The previous snapshot is retained and may be stale." : " 已保留上次快照，可能已过期。") : ""}`, source, sticky: true, action: { label: en ? "Retry read" : "重试读取", run: () => { void refetch.current() } } })
    else resolve(errorKey)
  }, [en, errorKey, label, message, pending, pendingKey, query.data, resolve, source, upsert])
}
export function QueryNotice({ query, children, label }: { query: QueryState; children?: ReactNode; label?: string }) {
  const t = useText()
  usePmReadStatus({ label: label ?? t("数据", "Data"), query })
  return <>{query.data && query.data.length === 0 && <p>{t("没有记录。", "No records.")}</p>}{query.data && children}</>
}
export function issueRecord(entity: Entity): ControlledIssueRecord { return { id: entity.id, projectId: entity.projectId!, identifier: entity.id, title: string(entity.data.title), description: string(entity.data.description), stateId: string(entity.data.status), priorityId: string(entity.data.priority), assigneeIds: entity.data.assigneeId ? [string(entity.data.assigneeId)] : [], labelIds: [], startDate: string(entity.data.startDate) || null, dueDate: string(entity.data.dueDate) || null, revision: entity.version, version: String(entity.version), sourceRevision: Number(entity.data.contentRevision), moduleIds: [], cycleId: null, estimatePointId: null } }
export const states = ["draft", "ready", "in_progress", "in_review", "done", "cancelled"]
export function catalog(projects: Entity[], members: Member[] = []): ControlledIssueCatalog { return { states: states.map(id => ({ id, label: id, category: id === "done" ? "completed" : "started" })), priorities: ["low", "normal", "high", "urgent"].map(id => ({ id, label: id })), assignees: members.filter(member => !member.revokedAt).map(member => ({ id: member.userId, label: member.name })), labels: [], projects: projects.map(project => ({ id: project.id, label: string(project.data.name) })), modules: [], cycles: [], estimatePoints: [] } }
export function projectRecord(entity: Entity, items?: Entity[], members: Member[] = []): ProjectCollectionRecord {
  const scoped = items?.filter(item => item.projectId === entity.id)
  const ownerId = string(entity.data.ownerId)
  const total = scoped?.length ?? null
  const closed = scoped?.filter(item => item.data.status === "done").length ?? null
  const health = total ? Math.round(((closed ?? 0) / total) * 100) : null
  const start = string(entity.data.startDate) || null
  const due = string(entity.data.dueDate) || null
  const cycleWeeks = start && due ? Math.max(1, Math.round((Date.parse(due) - Date.parse(start)) / 604_800_000)) : null
  const cycleValue = string(entity.data.cycle)
  return {
    id: entity.id, identifier: entity.id, title: string(entity.data.name), description: string(entity.data.goal),
    owner: ownerId ? { id: ownerId, name: members.find(member => member.userId === ownerId)?.name ?? ownerId, role: null } : null,
    status: { value: string(entity.data.status), label: string(entity.data.status), tone: "neutral" },
    cycle: cycleValue ? { value: cycleValue, label: cycleValue } : null,
    cycleWeeks, teamSize: null, health, dueDate: due, archived: !!entity.data.archivedAt,
    artwork: null, starred: null, teamId: null, milestone: null,
    taskCounts: scoped ? { closed: closed ?? 0, total: scoped.length } : null,
    updatedAt: entity.updatedAt && Number.isFinite(Date.parse(entity.updatedAt)) ? entity.updatedAt : null,
  }
}
export const readOnlyIssues = { canCreate: false, canEditField: () => false, canMove: () => false, canEditRelation: () => false }
export function Unsupported() { const t = useText(); return <p className="text-sm text-muted-foreground">{t("邮件邀请需配置 SMTP；邮件收件箱与 Agent 执行未接入。团队归属不自动授予项目权限。", "Email invitations require SMTP configuration; inbox integration and Agent execution are unavailable. Team membership never grants project access.")}</p> }
export function ServiceGuard({ children }: { children: ReactNode }) { const { actor, workspace, loading, error } = usePmService(); const t = useText(); if (loading) return <p role="status">{t("加载会话…", "Loading session…")}</p>; if (!actor) return <a href="/pm">{t("登录", "Sign in")}</a>; if (!workspace) return <div role="alert">{error?.message ?? t("工作区不可访问。", "Workspace unavailable.")} <a href="/pm?pick=1">{t("选择工作区", "Choose workspace")}</a></div>; return <>{children}</> }
