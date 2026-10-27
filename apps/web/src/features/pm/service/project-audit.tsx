import { Button } from "@/components/ui/button"
import { useProjectAudit, usePmService } from "./pm-service"
import { allowed, useText } from "./pm-ui"

export type ProjectAuditHistoryProps = { projectId: string }

/** Business audit is durable controlled-write history, not the file watcher's recent-update feed. */
export function ProjectAuditHistory({ projectId }: ProjectAuditHistoryProps) {
  const { workspace } = usePmService()
  const query = useProjectAudit(projectId)
  const t = useText()
  const canRead = allowed(workspace, "domain.read", projectId) && allowed(workspace, "audit.read", projectId)
  if (!canRead) return <section aria-label={t("项目业务审计", "Project business audit")} className="space-y-2 text-sm"><p>{t("需要此项目的 audit.read 及 domain.read 权限才能读取业务审计。", "Project audit.read and domain.read permissions are required to read business audit history.")}</p></section>
  if (query.isPending) return <p role="status" className="text-sm">{t("加载项目审计…", "Loading project audit…")}</p>
  if (query.error) return <div role="alert" className="space-y-2 text-sm"><p>{query.error.message}</p><Button variant="outline" onClick={() => { void query.refetch() }}>{t("重试读取审计", "Retry audit read")}</Button></div>
  const entries = query.data?.pages.flatMap(page => page.entries) ?? []
  return <section aria-label={t("项目业务审计", "Project business audit")} className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><p className="max-w-2xl text-xs text-muted-foreground">{t("仅记录此能力上线后的受控业务写入；不补造旧记录或外部文件编辑的操作者。正文、便签、消息和文件内容不在审计差异中。", "Records controlled business writes since audit activation; historical and external file edits are not attributed to users. Body text, notes, messages and file content are excluded from field diffs.")}</p><Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{t("刷新审计", "Refresh audit")}</Button></div>
    {entries.length === 0 ? <p className="text-sm text-muted-foreground">{t("暂无可见的受控业务审计记录。", "No visible controlled-write audit entries yet.")}</p> : <ol className="space-y-3">{entries.map(entry => <li key={entry.id} className="min-w-0 space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><p className="break-words font-medium">{entry.action}</p><time dateTime={entry.occurredAt} className="text-xs text-muted-foreground">{new Date(entry.occurredAt).toLocaleString()}</time></div>
      <p className="break-all text-xs text-muted-foreground">{entry.targetKind} · {entry.targetId} · {entry.source === "core_http" ? t("原生核心 API", "Native core API") : t("业务命令", "Business command")}{entry.private && ` · ${t("仅本人可见", "Private to original actor")}`}</p>
      <p className="break-all text-xs">{t("操作者", "Actor")}: {entry.actorId}</p>
      <p className="break-all text-xs text-muted-foreground">{t("版本", "Version")}: <span title={entry.beforeVersion ?? ""}>{entry.beforeVersion ?? "∅"}</span> → <span title={entry.afterVersion ?? ""}>{entry.afterVersion ?? "∅"}</span></p>
      {entry.changes.length > 0 ? <dl className="space-y-1 rounded bg-muted/50 p-2 text-xs">{entry.changes.map(change => <div key={change.field} className="grid min-w-0 gap-1 sm:grid-cols-[minmax(6rem,1fr)_minmax(0,2fr)]"><dt className="break-all font-medium">{change.field}</dt><dd className="break-words">{change.before === null ? "∅" : String(change.before)} → {change.after === null ? "∅" : String(change.after)}</dd></div>)}</dl> : <p className="text-xs text-muted-foreground">{t("该写入没有可公开的白名单字段差异；内容未记录。", "This write has no safe allowlisted field diff; content was not recorded.")}</p>}
      <p className="break-all text-[11px] text-muted-foreground">{t("命令 / 请求", "Command / request")}: {entry.commandId}</p>
    </li>)}</ol>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage() }}>{query.isFetchingNextPage ? t("加载更早记录…", "Loading older entries…") : t("加载更早记录", "Load older entries")}</Button>}
  </section>
}
