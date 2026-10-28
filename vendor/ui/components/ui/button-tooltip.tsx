"use client"
import { OverlayLayer } from "../../lib/overlay-layer"
import { useThemePortalContainer } from "./theme-boundary"

import { cloneElement, useId, useRef, useState, type ReactElement } from "react"
import { Tooltip } from "@base-ui/react/tooltip"

// Keep interactive tooltip handling separate from server-safe buttonVariants.
export function ButtonTooltip({
  label,
  children,
}: {
  label: string
  children: ReactElement<{ "aria-describedby"?: string }>
}) {
  const portalContainer = useThemePortalContainer()
  const descriptionId = useId()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [owner, setOwner] = useState<HTMLElement | null>(null)
  // Keep supplemental content in its trigger's semantic and theme scope.
  const tooltipContainer = owner ?? portalContainer
  const callerDescription = children.props["aria-describedby"]
  const describedBy = open
    ? callerDescription
      ? `${callerDescription} ${descriptionId}`
      : descriptionId
    : callerDescription

  return (
    <Tooltip.Root
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) {
          const ancestor = triggerRef.current?.closest<HTMLElement>(
            "main, header, aside, nav, [role=main], [role=banner], [role=complementary], [role=navigation], [role=region], [role=dialog], [role=alertdialog]",
          )
          const scope = portalContainer?.current
          setOwner(
            ancestor && (!scope || scope.contains(ancestor)) ? ancestor : null,
          )
        }
        setOpen(nextOpen)
        if (details.reason === "escape-key") details.allowPropagation()
      }}
    >
      <Tooltip.Trigger
        render={cloneElement(children, { "aria-describedby": describedBy })}
        delay={300}
        ref={triggerRef}
      />
      <OverlayLayer>
        {(layerStyle) => (
          <Tooltip.Portal container={tooltipContainer} className="contents">
            <Tooltip.Positioner
              style={layerStyle}
              sideOffset={8}
              positionMethod="fixed"
              className=""
            >
              <Tooltip.Popup
                id={descriptionId}
                role="tooltip"
                className="rounded-md border bg-surface px-2 py-1 text-xs text-foreground shadow-[var(--shadow-floating)]"
              >
                {label}
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        )}
      </OverlayLayer>
    </Tooltip.Root>
  )
}
