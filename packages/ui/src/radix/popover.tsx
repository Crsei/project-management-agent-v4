import { isValidElement, type CSSProperties, type ReactNode } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import {
  OverlayFocusScope,
  OverlayLayer,
  useOverlayFocus,
  useOverlayFinalFocus,
} from "../lib/overlay-layer"
import { asChildElement } from "./render-slot"
import { cn } from "../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

export function Popover({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <PopoverPrimitive.Root
        {...props}
        onOpenChange={(open) => {
          onOpenChange?.(open)
          track(
            open,
            open
              ? {
                  trigger: document.activeElement ?? undefined,
                  isCanceled: false,
                }
              : { trigger: undefined, isCanceled: true },
          )
        }}
      />
    </OverlayFocusScope>
  )
}

/** `render` supplies a polymorphic trigger element; children stay inside it. */
export function PopoverTrigger({
  render,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger> & {
  render?: ReactNode
}) {
  if (isValidElement(render))
    return (
      <PopoverPrimitive.Trigger asChild {...props}>
        {asChildElement(render, children)}
      </PopoverPrimitive.Trigger>
    )
  return (
    <PopoverPrimitive.Trigger {...props}>{children}</PopoverPrimitive.Trigger>
  )
}

/** `render` supplies a polymorphic close element; children stay inside it. */
export function PopoverClose({
  render,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Close> & {
  render?: ReactNode
}) {
  if (render !== undefined)
    return (
      <PopoverPrimitive.Close asChild {...props}>
        {asChildElement(render, children)}
      </PopoverPrimitive.Close>
    )
  return <PopoverPrimitive.Close {...props}>{children}</PopoverPrimitive.Close>
}

export const PopoverTitle = PopoverPrimitive.Title
export const PopoverDescription = PopoverPrimitive.Description

export function PopoverContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  className?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
}) {
  const container = useThemePortalContainer()
  // Base UI's popup received a `finalFocus` element; Radix restores focus to
  // the trigger itself, so the recorded opener is reasserted instead.
  const finalFocus = useOverlayFinalFocus()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <PopoverPrimitive.Portal container={container?.current ?? undefined}>
          <PopoverPrimitive.Content
            {...props}
            side={side}
            align={align}
            sideOffset={sideOffset}
            onCloseAutoFocus={(event) => {
              const target = finalFocus()
              if (target && target.isConnected) {
                event.preventDefault()
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    target.focus({ preventScroll: true }),
                  ),
                )
              }
              props.onCloseAutoFocus?.(event)
            }}
            style={
              {
                ...layerStyle,
                // Base UI names the available space; Radix names it per anchor.
                "--available-height":
                  "var(--radix-popover-content-available-height)",
                "--available-width":
                  "var(--radix-popover-content-available-width)",
                ...style,
              } as CSSProperties
            }
            className={cn(
              "max-h-[var(--available-height)] max-w-[var(--available-width)] overflow-auto min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
              className,
            )}
          >
            {children}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
