import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
import styles from "./badge.module.css"

export type BadgeProps = Omit<
  ComponentProps<"span">,
  "onClick" | "onKeyDown" | "role" | "tabIndex"
> & {
  tone?: "neutral" | "info" | "success" | "warning" | "danger" | "agent"
  shape?: "rounded" | "pill"
  size?: "sm" | "default"
}

/** Read-only label. Runtime facts belong to RuntimeStatusBadge. */
export function Badge({
  tone = "neutral",
  shape = "rounded",
  size = "default",
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      {...props}
      className={cn(styles.badge, className)}
      data-tone={tone}
      data-shape={shape}
      data-size={size}
    />
  )
}
