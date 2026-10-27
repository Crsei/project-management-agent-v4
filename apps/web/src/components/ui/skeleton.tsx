import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
/** Static placeholder: loading semantics belong to the surrounding region. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn("block h-3 rounded-sm bg-surface-raised", className)}
    />
  )
}
