"use client"
import { PreviewCard as Base } from "@base-ui/react/preview-card"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"
export const HoverCard = Base.Root
export const HoverCardTrigger = Base.Trigger
/** Optional preview only; expose important content through the trigger's link or a visible button. */
export function HoverCardContent({
  className,
  side = "bottom",
  align = "start",
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
    <Base.Portal container={container}>
      <Base.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-[70]"
      >
        <Base.Popup
          {...props}
          className={cn(
            "max-w-xs rounded-panel border bg-surface p-3 text-sm text-foreground shadow-[var(--shadow-floating)] outline-none",
            className,
          )}
        />
      </Base.Positioner>
    </Base.Portal>
  )
}
