"use client"
import { ToggleGroup as Base } from "@base-ui/react/toggle-group"
import { cn } from "../../lib/utils"
export { Toggle as ToggleGroupItem } from "./toggle"
export type ToggleGroupProps<Value extends string = string> = Omit<
  Base.Props<Value>,
  "className"
> & { className?: string }
export function ToggleGroup<Value extends string>({
  className,
  orientation = "horizontal",
  ...props
}: ToggleGroupProps<Value>) {
  return (
    <Base
      {...props}
      orientation={orientation}
      className={cn(
        "inline-flex gap-1",
        orientation === "vertical" && "flex-col",
        className,
      )}
    />
  )
}
