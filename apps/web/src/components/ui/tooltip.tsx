import { OverlayLayer } from "../../lib/overlay-layer"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

/** Radix requires an ancestor provider; consumers wrap once at app root. */
export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  side = "top",
  align = "center",
  sideOffset = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  className?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
}) {
  const container = useThemePortalContainer()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <TooltipPrimitive.Portal container={container?.current ?? undefined}>
          <TooltipPrimitive.Content
            {...props}
            side={side}
            align={align}
            sideOffset={sideOffset}
            style={layerStyle}
            className={cn(
              "max-w-xs rounded-control border bg-surface px-2 py-1 text-xs text-foreground shadow-[var(--shadow-floating)]",
              className,
            )}
          >
            {children}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
