"use client"
import {
  OverlayFocusScope,
  useOverlayFocus,
  OverlayLayer,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

export function Popover<Payload = unknown>({
  onOpenChange,
  ...props
}: PopoverPrimitive.Root.Props<Payload>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <PopoverPrimitive.Root<Payload>
        {...props}
        onOpenChange={(open, details) => {
          onOpenChange?.(open, details)
          track(open, details)
        }}
      />
    </OverlayFocusScope>
  )
}
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close
export const PopoverTitle = PopoverPrimitive.Title
export const PopoverDescription = PopoverPrimitive.Description

export function PopoverContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: Omit<PopoverPrimitive.Popup.Props, "className"> & {
  className?: string
  side?: PopoverPrimitive.Positioner.Props["side"]
  align?: PopoverPrimitive.Positioner.Props["align"]
  sideOffset?: number
}) {
  const container = useThemePortalContainer()
  const finalFocus = useOverlayFinalFocus()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <PopoverPrimitive.Portal container={container}>
          <PopoverPrimitive.Positioner
            style={layerStyle}
            side={side}
            align={align}
            sideOffset={sideOffset}
            className=""
          >
            <PopoverPrimitive.Popup
              finalFocus={finalFocus}
              {...props}
              className={cn(
                "max-h-[var(--available-height)] max-w-[var(--available-width)] overflow-auto min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
                className,
              )}
            >
              {children}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
