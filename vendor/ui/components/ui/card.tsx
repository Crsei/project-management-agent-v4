import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
/** Independent content only; sessions, logs and activity continue to use Item/list/table. */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={cn(
        "rounded-panel border bg-surface text-foreground",
        className,
      )}
    />
  )
}
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("grid gap-1 border-b p-4", className)} />
}
export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3
      {...props}
      className={cn("text-base font-medium leading-6", className)}
    />
  )
}
export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      {...props}
      className={cn("text-[13px] leading-5 text-muted-foreground", className)}
    />
  )
}
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("p-4", className)} />
}
export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("flex items-center gap-2 border-t p-4", className)}
    />
  )
}
