import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"

export type LabelProps = ComponentProps<"label">

export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-[13px] leading-5 font-medium text-foreground",
        className,
      )}
      {...props}
    />
  )
}
