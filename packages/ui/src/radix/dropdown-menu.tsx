import { createContext, useContext, useState, type ReactNode } from "react"
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Check, ChevronRight } from "lucide-react"
import { OverlayLayer } from "../lib/overlay-layer"
import { useThemePortalContainer } from "./theme-boundary"
import { asChildElement } from "./render-slot"
import { cn } from "../lib/utils"

const item =
  "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"

/** Radix closes plain items on select but keeps checkbox/radio items open;
 * `closeOnClick` keeps the Base UI call shape meaningful on those items. */
const MenuClose = createContext<(() => void) | null>(null)

export function DropdownMenu({
  open: openProp,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = openProp ?? uncontrolled
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolled(next)
    onOpenChange?.(next)
  }
  return (
    <MenuClose.Provider value={() => setOpen(false)}>
      <MenuPrimitive.Root {...props} open={open} onOpenChange={setOpen} />
    </MenuClose.Provider>
  )
}

/** `render` supplies a polymorphic trigger element; children stay inside it. */
export function DropdownMenuTrigger({
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

export function DropdownMenuContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 6,
  style,
  children,
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
            sideOffset={sideOffset}
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

export function DropdownMenuItem({
  className,
  closeOnClick,
  render,
  children,
  onSelect,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & {
  className?: string
  /** Base UI compatibility: Radix already closes plain items on select. */
  closeOnClick?: boolean
  /** Base UI compatibility: polymorphic render element (e.g. an anchor). */
  render?: ReactNode
}) {
  const close = useContext(MenuClose)
  return (
    <MenuPrimitive.Item
      {...props}
      {...(render !== undefined ? { asChild: true } : {})}
      onSelect={(event) => {
        if (closeOnClick === false) event.preventDefault()
        onSelect?.(event)
        if (closeOnClick) close?.()
      }}
      className={cn(item, className)}
    >
      {render === undefined ? children : asChildElement(render, children)}
    </MenuPrimitive.Item>
  )
}

export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuLabel = MenuPrimitive.Label
export const DropdownMenuSeparator = MenuPrimitive.Separator
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup
export const DropdownMenuSub = MenuPrimitive.Sub

export function DropdownMenuCheckboxItem({
  className,
  children,
  closeOnClick,
  onSelect,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.CheckboxItem> & {
  className?: string
  closeOnClick?: boolean
}) {
  const close = useContext(MenuClose)
  return (
    <MenuPrimitive.CheckboxItem
      {...props}
      onSelect={(event) => {
        if (closeOnClick === false) event.preventDefault()
        onSelect?.(event)
        if (closeOnClick) close?.()
      }}
      className={cn(item, className)}
    >
      <span className="flex size-4 items-center">
        <MenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" size={14} />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  closeOnClick,
  onSelect,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem> & {
  className?: string
  closeOnClick?: boolean
}) {
  const close = useContext(MenuClose)
  return (
    <MenuPrimitive.RadioItem
      {...props}
      onSelect={(event) => {
        if (closeOnClick === false) event.preventDefault()
        onSelect?.(event)
        if (closeOnClick) close?.()
      }}
      className={cn(item, className)}
    >
      <span className="flex size-4 items-center">
        <MenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" size={14} />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.SubTrigger> & {
  className?: string
}) {
  return (
    <MenuPrimitive.SubTrigger {...props} className={cn(item, className)}>
      {children}
      <ChevronRight aria-hidden="true" size={14} className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.SubContent> & {
  className?: string
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        {...props}
        className={cn(
          "min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
          className,
        )}
      />
    </MenuPrimitive.Portal>
  )
}
