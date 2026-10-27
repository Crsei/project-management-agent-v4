import type { ReactNode } from "react"
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu"
import { OverlayLayer } from "../../lib/overlay-layer"
import { useThemePortalContainer } from "./theme-boundary"
import { asChildElement } from "./render-slot"
import { cn } from "../../lib/utils"

export const Menu = MenuPrimitive.Root

/** `render` supplies a polymorphic trigger element; children stay inside it. */
export function MenuTrigger({
  render,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Trigger> & {
  render?: ReactNode
}) {
  if (render === undefined)
    return <MenuPrimitive.Trigger {...props}>{children}</MenuPrimitive.Trigger>
  return (
    <MenuPrimitive.Trigger asChild {...props}>
      {asChildElement(render, children)}
    </MenuPrimitive.Trigger>
  )
}

export const MenuGroup = MenuPrimitive.Group
export const MenuGroupLabel = MenuPrimitive.Label

export function MenuContent({
  className,
  children,
  align,
  side,
  style,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content> & {
  className?: string
}) {
  const container = useThemePortalContainer()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <MenuPrimitive.Portal container={container?.current ?? undefined}>
          <MenuPrimitive.Content
            align={align}
            side={side}
            sideOffset={6}
            collisionPadding={8}
            style={{ ...layerStyle, ...style }}
            {...props}
            className={cn(
              "min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
              className,
            )}
          >
            {children}
          </MenuPrimitive.Content>
        </MenuPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}

/** `render` supplies a polymorphic item element; children stay inside it. */
export function MenuItem({
  className,
  render,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & {
  className?: string
  render?: ReactNode
}) {
  return (
    <MenuPrimitive.Item
      {...props}
      {...(render !== undefined ? { asChild: true } : {})}
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-highlighted:bg-surface-hover data-highlighted:text-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {render === undefined ? children : asChildElement(render, children)}
    </MenuPrimitive.Item>
  )
}
