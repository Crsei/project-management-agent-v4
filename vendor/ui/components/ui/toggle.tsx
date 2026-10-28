"use client"
import { Toggle as Base } from "@base-ui/react/toggle"
import { cn } from "../../lib/utils"
export type ToggleProps<Value extends string = string> = Omit<
  Base.Props<Value>,
  "className"
> & { className?: string }
export function Toggle<Value extends string>({
  className,
  ...props
}: ToggleProps<Value>) {
  return (
    <Base
      {...props}
      className={cn(
        "inline-flex min-h-8 min-w-8 items-center justify-center gap-2 rounded-control border px-3 text-[13px] outline-none hover:bg-surface-hover data-pressed:border-primary data-pressed:bg-selection data-pressed:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-disabled:pointer-events-none data-disabled:opacity-45 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
        className,
      )}
    />
  )
}
