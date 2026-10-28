"use client"
import type { ComponentProps } from "react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Button } from "./button"
export type PaginationProps = Omit<ComponentProps<"nav">, "onChange"> & {
  page: number
  pageCount?: number
  hasNext?: boolean
  disabled?: boolean
  onPageChange: (page: number) => void
}
export function Pagination({
  page,
  pageCount,
  hasNext = false,
  disabled,
  onPageChange,
  className,
  ...props
}: PaginationProps) {
  const { t } = useI18n()
  const current = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
  const count =
    pageCount !== undefined && Number.isFinite(pageCount) && pageCount >= 1
      ? Math.trunc(pageCount)
      : undefined
  const pages = count
    ? [...new Set([1, current - 1, current, current + 1, count])]
        .filter((p) => p >= 1 && p <= count)
        .sort((a, b) => a - b)
    : [current]
  return (
    <nav
      aria-label={t("pagination.label")}
      {...props}
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      <Button
        variant="ghost"
        disabled={disabled || current <= 1}
        onClick={() => onPageChange(current - 1)}
      >
        {t("pagination.previous")}
      </Button>
      {pages.map((p, index) => (
        <span key={p} className="contents">
          {index > 0 && p - pages[index - 1] > 1 && (
            <span aria-hidden="true" className="px-1">
              …
            </span>
          )}
          <Button
            variant="ghost"
            aria-label={t("pagination.page", { page: p })}
            aria-current={p === current ? "page" : undefined}
            className={p === current ? "bg-selection text-primary" : undefined}
            disabled={disabled}
            onClick={() => {
              if (p !== current) onPageChange(p)
            }}
          >
            {p}
          </Button>
        </span>
      ))}
      <Button
        variant="ghost"
        disabled={
          disabled || (count !== undefined ? current >= count : !hasNext)
        }
        onClick={() => onPageChange(current + 1)}
      >
        {t("pagination.next")}
      </Button>
    </nav>
  )
}
