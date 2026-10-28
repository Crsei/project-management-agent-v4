"use client"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check } from "lucide-react"
import { cn } from "../../lib/utils"

/** Radix reports selection through `data-state`; the indicator stays ours. */
export type CheckboxProps = Omit<
  React.ComponentProps<typeof CheckboxPrimitive.Root>,
  "className" | "onCheckedChange"
> & {
  className?: string
  onCheckedChange?: (checked: boolean) => void
}

export function Checkbox({
  className,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      onCheckedChange={
        onCheckedChange && ((checked) => onCheckedChange(checked === true))
      }
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50 [@media(pointer:coarse)]:size-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-4 items-center justify-center rounded border border-current"
      >
        <CheckboxPrimitive.Indicator>
          <Check size={12} />
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  )
}
