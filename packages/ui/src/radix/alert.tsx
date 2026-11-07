import type { ComponentProps } from "react"
import { cn } from "../lib/utils"
export type AlertProps = ComponentProps<"div"> & {
  tone?: "info" | "warning" | "error" | "success"
  urgent?: boolean
}
export function Alert({
  tone = "info",
  urgent = tone === "error",
  className,
  ...props
}: AlertProps) {
  return (
    <div
      role={urgent ? "alert" : "status"}
      {...props}
      data-tone={tone}
      className={cn(
        "min-h-10 rounded-control border p-3 text-[13px] leading-5",
        tone === "error" && "border-destructive/30 text-destructive",
        tone === "warning" && "border-warning/30 text-warning",
        tone === "success" && "border-success/30 text-success",
        tone === "info" && "text-foreground",
        className,
      )}
    />
  )
}
export function AlertTitle({
  className,
  headingLevel = 3,
  ...props
}: ComponentProps<"h3"> & { headingLevel?: 2 | 3 | 4 | 5 | 6 }) {
  const Heading = ("h" + headingLevel) as "h2" | "h3" | "h4" | "h5" | "h6"
  return <Heading {...props} className={cn("text-sm font-medium", className)} />
}
export function AlertDescription({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div {...props} className={cn("mt-1 text-[13px] leading-5", className)} />
  )
}
