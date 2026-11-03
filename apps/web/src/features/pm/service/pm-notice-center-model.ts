import type { ReactNode } from "react"

/** One UI notice. These are client-only operation feedback, never business notification records. */
export type PmNoticeSeverity = "info" | "success" | "warning" | "error"

export type PmNoticeAction = {
  label: string
  run: () => void | Promise<void>
}

export type PmNoticeInput = {
  /** Stable identity for state changes. Omit for one-off action feedback. */
  key?: string
  severity: PmNoticeSeverity
  title: string
  detail?: string
  /** Identifies the originating surface for support and documentation. */
  source?: string
  /** While unresolved, the entry cannot be dismissed or cleared. */
  sticky?: boolean
  /** Do not increment the unread/attention badge (for background read status). */
  silent?: boolean
  /** Remove the row when the state resolves instead of retaining a resolved row. */
  transient?: boolean
  action?: PmNoticeAction
  /** Optional rich detail rendered inside the expanded notice. */
  content?: ReactNode
}

export type PmNotice = Required<Pick<PmNoticeInput, "severity" | "title">> & {
  id: string
  key: string
  detail?: string
  source: string
  sticky: boolean
  silent: boolean
  transient: boolean
  action?: PmNoticeAction
  content?: ReactNode
  createdAt: number
  updatedAt: number
  readAt: number | null
  resolvedAt: number | null
}

export const PM_NOTICE_LIMIT = 50

/** Newest first, unresolved before resolved so an active problem is never buried. */
export function sortNotices(notices: readonly PmNotice[]): PmNotice[] {
  return [...notices].sort((left, right) => {
    const leftResolved = left.resolvedAt === null ? 0 : 1
    const rightResolved = right.resolvedAt === null ? 0 : 1
    if (leftResolved !== rightResolved) return leftResolved - rightResolved
    return right.createdAt - left.createdAt
  })
}

/** Active warnings/errors stay counted even after being read; resolved rows do not. */
export function unreadNoticeCount(notices: readonly PmNotice[]): number {
  return notices.filter(notice => notice.resolvedAt === null
    && (notice.readAt === null || notice.severity === "warning" || notice.severity === "error")).length
}

function capNotices(notices: PmNotice[]): PmNotice[] {
  if (notices.length <= PM_NOTICE_LIMIT) return notices
  const overflow = notices.length - PM_NOTICE_LIMIT
  const removable = new Set<string>()
  for (const notice of sortOldestFirst(notices)) {
    if (removable.size >= overflow) break
    if (notice.resolvedAt !== null) removable.add(notice.id)
  }
  for (const notice of sortOldestFirst(notices)) {
    if (removable.size >= overflow) break
    if (!notice.sticky) removable.add(notice.id)
  }
  for (const notice of sortOldestFirst(notices)) {
    if (removable.size >= overflow) break
    if (notice.resolvedAt !== null || !notice.sticky) removable.add(notice.id)
  }
  return notices.filter(notice => !removable.has(notice.id))
}

function sortOldestFirst(notices: readonly PmNotice[]): PmNotice[] {
  return [...notices].sort((left, right) => left.createdAt - right.createdAt)
}

function sameContent(left: PmNotice, input: PmNoticeInput): boolean {
  return left.severity === input.severity
    && left.title === input.title
    && (left.detail ?? "") === (input.detail ?? "")
}

/**
 * Idempotently insert or update a notice. State transitions (offline, reconnecting,
 * unknown command) call this on every change instead of appending a new row.
 */
export function upsertNotice(
  notices: readonly PmNotice[],
  input: PmNoticeInput,
  now: number,
  generatedId: string,
): PmNotice[] {
  const key = input.key ?? generatedId
  const existing = notices.find(notice => notice.key === key)
  if (existing && !existing.resolvedAt && sameContent(existing, input)) {
    // Preserve read state while refreshing actions/content and metadata.
    return notices.map(notice => notice.id === existing.id
      ? { ...notice, source: input.source ?? notice.source, sticky: input.sticky ?? notice.sticky, silent: input.silent ?? notice.silent, transient: input.transient ?? notice.transient, action: input.action, content: input.content, updatedAt: now }
      : notice)
  }
  const next: PmNotice = {
    id: existing?.id ?? generatedId,
    key,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    source: input.source ?? existing?.source ?? "pm",
    sticky: input.sticky ?? false,
    silent: input.silent ?? false,
    transient: input.transient ?? false,
    action: input.action,
    content: input.content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // A changed state or a reopened resolved entry is unread again; silent status starts read.
    readAt: input.silent ? now : existing && !existing.resolvedAt && sameContent(existing, input) ? existing.readAt : null,
    resolvedAt: null,
  }
  return capNotices([next, ...notices.filter(notice => notice.id !== next.id)])
}

export function resolveNotice(notices: readonly PmNotice[], key: string, now: number): PmNotice[] {
  return notices
    .filter(notice => !(notice.key === key && notice.transient))
    .map(notice => notice.key === key && notice.resolvedAt === null
      ? { ...notice, resolvedAt: now, readAt: notice.readAt ?? now, updatedAt: now }
      : notice)
}

export function dismissNotice(notices: readonly PmNotice[], id: string): PmNotice[] {
  return notices.filter(notice => notice.id !== id || (notice.resolvedAt === null && notice.sticky))
}

export function markAllNoticesRead(notices: readonly PmNotice[], now: number): PmNotice[] {
  return notices.map(notice => notice.readAt === null ? { ...notice, readAt: now } : notice)
}

export function clearResolvedNotices(notices: readonly PmNotice[]): PmNotice[] {
  return notices.filter(notice => notice.resolvedAt === null)
}
