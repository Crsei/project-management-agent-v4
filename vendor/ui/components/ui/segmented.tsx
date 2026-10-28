"use client"
import { RadioGroup } from "@base-ui/react/radio-group"
import { Radio } from "@base-ui/react/radio"
import { cn } from "../../lib/utils"
export function Segmented<Value>({
  className,
  ...props
}: Omit<RadioGroup.Props<Value>, "className"> & { className?: string }) {
  return (
    <RadioGroup
      {...props}
      className={cn(
        "inline-flex gap-1 rounded-lg border bg-surface-raised p-1",
        className,
      )}
    />
  )
}
export function SegmentedItem<Value>({
  className,
  ...props
}: Omit<Radio.Root.Props<Value>, "className"> & { className?: string }) {
  return (
    <Radio.Root
      {...props}
      className={cn(
        "inline-flex min-h-8 cursor-pointer items-center rounded-md px-3 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-surface data-checked:text-foreground data-disabled:cursor-default data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
