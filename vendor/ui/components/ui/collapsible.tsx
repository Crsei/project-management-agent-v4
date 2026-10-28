"use client"
import { Collapsible as Base } from "@base-ui/react/collapsible"
import { cn } from "../../lib/utils"
export const Collapsible = Base.Root
export const CollapsibleTrigger = Base.Trigger
export function CollapsibleContent({
  className,
  ...props
}: Omit<Base.Panel.Props, "className"> & { className?: string }) {
  return (
    <Base.Panel {...props} className={cn("text-sm leading-6", className)} />
  )
}
