"use client"
import { Accordion as Base } from "@base-ui/react/accordion"
import { ChevronDown } from "lucide-react"
import { cn } from "../../lib/utils"
export const Accordion = Base.Root
export function AccordionItem({
  className,
  ...props
}: Omit<Base.Item.Props, "className"> & { className?: string }) {
  return <Base.Item {...props} className={cn("border-b", className)} />
}
export function AccordionTrigger({
  className,
  children,
  ...props
}: Omit<Base.Trigger.Props, "className"> & { className?: string }) {
  return (
    <Base.Header>
      <Base.Trigger
        {...props}
        className={cn(
          "group flex min-h-8 w-full items-center justify-between gap-3 rounded-control py-2 text-left text-[13px] outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-45 [@media(pointer:coarse)]:min-h-11",
          className,
        )}
      >
        {children}
        <ChevronDown
          aria-hidden="true"
          size={16}
          className="shrink-0 group-data-panel-open:rotate-180"
        />
      </Base.Trigger>
    </Base.Header>
  )
}
export function AccordionContent({
  className,
  ...props
}: Omit<Base.Panel.Props, "className"> & { className?: string }) {
  return (
    <Base.Panel
      {...props}
      className={cn("pb-3 text-sm leading-6", className)}
    />
  )
}
