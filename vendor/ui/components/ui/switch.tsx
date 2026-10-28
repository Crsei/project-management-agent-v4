"use client"

import { Switch as Base } from "@base-ui/react/switch"
import { cn } from "../../lib/utils"

export type SwitchProps = Omit<Base.Root.Props, "className" | "children"> & {
  className?: string
}

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <Base.Root
      {...props}
      className={cn(
        "group inline-flex h-8 w-11 shrink-0 cursor-pointer items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-45 data-readonly:cursor-default [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none relative inline-flex h-5 w-8 items-center rounded-full border bg-muted group-aria-invalid:border-destructive group-data-checked:border-primary group-data-checked:bg-primary"
      >
        <Base.Thumb className="absolute left-0.5 size-3.5 rounded-full bg-foreground transition-transform duration-[var(--motion-button)] ease-out data-checked:translate-x-3 data-checked:bg-primary-foreground motion-reduce:transition-none" />
      </span>
    </Base.Root>
  )
}
