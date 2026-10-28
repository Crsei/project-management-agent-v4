import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"

export type TextareaProps = ComponentProps<"textarea">

export function Textarea({ className, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cn(
        "min-h-20 w-full min-w-0 resize-y rounded-control border bg-surface px-3 py-2 text-sm leading-6 transition-colors duration-[var(--motion-hover)] ease-out outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-45 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11",
        className,
      )}
      {...props}
    />
  )
}
