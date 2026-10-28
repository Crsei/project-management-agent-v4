// Adapted from shadcn/ui radix-nova; Copyright (c) 2023 shadcn. MIT — see LICENSE.
"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cn } from "./utils"

export type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root>

function Progress({ className, value, max = 100, ...props }: ProgressProps) {
  const maximum = Number.isFinite(max) && max > 0 ? max : 100
  const percentage =
    value == null ? null : Math.min(100, Math.max(0, (value / maximum) * 100))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-hidden rounded-full bg-muted",
        className,
      )}
      value={value}
      max={max}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full bg-primary transition-transform motion-reduce:transition-none",
          percentage === null
            ? "w-1/3 animate-pulse motion-reduce:animate-none"
            : "w-full",
        )}
        style={
          percentage === null
            ? undefined
            : { transform: `translateX(-${100 - percentage}%)` }
        }
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
