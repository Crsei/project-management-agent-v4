import type { ReactNode } from "react"
import { Badge, type BadgeProps } from "./badge"

export type TagProps = Omit<BadgeProps, "tone" | "shape"> & {
  leading?: ReactNode
}

/** Read-only classification. Use Chip for selection or removal. */
export function Tag({ leading, children, ...props }: TagProps) {
  return (
    <Badge {...props} tone="neutral" shape="pill">
      {leading && <span aria-hidden="true">{leading}</span>}
      {children}
    </Badge>
  )
}
