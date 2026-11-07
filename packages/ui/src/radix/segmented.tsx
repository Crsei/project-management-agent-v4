import type { HTMLAttributes, ReactNode } from "react"
import { RadioGroup, useRadioGroupItem, type RadioGroupProps } from "./radio-group"
import { cn } from "../lib/utils"

export type SegmentedProps<Value = string> = Omit<
  RadioGroupProps<Value>,
  "className" | "children"
> & {
  className?: string
  children: ReactNode
}

export function Segmented<Value>({
  className,
  ...props
}: SegmentedProps<Value>) {
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

export type SegmentedItemProps<Value = string> = {
  value: Value
  disabled?: boolean
  className?: string
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLButtonElement>, "value" | "children">

/** Text-pill radio built on the shared roving-tabindex group state. */
export function SegmentedItem<Value>({
  className,
  disabled,
  children,
  value,
  ...props
}: SegmentedItemProps<Value>) {
  const state = useRadioGroupItem(value)
  const isDisabled = disabled || state.disabled
  return (
    <button
      type="button"
      role="radio"
      {...props}
      disabled={isDisabled}
      aria-checked={state.checked}
      tabIndex={state.tabIndex}
      data-checked={state.checked || undefined}
      data-disabled={isDisabled || undefined}
      onClick={state.select}
      className={cn(
        "inline-flex min-h-8 cursor-pointer items-center rounded-md px-3 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-surface data-checked:text-foreground data-disabled:cursor-default data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {children}
    </button>
  )
}
