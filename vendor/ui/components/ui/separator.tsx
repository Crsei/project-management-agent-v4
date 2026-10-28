import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export type SeparatorProps = ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
}
export function Separator({
  orientation = "horizontal",
  decorative = true,
  className,
  ...props
}: SeparatorProps) {
  return (
    <div
      {...props}
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full min-h-4 w-px",
        className,
      )}
    />
  )
}
