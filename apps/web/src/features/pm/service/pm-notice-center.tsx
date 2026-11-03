import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, Trash2, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/lib/i18n-provider"
import {
  clearResolvedNotices,
  dismissNotice,
  markAllNoticesRead,
  resolveNotice,
  sortNotices,
  unreadNoticeCount,
  upsertNotice,
  type PmNotice,
  type PmNoticeInput,
} from "./pm-notice-center-model"

type PmNoticeCenterApi = {
  notices: PmNotice[]
  unreadCount: number
  push: (input: PmNoticeInput) => string
  upsert: (input: PmNoticeInput) => string
  resolve: (key: string) => void
  dismiss: (id: string) => void
  markAllRead: () => void
  clearResolved: () => void
  reset: () => void
}

const emptyApi: PmNoticeCenterApi = {
  notices: [],
  unreadCount: 0,
  push: () => "",
  upsert: () => "",
  resolve: () => undefined,
  dismiss: () => undefined,
  markAllRead: () => undefined,
  clearResolved: () => undefined,
  reset: () => undefined,
}

const NoticeContext = createContext<PmNoticeCenterApi>(emptyApi)

/** Safe outside the product shell (Lab, stories, isolated component previews). */
export function usePmNoticeCenter() {
  return useContext(NoticeContext)
}

export function PmNoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<PmNotice[]>([])

  const upsert = useCallback((input: PmNoticeInput) => {
    const id = input.key ?? globalThis.crypto.randomUUID()
    setNotices(previous => upsertNotice(previous, input, Date.now(), id))
    return id
  }, [])

  const push = useCallback((input: PmNoticeInput) => upsert(input), [upsert])

  const resolve = useCallback((key: string) => {
    setNotices(previous => resolveNotice(previous, key, Date.now()))
  }, [])

  const dismiss = useCallback((id: string) => {
    setNotices(previous => dismissNotice(previous, id))
  }, [])

  const markAllRead = useCallback(() => {
    setNotices(previous => markAllNoticesRead(previous, Date.now()))
  }, [])

  const clearResolved = useCallback(() => {
    setNotices(previous => clearResolvedNotices(previous))
  }, [])

  const reset = useCallback(() => setNotices([]), [])

  const unreadCount = useMemo(() => unreadNoticeCount(notices), [notices])

  const value = useMemo<PmNoticeCenterApi>(() => ({
    notices,
    unreadCount,
    push,
    upsert,
    resolve,
    dismiss,
    markAllRead,
    clearResolved,
    reset,
  }), [clearResolved, dismiss, markAllRead, notices, push, reset, resolve, unreadCount, upsert])

  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>
}

const sourceLabels: Record<string, readonly [string, string]> = {
  shell: ["连接", "Connection"],
  command: ["命令", "Command"],
  workbench: ["工作台", "Workbench"],
  "project-menu": ["项目菜单", "Project menu"],
  "project-list": ["项目目录", "Project list"],
  "project-visit": ["项目访问", "Project visit"],
  "project-files": ["项目文件", "Project files"],
  "file-preview": ["文件预览", "File preview"],
}

const severityIcons = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
} as const

const severityClasses = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const

function NoticeRow({ notice, locale, onDismiss }: { notice: PmNotice; locale: string; onDismiss: (id: string) => void }) {
  const en = locale === "en"
  const Icon = severityIcons[notice.severity]
  const source = sourceLabels[notice.source]
  const resolved = notice.resolvedAt !== null
  return <li className="border-b border-border/70 p-3 last:border-b-0" data-pm-notice={notice.key}>
    <div className="flex min-w-0 items-start gap-2">
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${severityClasses[notice.severity]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="min-w-0 break-words text-sm font-medium">{notice.title}</p>
          {resolved && <span className="rounded-pill border px-1.5 py-0.5 text-[10px] text-muted-foreground">{en ? "Resolved" : "已解决"}</span>}
          {!resolved && notice.sticky && <span className="rounded-pill border border-warning/40 px-1.5 py-0.5 text-[10px] text-warning">{en ? "Needs action" : "需处理"}</span>}
        </div>
        {notice.detail && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice.detail}</p>}
        {notice.content && <div className="mt-2 text-xs">{notice.content}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(notice.createdAt))}</span>
          {source && <span>· {en ? source[1] : source[0]}</span>}
          {notice.action && <Button size="sm" variant="outline" onClick={() => { void notice.action?.run() }}>{notice.action.label}</Button>}
        </div>
      </div>
      {(!notice.sticky || resolved) && <Button size="icon-sm" variant="ghost" aria-label={en ? "Dismiss notice" : "关闭通知"} onClick={() => onDismiss(notice.id)}><X aria-hidden="true" className="size-3.5" /></Button>}
    </div>
  </li>
}

/** Top-right overlay. It never reserves layout and never opens itself. */
export function PmNoticeCenterTrigger() {
  const { locale } = useI18n()
  const en = locale === "en"
  const { notices, unreadCount, dismiss, markAllRead, clearResolved } = usePmNoticeCenter()
  const [open, setOpen] = useState(false)
  const ordered = useMemo(() => sortNotices(notices), [notices])
  const announcement = useMemo(() => {
    const next = ordered.find(notice => notice.readAt === null && notice.resolvedAt === null && (notice.severity === "error" || notice.severity === "warning"))
    return next ? `${next.title}${next.detail ? `: ${next.detail}` : ""}` : ""
  }, [ordered])
  const resolvedCount = useMemo(() => notices.filter(notice => notice.resolvedAt !== null).length, [notices])
  return <>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) markAllRead() }}>
      <PopoverTrigger render={<Button variant="ghost" size="icon" className="relative" aria-label={en ? "Notices" : "通知"} aria-expanded={open} />}>
        <Bell aria-hidden="true" />
        {unreadCount > 0 && <span className={`pointer-events-none absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] leading-4 ${notices.some(notice => notice.severity === "error" && notice.resolvedAt === null) ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`} aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(380px,calc(100vw-24px))] overflow-hidden p-0" aria-label={en ? "Page notices" : "页面通知"}>
        <div className="flex items-start justify-between gap-2 border-b px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">{en ? "Notices" : "通知"}</p>
            <p className="text-xs text-muted-foreground">{en ? "Page state and action feedback; this browser only." : "页面状态与操作反馈；仅当前浏览器。"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" disabled={unreadCount === 0} onClick={markAllRead}><CheckCheck aria-hidden="true" className="size-3.5" />{en ? "Read all" : "全部已读"}</Button>
            <Button size="sm" variant="ghost" disabled={resolvedCount === 0} onClick={clearResolved}><Trash2 aria-hidden="true" className="size-3.5" />{en ? "Clear resolved" : "清除已解决"}</Button>
          </div>
        </div>
        {ordered.length === 0
          ? <div className="px-3 py-10 text-center text-sm text-muted-foreground"><Bell aria-hidden="true" className="mx-auto mb-2 size-5 opacity-60" />{en ? "No notices. Page state changes appear here." : "暂无通知。页面状态变化会出现在这里。"}</div>
          : <ul className="max-h-[min(60dvh,440px)] overflow-y-auto" aria-label={en ? "Notice list" : "通知列表"}>{ordered.map(notice => <NoticeRow key={notice.id} notice={notice} locale={locale} onDismiss={dismiss} />)}</ul>}
      </PopoverContent>
    </Popover>
  </>
}
