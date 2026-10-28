import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      {...props}
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-xs leading-5 text-muted-foreground",
        className,
      )}
    />
  )
}
