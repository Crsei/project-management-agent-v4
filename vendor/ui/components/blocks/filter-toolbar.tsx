"use client"
import { useSyncExternalStore, type ReactNode } from "react"
import { Button } from "../ui/button"
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "../ui/sheet"
import { useI18n } from "../../lib/i18n-provider"
function subscribe(callback: () => void) {
  const media = window.matchMedia("(max-width: 639px)")
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}
export type FilterToolbarProps = {
  label: string
  search?: ReactNode
  filters?: ReactNode
  sort?: ReactNode
  summary?: ReactNode
  actions?: ReactNode
  filterTitle?: string
  filterDescription?: string
  className?: string
}
export function FilterToolbar({
  label,
  search,
  filters,
  sort,
  summary,
  actions,
  filterTitle,
  filterDescription,
  className,
}: FilterToolbarProps) {
  const { t } = useI18n()
  const mobile = useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(max-width: 639px)").matches,
    () => false,
  )
  return (
    <div
      role="group"
      aria-label={label}
      className={className ?? "flex flex-wrap items-center gap-2 border-b py-3"}
    >
      {search}
      {filters &&
        (mobile ? (
          <Sheet>
            <SheetTrigger render={<Button variant="secondary" />}>
              {t("commonComponents.filters")}
            </SheetTrigger>
            <SheetContent side="bottom" size={400}>
              <SheetHeader>
                <SheetTitle>{filterTitle ?? label}</SheetTitle>
                {filterDescription && (
                  <SheetDescription>{filterDescription}</SheetDescription>
                )}
              </SheetHeader>
              <SheetBody>
                <div className="flex flex-col gap-3">{filters}</div>
              </SheetBody>
            </SheetContent>
          </Sheet>
        ) : (
          <div className="flex flex-wrap items-center gap-2">{filters}</div>
        ))}
      {sort}
      {summary && (
        <span className="text-xs text-muted-foreground">{summary}</span>
      )}
      {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}
