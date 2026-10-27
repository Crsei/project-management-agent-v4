import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
import { Input } from "./input"
import { Textarea } from "./textarea"

export function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-control border bg-surface px-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 has-[[aria-invalid=true]]:border-destructive",
        className,
      )}
    />
  )
}
export function InputGroupAddon({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
    />
  )
}
export function InputGroupInput({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      className={cn(
        "border-0 bg-transparent px-0 focus-visible:ring-0",
        className,
      )}
    />
  )
}
export function InputGroupTextarea({
  className,
  ...props
}: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      {...props}
      className={cn(
        "border-0 bg-transparent px-0 focus-visible:ring-0",
        className,
      )}
    />
  )
}
