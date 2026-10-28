"use client"
import {
  OverlayFocusScope,
  OverlayLayer,
  useOverlayFocus,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { Check } from "lucide-react"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

export function Combobox<
  Value,
  Multiple extends boolean | undefined = false,
  Item = Value,
>({
  onOpenChange,
  ...props
}: ComboboxPrimitive.Root.Props<Value, Multiple, Item>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <ComboboxPrimitive.Root<Value, Multiple, Item>
        {...props}
        onOpenChange={(open, details) => {
          onOpenChange?.(open, details)
          track(open, details)
        }}
      />
    </OverlayFocusScope>
  )
}
export const ComboboxList = ComboboxPrimitive.List
export const ComboboxEmpty = ComboboxPrimitive.Empty
export const ComboboxTrigger = ComboboxPrimitive.Trigger

export function ComboboxContent({
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Popup.Props, "className"> & { className?: string }) {
  const container = useThemePortalContainer()
  const finalFocus = useOverlayFinalFocus()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <ComboboxPrimitive.Portal container={container}>
          <ComboboxPrimitive.Positioner
            style={layerStyle}
            sideOffset={6}
            className=""
          >
            <ComboboxPrimitive.Popup
              finalFocus={finalFocus}
              {...props}
              className={cn(
                "min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
                className,
              )}
            >
              {children}
            </ComboboxPrimitive.Popup>
          </ComboboxPrimitive.Positioner>
        </ComboboxPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
export function ComboboxItem({
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Item.Props, "className"> & { className?: string }) {
  return (
    <ComboboxPrimitive.Item
      {...props}
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-highlighted:bg-surface-hover data-highlighted:text-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator className="ml-auto" aria-hidden="true">
        <Check aria-hidden="true" size={14} strokeWidth={2.7} />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}
export function ComboboxInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "className"> & { className?: string }) {
  return (
    <ComboboxPrimitive.Input
      {...props}
      className={cn(
        "h-control rounded-md border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
