"use client"
import { OverlayLayer } from "../../lib/overlay-layer"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger
export const MenuGroup = MenuPrimitive.Group
export const MenuGroupLabel = MenuPrimitive.GroupLabel

export function MenuContent({
  className,
  children,
  align,
  side,
  ...props
}: Omit<MenuPrimitive.Popup.Props, "className"> & { className?: string; align?: MenuPrimitive.Positioner.Props["align"]; side?: MenuPrimitive.Positioner.Props["side"] }) {
  const container = useThemePortalContainer()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <MenuPrimitive.Portal container={container}>
          <MenuPrimitive.Positioner
            style={layerStyle}
            sideOffset={6}
            align={align}
            side={side}
            className=""
          >
            <MenuPrimitive.Popup
              {...props}
              className={cn(
                "min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
                className,
              )}
            >
              {children}
            </MenuPrimitive.Popup>
          </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
export function MenuItem({
  className,
  ...props
}: Omit<MenuPrimitive.Item.Props, "className"> & { className?: string }) {
  return (
    <MenuPrimitive.Item
      {...props}
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-highlighted:bg-surface-hover data-highlighted:text-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
