"use client"
import { NavigationMenu as Base } from "@base-ui/react/navigation-menu"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"
export const NavigationMenu = Base.Root
export const NavigationMenuItem = Base.Item
export function NavigationMenuList({
  className,
  ...props
}: Omit<Base.List.Props, "className"> & { className?: string }) {
  return (
    <Base.List
      {...props}
      className={cn("flex items-center gap-1", className)}
    />
  )
}
export function NavigationMenuTrigger({
  className,
  ...props
}: Omit<Base.Trigger.Props, "className"> & { className?: string }) {
  return (
    <Base.Trigger
      {...props}
      className={cn(
        "inline-flex min-h-8 items-center gap-2 rounded-control px-3 text-[13px] outline-none hover:bg-surface-hover data-popup-open:bg-selection focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
export function NavigationMenuContent({
  className,
  ...props
}: Omit<Base.Content.Props, "className"> & { className?: string }) {
  return <Base.Content {...props} className={cn("grid gap-1 p-2", className)} />
}
export function NavigationMenuLink({
  className,
  ...props
}: Omit<Base.Link.Props, "className"> & { className?: string }) {
  return (
    <Base.Link
      {...props}
      className={cn(
        "inline-flex min-h-8 items-center rounded-control px-3 text-[13px] outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selection [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
export function NavigationMenuViewport({
  className,
  ...props
}: Omit<Base.Popup.Props, "className"> & { className?: string }) {
  const container = useThemePortalContainer()
  return (
    <Base.Portal container={container}>
      <Base.Positioner sideOffset={8} className="z-[70]">
        <Base.Popup
          {...props}
          className={cn(
            "max-h-[var(--available-height)] min-w-48 overflow-auto rounded-panel border bg-surface text-foreground shadow-[var(--shadow-floating)] outline-none",
            className,
          )}
        >
          <Base.Viewport />
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  )
}
