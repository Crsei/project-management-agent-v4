import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n-provider"

/** One PM page geometry. Only interaction/read-position inputs; no domain or session. */
export function PmPage({ title, description, actions, toolbar, navigation, sidebar, sidebarPlacement = "left", children, pageId, className, contentClassName, titleSuffix, titleIcon, eyebrow, headerMode = "default", headerPlacement = "fixed", readingPosition, onReadingPositionChange, interactive = true }: {
  title: string
  description?: string
  actions?: ReactNode
  toolbar?: ReactNode
  navigation?: ReactNode
  sidebar?: ReactNode
  sidebarPlacement?: "left" | "right"
  children: ReactNode
  pageId: string
  className?: string
  contentClassName?: string
  titleSuffix?: ReactNode
  titleIcon?: ReactNode
  eyebrow?: ReactNode
  headerMode?: "default" | "hidden"
  headerPlacement?: "fixed" | "scroll"
  readingPosition?: number
  onReadingPositionChange?: (top: number) => void
  interactive?: boolean
}) {
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (interactive && body.current && readingPosition !== undefined && body.current.scrollTop !== readingPosition) body.current.scrollTop = readingPosition
  }, [interactive, readingPosition])
  const header = headerMode === "default" ? <header className={`flex min-h-16 shrink-0 flex-wrap items-center gap-4 border-b bg-surface px-4 py-3 md:px-6 ${headerPlacement === "scroll" ? "-mx-6 max-md:-mx-4" : ""}`} data-pm-header><div className="min-w-0 flex-1">{eyebrow}<div className={`flex min-w-0 gap-2 ${titleIcon ? "items-center" : "items-baseline"}`}>{titleIcon}<h1 className="truncate text-xl font-semibold leading-7" title={title}>{title}</h1>{titleSuffix}</div>{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}</div>{actions}</header> : null
  return <main className={`flex h-full min-h-0 min-w-0 flex-col bg-background ${className ?? ""}`} data-pm-page={pageId} inert={!interactive} aria-busy={!interactive} data-pm-interaction={interactive ? "ready" : "loading"}>
    {navigation}
    {headerPlacement === "fixed" && header}
    {headerMode === "hidden" && actions && <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-surface px-6 py-3" data-pm-actions>{actions}</div>}
    {toolbar && <div className="shrink-0 bg-surface px-6" data-pm-toolbar>{toolbar}</div>}
    <div className="flex min-h-0 flex-1 max-md:flex-col max-md:overflow-auto max-md:[&>aside]:w-full max-md:[&>aside]:overflow-visible">{sidebarPlacement === "left" && sidebar}<div ref={body} className={`min-h-0 min-w-0 flex-1 overflow-auto p-6 max-md:flex-none max-md:p-4 max-md:overflow-visible ${contentClassName ?? ""}`} data-pm-scroll onScroll={(event) => { if (interactive) onReadingPositionChange?.(event.currentTarget.scrollTop) }}>{headerPlacement === "scroll" && header}{children}</div>{sidebarPlacement === "right" && sidebar}</div>
  </main>
}
export function PmSearch({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const { locale } = useI18n()
  return <div className="relative w-64"><Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" aria-hidden="true" /><Input aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} className="pl-8 pr-8" />{value && <Button variant="ghost" size="icon" className="absolute right-0 top-0" aria-label={locale === "en" ? "Clear search" : "清除搜索"} onClick={() => onChange("")}><X aria-hidden="true" /></Button>}</div>
}
