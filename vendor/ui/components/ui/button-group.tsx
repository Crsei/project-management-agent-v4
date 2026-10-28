import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"

export type ButtonGroupProps = ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical"
}

/** Groups sibling actions without introducing selection or nested targets. */
export function ButtonGroup({
  orientation = "horizontal",
  className,
  ...props
}: ButtonGroupProps) {
  return (
    <div
      role="group"
      {...props}
      data-orientation={orientation}
      className={cn(
        "inline-flex gap-1",
        orientation === "vertical" && "flex-col",
        className,
      )}
    />
  )
}
