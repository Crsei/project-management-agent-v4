"use client"
import { useId, useState, type ReactNode } from "react"
import { Plus, Star, Archive, MoreHorizontal } from "lucide-react"
import { Button } from "../../ui/button"
import { Input } from "../../ui/input"
import { DataRegion, type DataRegionProps } from "../../ui/data-region"
import { RuntimeStatusBadge } from "../../ui/runtime-status-badge"
import { SessionRow } from "../session-row"
import { useI18n } from "../../../lib/i18n-provider"
import type {
  EnvironmentRef,
  ProjectRef,
  SessionSnapshot,
  OperationReceipt,
} from "../../../lib/agent-workbench-model"
import { activeReceipt } from "../../../lib/agent-workbench-model"
import { cn } from "../../../lib/utils"
import styles from "./workbench.module.css"
export function ProjectSwitcher({
  projects,
  value,
  onChange,
}: {
  projects: readonly ProjectRef[]
  value: string
  onChange: (id: string) => void
}) {
  const { t } = useI18n()
  const id = useId()
  return (
    <label className={styles.label} htmlFor={id}>
      {t("workbench.project")}
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!projects.length}
      >
        {!projects.length && (
          <option value="">{t("workbench.noProjects")}</option>
        )}
        {projects.map((p) => (
          <option key={p.projectId} value={p.projectId}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}
export type SessionNavigatorProps = {
  projects: readonly ProjectRef[]
  sessions: readonly SessionSnapshot[]
  projectId: string
  selectedId?: string
  onProjectChange: (id: string) => void
  onSelect: (id: string) => void
  onNew: () => void
  newLabel?: string
  newDisabled?: boolean
  filters?: "all" | "runtime"
  presentation?: "filters" | "sections"
  selectedContent?: ReactNode
  onUpdate?: (
    id: string,
    patch: Partial<Pick<SessionSnapshot, "title" | "favorite" | "archived">>,
  ) => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
  footer?: ReactNode
  receipts?: readonly OperationReceipt[]
  onReconcile?: (receipt: OperationReceipt) => void
}
export function SessionNavigator({
  projects,
  sessions,
  projectId,
  selectedId,
  onProjectChange,
  onSelect,
  onNew,
  newLabel,
  newDisabled = false,
  filters = "all",
  presentation = "filters",
  selectedContent,
  onUpdate,
  data,
  footer,
  receipts = [],
  onReconcile,
}: SessionNavigatorProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [archived, setArchived] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [runningOnly, setRunningOnly] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState("")
  const filtered = sessions.filter(
    (s) =>
      s.projectId === projectId &&
      (presentation === "sections" || Boolean(s.archived) === archived) &&
      (!favoritesOnly || s.favorite) &&
      (presentation === "sections" ||
        !runningOnly ||
        ["running", "starting", "thinking", "queued", "waiting"].includes(
          s.status,
        )) &&
      s.title.toLowerCase().includes(query.toLowerCase()),
  )
  function renderSession(s: SessionSnapshot) {
    const operation = activeReceipt(receipts, s.sessionId)
    const update = receipts.findLast(
      (receipt) =>
        receipt.targetId === s.sessionId && receipt.action === "update-session",
    )
    return (
      <div
        key={s.sessionId}
        className={styles.navGroup}
        data-session-id={s.sessionId}
      >
        <div
          className={
            presentation === "sections" && onUpdate
              ? styles.sessionEntry
              : undefined
          }
        >
          <SessionRow
            compact={presentation === "sections"}
            statusIconOnly={presentation === "sections"}
            session={{
              id: s.sessionId,
              title: `${s.favorite ? "★ " : ""}${s.title}`,
              status: s.status,
              updatedAt: s.updatedAt,
              stage: s.unread ? t("workbench.unread") : undefined,
            }}
            selected={selectedId === s.sessionId}
            onSelect={() => onSelect(s.sessionId)}
          />
        </div>
        {selectedId === s.sessionId && selectedContent}
        {onUpdate && (
          <details
            className={
              presentation === "sections" ? styles.sessionActions : undefined
            }
          >
            <summary className={styles.meta} title={t("workbench.actions")}>
              {presentation === "sections" ? (
                <>
                  <MoreHorizontal size={16} aria-hidden="true" />
                  <span className="sr-only">{t("workbench.actions")}</span>
                </>
              ) : (
                t("workbench.actions")
              )}
            </summary>
            <div className={styles.row}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(
                  s.favorite ? "workbench.unfavorite" : "workbench.favorite",
                )}
                disabled={Boolean(operation)}
                onClick={() => onUpdate(s.sessionId, { favorite: !s.favorite })}
              >
                <Star size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(
                  s.archived ? "workbench.restore" : "workbench.archive",
                )}
                disabled={Boolean(operation)}
                onClick={() => onUpdate(s.sessionId, { archived: !s.archived })}
              >
                <Archive size={16} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(operation)}
                onClick={() => {
                  setRenaming(s.sessionId)
                  setName(s.title)
                }}
              >
                {t("workbench.rename")}
              </Button>
            </div>
            {renaming === s.sessionId && (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (name.trim()) onUpdate(s.sessionId, { title: name.trim() })
                  setRenaming(null)
                }}
              >
                <Input
                  autoFocus
                  aria-label={t("workbench.newName")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit" size="sm">
                  {t("workbench.rename")}
                </Button>
              </form>
            )}
          </details>
        )}
        {update && (
          <p className={styles.meta} role="status">
            {t(`workbench.${update.state}`)}
            {update.state === "unknown" && onReconcile && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onReconcile(update)}
              >
                {t("workbench.reconcile")}
              </Button>
            )}
          </p>
        )}
      </div>
    )
  }
  return (
    <nav
      className={cn(
        styles.nav,
        presentation === "sections" && styles.sessionSections,
      )}
      aria-label={t("workbench.recent")}
      data-session-navigation={presentation}
    >
      <Button
        className={styles.newButton}
        onClick={onNew}
        aria-label={newLabel ?? t("workbench.newTask")}
        disabled={newDisabled}
      >
        <Plus size={16} />
        {newLabel ?? t("workbench.newTask")}
      </Button>
      <ProjectSwitcher
        projects={projects}
        value={projectId}
        onChange={onProjectChange}
      />
      <Input
        aria-label={t("workbench.searchSessions")}
        placeholder={t("workbench.searchSessions")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {presentation === "filters" && (
        <div className={styles.row}>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!archived && !runningOnly}
            onClick={() => {
              setArchived(false)
              setRunningOnly(false)
            }}
          >
            {t("workbench.recent")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={runningOnly}
            onClick={() => {
              setArchived(false)
              setRunningOnly(true)
            }}
          >
            {t("agentBoard.active")}
          </Button>
          {filters === "all" && (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={archived}
              onClick={() => {
                setArchived(true)
                setRunningOnly(false)
              }}
            >
              {t("workbench.archived")}
            </Button>
          )}
          {filters === "all" && (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={favoritesOnly}
              onClick={() => setFavoritesOnly(!favoritesOnly)}
            >
              {t("workbench.favorites")}
            </Button>
          )}
        </div>
      )}
      <DataRegion
        state={filtered.length ? "success" : "empty"}
        {...data}
        hasContent={filtered.length > 0}
        emptyTitle={t("workbench.noSessions")}
      >
        {presentation === "sections"
          ? [
              {
                id: "running",
                label: t("agentBoard.active"),
                sessions: filtered.filter(
                  (s) =>
                    !s.archived &&
                    [
                      "running",
                      "starting",
                      "thinking",
                      "queued",
                      "waiting",
                    ].includes(s.status),
                ),
              },
              {
                id: "recent",
                label: t("workbench.recent"),
                sessions: filtered.filter(
                  (s) =>
                    !s.archived &&
                    ![
                      "running",
                      "starting",
                      "thinking",
                      "queued",
                      "waiting",
                    ].includes(s.status),
                ),
              },
              ...(filters === "all"
                ? [
                    {
                      id: "archived",
                      label: t("workbench.archived"),
                      sessions: filtered.filter((s) => s.archived),
                    },
                  ]
                : []),
            ].map((group) => (
              <details
                key={group.id}
                data-session-section={group.id}
                open={
                  group.id !== "archived" ||
                  group.sessions.some((s) => s.sessionId === selectedId)
                }
                className={styles.sessionSection}
              >
                <summary>
                  {group.label} <span>{group.sessions.length}</span>
                </summary>
                <DataRegion
                  state={group.sessions.length ? "success" : "empty"}
                  hasContent={group.sessions.length > 0}
                  emptyTitle={t("workbench.noSessions")}
                >
                  {group.sessions.map(renderSession)}
                </DataRegion>
              </details>
            ))
          : filtered.map(renderSession)}
      </DataRegion>
      {footer}
    </nav>
  )
}
export function SessionHeader({
  session,
  environment = session.environment,
  onRename,
  onInterrupt,
  actions,
  presentation = "default",
}: {
  session: SessionSnapshot
  environment?: EnvironmentRef
  onRename?: (title: string) => void
  onInterrupt?: () => void
  actions?: ReactNode
  presentation?: "default" | "workspace"
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState("")
  return (
    <div
      className={cn(
        styles.row,
        presentation === "workspace" && styles.sessionHeader,
      )}
    >
      <div className={styles.sessionIdentity}>
        {editing === session.sessionId ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) onRename?.(name.trim())
              setEditing(null)
            }}
          >
            <Input
              aria-label={t("workbench.newName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" size="sm">
              {t("workbench.rename")}
            </Button>
          </form>
        ) : (
          <>
            <span className={styles.heading} title={session.title}>
              {session.title}
            </span>
          </>
        )}
        <div className={styles.sessionMetadata}>
          <RuntimeStatusBadge status={session.status} />
          <span>{session.agent.name}</span>
          <span className={styles.meta}>
            {environment.name} · {environment.branch ?? "—"} ·{" "}
            {environment.connection === "connected"
              ? t("workbench.connectionConnected")
              : environment.connection === "disconnected"
                ? t("workbench.disconnected")
                : t("workbench.connectionUnknown")}
          </span>
        </div>
      </div>
      <div className={styles.sessionHeaderActions}>
        {onRename && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setName(session.title)
              setEditing(session.sessionId)
            }}
          >
            {t("workbench.rename")}
          </Button>
        )}
        {onInterrupt && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!session.capabilities.interrupt}
            onClick={onInterrupt}
          >
            {t("workbench.interrupt")}
          </Button>
        )}
        {actions}
      </div>
    </div>
  )
}
