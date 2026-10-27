import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"
import {
  OverlayFocusScope,
  OverlayLayer,
  useOverlayFocus,
} from "../../lib/overlay-layer"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

export function AlertDialog({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <AlertDialogPrimitive.Root
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
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger
export const AlertDialogCancel = AlertDialogPrimitive.Cancel
export const AlertDialogTitle = AlertDialogPrimitive.Title
export const AlertDialogDescription = AlertDialogPrimitive.Description
/** Confirmation actions are ordinary caller buttons; resolution does not close or imply success. */
export function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  className?: string
}) {
  const container = useThemePortalContainer()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <AlertDialogPrimitive.Portal container={container?.current ?? undefined}>
          <AlertDialogPrimitive.Overlay
            style={layerStyle}
            className="fixed inset-0 bg-black/40"
          />
          <AlertDialogPrimitive.Content
            {...props}
            style={layerStyle}
            className={cn(
              "fixed left-1/2 top-1/2 grid w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-auto overscroll-contain -translate-x-1/2 -translate-y-1/2 gap-3 rounded-panel border bg-surface p-4 text-sm text-foreground shadow-[var(--shadow-floating)] outline-none",
              className,
            )}
          />
        </AlertDialogPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
