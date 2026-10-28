"use client"
import type { ComponentProps } from "react"
import { LoaderCircle } from "lucide-react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
export function Spinner({
  label,
  className,
  ...props
}: ComponentProps<"span"> & { label?: string }) {
  const { t } = useI18n()
  return (
    <span
      {...props}
      role="status"
      className={cn(
        "inline-flex items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 animate-spin motion-reduce:animate-none"
        strokeWidth={2}
      />
      <span>{label ?? t("dataRegion.loading")}</span>
    </span>
  )
}
