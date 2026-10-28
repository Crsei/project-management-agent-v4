"use client"
import { Checkbox as Base } from "@base-ui/react/checkbox"
import { Check, Minus } from "lucide-react"
import { cn } from "../../lib/utils"

export type CheckboxProps = Omit<Base.Root.Props, "className"> & {
  className?: string
}
export function Checkbox({
  className,
  indeterminate,
  ...props
}: CheckboxProps) {
  return (
    <Base.Root
      {...props}
      indeterminate={indeterminate}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50 [@media(pointer:coarse)]:size-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-4 items-center justify-center rounded border border-current"
      >
        <Base.Indicator>
          {indeterminate ? <Minus size={12} /> : <Check size={12} />}
        </Base.Indicator>
      </span>
    </Base.Root>
  )
}
