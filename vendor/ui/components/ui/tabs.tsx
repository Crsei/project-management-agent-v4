"use client"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "../../lib/utils"
export const Tabs = TabsPrimitive.Root
export function TabsList({
  className,
  ...props
}: Omit<TabsPrimitive.List.Props, "className"> & { className?: string }) {
  return (
    <TabsPrimitive.List
      {...props}
      className={cn("flex gap-1 border-b", className)}
    />
  )
}
export function TabsTab({
  className,
  ...props
}: Omit<TabsPrimitive.Tab.Props, "className"> & { className?: string }) {
  return (
    <TabsPrimitive.Tab
      {...props}
      className={cn(
        "min-h-8 border-b-2 border-transparent px-3 text-sm text-muted-foreground outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-active:border-primary data-active:text-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
export function TabsPanel({
  className,
  ...props
}: Omit<TabsPrimitive.Panel.Props, "className"> & { className?: string }) {
  return (
    <TabsPrimitive.Panel
      {...props}
      className={cn(
        "py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    />
  )
}
