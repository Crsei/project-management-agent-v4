"use client"
import {
  OverlayFocusScope,
  useOverlayFocus,
  OverlayLayer,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import { AlertDialog as Base } from "@base-ui/react/alert-dialog"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"
export function AlertDialog<Payload = unknown>({
  onOpenChange,
  ...props
}: Base.Root.Props<Payload>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <Base.Root<Payload>
        {...props}
        onOpenChange={(open, details) => {
          onOpenChange?.(open, details)
          track(open, details)
        }}
      />
    </OverlayFocusScope>
  )
}
export const AlertDialogTrigger = Base.Trigger
export const AlertDialogCancel = Base.Close
export const AlertDialogTitle = Base.Title
export const AlertDialogDescription = Base.Description
/** Confirmation actions are ordinary caller buttons; resolution does not close or imply success. */
export function AlertDialogContent({
  className,
  ...props
}: Omit<Base.Popup.Props, "className"> & { className?: string }) {
  const container = useThemePortalContainer()
  const finalFocus = useOverlayFinalFocus()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <Base.Portal container={container}>
          <Base.Backdrop
            style={layerStyle}
            className="fixed inset-0 bg-black/40"
          />
          <Base.Popup
            finalFocus={finalFocus}
            {...props}
            style={{ ...layerStyle, ...props.style }}
            className={cn(
              "fixed left-1/2 top-1/2 grid w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-auto overscroll-contain -translate-x-1/2 -translate-y-1/2 gap-3 rounded-panel border bg-surface p-4 text-sm text-foreground shadow-[var(--shadow-floating)] outline-none",
              className,
            )}
          />
        </Base.Portal>
      )}
    </OverlayLayer>
  )
}
