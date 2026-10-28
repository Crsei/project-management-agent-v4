"use client"

import { RadioGroup as BaseGroup } from "@base-ui/react/radio-group"
import { Radio } from "@base-ui/react/radio"
import { cn } from "../../lib/utils"

export type RadioGroupProps<Value = string> = Omit<
  BaseGroup.Props<Value>,
  "className"
> & { className?: string }

export function RadioGroup<Value>({
  className,
  ...props
}: RadioGroupProps<Value>) {
  return <BaseGroup {...props} className={cn("grid gap-2", className)} />
}

export type RadioGroupItemProps<Value = string> = Omit<
  Radio.Root.Props<Value>,
  "className" | "children"
> & { className?: string }

export function RadioGroupItem<Value>({
  className,
  ...props
}: RadioGroupItemProps<Value>) {
  return (
    <Radio.Root
      {...props}
      className={cn(
        "group inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-45 data-readonly:cursor-default [@media(pointer:coarse)]:size-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-4 items-center justify-center rounded-full border border-border group-aria-invalid:border-destructive group-data-checked:border-primary"
      >
        <Radio.Indicator className="size-2 rounded-full bg-primary" />
      </span>
    </Radio.Root>
  )
}
