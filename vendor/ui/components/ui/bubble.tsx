import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
/** A standalone quoted excerpt or annotation; ChatMessage remains the conversation primitive. */
export function Bubble({ className, ...props }: ComponentProps<"blockquote">) {
  return (
    <blockquote
      {...props}
      className={cn(
        "max-w-prose rounded-panel border bg-surface px-3 py-2 text-sm leading-6",
        className,
      )}
    />
  )
}
export function BubbleContent({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("min-w-0 break-words", className)} />
}
export function BubbleAttribution({
  className,
  ...props
}: ComponentProps<"cite">) {
  return (
    <cite
      {...props}
      className={cn(
        "mt-1 block text-xs not-italic text-muted-foreground",
        className,
      )}
    />
  )
}
