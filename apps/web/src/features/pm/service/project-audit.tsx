import { useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { Activity, ArrowUpRight, FileText, Folder, ListTodo, Lock, MessageSquare, RefreshCw, ShieldAlert, Star } from "lucide-react"
import { entityKinds, type EntityKind } from "@pm-schema"
import type { ProjectAuditEntry } from "@contracts"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { PmSearch } from "@/views/pm/presentation-page"
import { actionLabels } from "./activity-action-labels"
import { ActivityTargetDetail } from "./activity-target-detail"
import { useProjectAudit, usePmService } from "./pm-service"
import { allowed, useText } from "./pm-ui"
import styles from "./project-activity.module.css"

export type ProjectAuditHistoryProps = { projectId: string }

const entityKindSet: ReadonlySet<string> = new Set(entityKinds)
const openableKind = (kind: string): EntityKind | null => entityKindSet.has(kind) ? kind as EntityKind : null

/** Business audit is durable controlled-write history, not the file watcher's recent-update feed. */
export function ProjectAuditHistory({ projectId }: ProjectAuditHistoryProps) {
  const { workspace } = usePmService()
  const query = useProjectAudit(projectId)
  const t = useText()
  const navigate = useNavigate()
  const display = useDisplayDateTime()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const canRead = allowed(workspace, "domain.read", projectId) && allowed(workspace, "audit.read", projectId)
  const entries = useMemo(() => query.data?.pages.flatMap(page => page.entries) ?? [], [query.data])
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return entries
    return entries.filter(entry => [
      entry.action, entry.targetKind, entry.targetId, entry.actorId, entry.commandId, entry.source,
      ...entry.changes.flatMap(change => [change.field, change.before === null ? "" : String(change.before), change.after === null ? "" : String(change.after)]),
    ].join(" ").toLocaleLowerCase().includes(needle))
  }, [entries, search])
  const selected = entries.find(entry => entry.id === selectedId) ?? null
  const selectedKind = selected ? openableKind(selected.targetKind) : null
  const actionLabel = (entry: ProjectAuditEntry) => {
    const labels = actionLabels[entry.action]
    return labels ? t(...labels) : entry.action
  }
  if (!canRead) return <div className={styles.page}><div className={styles.denied} role="alert">
    <ShieldAlert size={24} aria-hidden="true" />
    <p>{t("需要此项目的 audit.read 及 domain.read 权限才能读取业务审计。", "Project audit.read and domain.read permissions are required to read business audit history.")}</p>
  </div></div>
  const state = query.isPending ? "loading" : query.error ? "error" : visible.length ? "success" : "empty"
  return <div className={styles.page} data-pm-project-activity>
    <section className={styles.list} aria-label={t("项目活动列表", "Project activity list")}>
      <header className={styles.listHeader}>
        <h2>{t("项目活动", "Project activity")}</h2>
        <span className={styles.count}>{query.isPending ? t("正在读取…", "Loading…") : t(`${visible.length} 条本页记录`, `${visible.length} on this page`)}</span>
        <Button variant="ghost" size="icon-sm" aria-label={t("刷新审计", "Refresh audit")} disabled={query.isFetching} onClick={() => { void query.refetch() }}>
          <RefreshCw size={16} aria-hidden="true" className={query.isFetching ? styles.spinning : undefined} />
        </Button>
      </header>
      <div className={styles.search}><PmSearch value={search} onChange={setSearch} label={t("搜索活动", "Search activity")} /></div>
      <div className={styles.listBody} tabIndex={0} aria-label={t("活动列表滚动区域", "Activity list scroll area")}>
        <DataRegion
          state={state}
          hasContent={visible.length > 0}
          refreshing={query.isFetching && !query.isPending}
          error={query.error ? { category: "request", message: query.error.message, reason: t("已加载的记录仍然保留。", "Loaded entries remain available.") } : undefined}
          onRetry={() => { void query.refetch() }}
          emptyDescription={search.trim() ? t("没有匹配的活动。", "No activity matches this search.") : t("此项目暂无可见的受控业务审计记录。", "No visible controlled-write audit entries yet.")}
        >
          <div role="list" aria-label={t("项目活动", "Project activity")}>
            {visible.map(entry => {
              const kind = openableKind(entry.targetKind)
              const content = <>
                <TargetGlyph kind={entry.targetKind} />
                <span className={styles.rowMain}>
                  <span className={styles.rowTop}>
                    <span className={styles.subject} title={entry.action}>{actionLabel(entry)}{entry.private && <span className={styles.private} title={t("仅本人可见", "Private to original actor")}><Lock size={11} aria-hidden="true" /><span className="sr-only">{t("仅本人可见", "Private to original actor")}</span></span>}</span>
                    <time className={styles.time} dateTime={entry.occurredAt}>{display.date(entry.occurredAt)}</time>
                  </span>
                  <span className={styles.preview} data-openable={kind !== null}>
                    <span className={styles.previewText}>{entry.targetKind} · {entry.targetId}</span>
                    {kind && <ArrowUpRight size={11} aria-hidden="true" />}
                  </span>
                </span>
              </>
              return <div key={entry.id} role="listitem">
                {kind ? <button
                  type="button"
                  id={`pm-activity-${entry.id}`}
                  data-activity-id={entry.id}
                  className={styles.row}
                  data-selected={selected?.id === entry.id}
                  aria-pressed={selected?.id === entry.id}
                  aria-label={`${actionLabel(entry)} · ${entry.targetKind} · ${entry.targetId} · ${t("在右侧打开详情", "Open detail on the right")}`}
                  onClick={() => setSelectedId(entry.id)}
                >{content}</button> : <div className={styles.rowStatic}>{content}</div>}
              </div>
            })}
          </div>
          {query.hasNextPage && <div className={styles.pagination}>
            <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage() }}>
              {query.isFetchingNextPage ? t("加载更早记录…", "Loading older entries…") : t("加载更早记录", "Load older entries")}
            </Button>
          </div>}
        </DataRegion>
      </div>
      <footer className={styles.listFooter}>
        <p>{t("审计只读；仅记录受控业务写入，不展示正文、便签、消息或文件内容。", "Audit is read-only; only controlled business writes are recorded, never body text, notes, messages or file content.")}</p>
        <Button variant="ghost" size="sm" onClick={() => navigate("../issues?view=kanban", { relative: "path" })}>{t("打开任务看板", "Open task board")}<ArrowUpRight size={12} aria-hidden="true" /></Button>
      </footer>
    </section>
    <section className={styles.detail} aria-label={t("活动详情", "Activity detail")} data-pm-activity-detail>
      {selected && selectedKind
        ? <div className={styles.entityPane}><ActivityTargetDetail entityId={selected.targetId} entityKind={selectedKind} projectId={projectId} onClose={() => setSelectedId(null)} /></div>
        : <div className={styles.placeholder}>
          <Activity size={24} strokeWidth={1.5} aria-hidden="true" />
          <h2>{t("选择活动以查看对象", "Select an activity to open its entity")}</h2>
          <p>{t("文档、任务、项目等活动会在右侧打开对象详情；其他活动没有可打开的对象。", "Document, task and project activities open their entity detail on the right; other activities have no openable object.")}</p>
        </div>}
    </section>
  </div>
}

function TargetGlyph({ kind }: { kind: string }) {
  const Icon = kind === "work_item" ? ListTodo : kind === "project" ? Folder : kind === "task_comment" ? MessageSquare : kind === "document" ? FileText : kind === "project_favorite" ? Star : Activity
  return <span className={styles.rowGlyph} aria-hidden="true"><Icon size={16} /></span>
}
