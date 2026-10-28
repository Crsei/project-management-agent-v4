"use client"
import { OverlayLayer } from "../../lib/overlay-layer"
import { Tooltip as Base } from "@base-ui/react/tooltip"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"
export const TooltipProvider = Base.Provider
export const Tooltip = Base.Root
export const TooltipTrigger = Base.Trigger
export function TooltipContent({
  className,
  side = "top",
  align = "center",
  sideOffset = 8,
  ...props
}: Omit<Base.Popup.Props, "className"> & {
  className?: string
  side?: Base.Positioner.Props["side"]
  align?: Base.Positioner.Props["align"]
  sideOffset?: number
}) {
  const container = useThemePortalContainer()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <Base.Portal container={container}>
          <Base.Positioner
            style={layerStyle}
            side={side}
            align={align}
            sideOffset={sideOffset}
            className=""
          >
            <Base.Popup
              role="tooltip"
              {...props}
              className={cn(
                "max-w-xs rounded-control border bg-surface px-2 py-1 text-xs text-foreground shadow-[var(--shadow-floating)]",
                className,
              )}
            />
          </Base.Positioner>
        </Base.Portal>
      )}
    </OverlayLayer>
  )
}
