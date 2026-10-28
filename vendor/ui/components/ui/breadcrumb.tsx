"use client"
import type { ComponentProps } from "react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
export function Breadcrumb(props: ComponentProps<"nav">) {
  const { t } = useI18n()
  return <nav aria-label={t("breadcrumb.label")} {...props} />
}
export function BreadcrumbList({ className, ...props }: ComponentProps<"ol">) {
  return (
    <ol
      {...props}
      className={cn(
        "flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground",
        className,
      )}
    />
  )
}
export function BreadcrumbItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      {...props}
      className={cn("inline-flex min-w-0 items-center gap-2", className)}
    />
  )
}
export function BreadcrumbLink({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      {...props}
      className={cn(
        "rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center",
        className,
      )}
    />
  )
}
export function BreadcrumbPage({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      {...props}
      aria-current="page"
      className={cn("text-foreground", className)}
    />
  )
}
export function BreadcrumbSeparator({
  children = "/",
  ...props
}: ComponentProps<"span">) {
  return (
    <span {...props} aria-hidden="true">
      {children}
    </span>
  )
}
