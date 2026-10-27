import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check, Minus } from "lucide-react"
import { cn } from "../../lib/utils"

/** Radix reports selection through `data-state`; the indicator stays ours. */
export type CheckboxProps = Omit<
  React.ComponentProps<typeof CheckboxPrimitive.Root>,
  "className" | "onCheckedChange" | "checked"
> & {
  className?: string
  onCheckedChange?: (checked: boolean) => void
  /** Base UI's controlled selection state. */
  checked?: boolean
  /** Base UI's mixed state; maps onto Radix's "indeterminate" checked value. */
  indeterminate?: boolean
}

export function Checkbox({
  className,
  onCheckedChange,
  indeterminate,
  checked,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      checked={indeterminate ? "indeterminate" : checked}
      onCheckedChange={
        onCheckedChange && ((state) => onCheckedChange(state === true))
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
          {indeterminate ? <Minus size={12} /> : <Check size={12} />}
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  )
}
