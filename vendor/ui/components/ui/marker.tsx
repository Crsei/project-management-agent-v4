import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export type MarkerProps = ComponentProps<"div"> & {
  variant?: "default" | "separator" | "border"
}
export function Marker({
  variant = "default",
  className,
  ...props
}: MarkerProps) {
  return (
    <div
      {...props}
      data-variant={variant}
      className={cn(
        "flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground",
        variant === "separator" &&
          "before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border",
        variant === "border" && "border-b pb-2",
        className,
      )}
    />
  )
}
export function MarkerIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0", className)}
    />
  )
}
export function MarkerContent({ className, ...props }: ComponentProps<"span">) {
  return <span {...props} className={cn("min-w-0 break-words", className)} />
}
