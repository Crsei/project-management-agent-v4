import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export type ScrollAreaProps = ComponentProps<"div"> & {
  label: string
  orientation?: "both" | "vertical" | "horizontal"
}
/** Native scrolling, selection, find and browser keyboard behavior remain available. */
export function ScrollArea({
  label,
  orientation = "both",
  className,
  style,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={label}
      {...props}
      style={{ scrollbarGutter: "stable", ...style }}
      className={cn(
        "min-h-0 min-w-0 overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring",
        orientation === "both"
          ? "overflow-auto"
          : orientation === "vertical"
            ? "overflow-y-auto overflow-x-hidden"
            : "overflow-x-auto overflow-y-hidden",
        className,
      )}
    />
  )
}
