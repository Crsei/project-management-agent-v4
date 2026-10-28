// Adapted from shadcn/ui radix-nova; Copyright (c) 2023 shadcn. MIT — see LICENSE.
"use client"

import * as React from "react"
import { cn } from "./utils"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"

import { CheckIcon, MinusIcon } from "lucide-react"

function Checkbox({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-[state=checked]:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground group-has-[:focus-visible]/field-label:data-[state=checked]:border-primary dark:data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      {children ?? (
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          className="grid place-content-center text-current transition-none [&>svg]:size-3.5 [&[data-state=checked]>[data-indeterminate]]:hidden [&[data-state=indeterminate]>[data-checked]]:hidden"
        >
          <CheckIcon data-checked aria-hidden="true" />
          <MinusIcon data-indeterminate aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      )}
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
