import {
  cloneElement,
  useId,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { OverlayLayer } from "../lib/overlay-layer"
import { useThemePortalContainer } from "./theme-boundary"

/** Keep interactive tooltip handling separate from server-safe buttonVariants. */
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
  const triggerRef = useRef<HTMLElement | null>(null)
  const [owner, setOwner] = useState<HTMLElement | null>(null)
  // Keep supplemental content in its trigger's semantic and theme scope.
  const tooltipContainer = owner ?? portalContainer?.current
  const callerDescription = children.props["aria-describedby"]
  const describedBy = open
    ? callerDescription
      ? `${callerDescription} ${descriptionId}`
      : descriptionId
    : callerDescription

  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={300}>
      <TooltipPrimitive.Root
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            const ancestor = triggerRef.current?.closest<HTMLElement>(
              "main, header, aside, nav, [role=main], [role=banner], [role=complementary], [role=navigation], [role=region], [role=dialog], [role=alertdialog]",
            )
            const scope = portalContainer?.current
            setOwner(
              ancestor && (!scope || scope.contains(ancestor))
                ? ancestor
                : null,
            )
          }
          setOpen(nextOpen)
        }}
      >
        <TooltipPrimitive.Trigger
          asChild
          ref={triggerRef as Ref<HTMLButtonElement>}
        >
          {cloneElement(children as ReactElement<Record<string, unknown>>, {
            "aria-describedby": describedBy,
          })}
        </TooltipPrimitive.Trigger>
        <OverlayLayer>
          {(layerStyle) => (
            <TooltipPrimitive.Portal container={tooltipContainer ?? undefined}>
              <TooltipPrimitive.Content
                id={descriptionId}
                role="tooltip"
                sideOffset={8}
                style={layerStyle}
                className="rounded-md border bg-surface px-2 py-1 text-xs text-foreground shadow-[var(--shadow-floating)]"
              >
                {label}
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          )}
        </OverlayLayer>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
