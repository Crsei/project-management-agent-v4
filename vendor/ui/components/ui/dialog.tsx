"use client"
import {
  OverlayFocusScope,
  useOverlayFocus,
  OverlayLayer,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import { ThemePortalScope, useThemePortalContainer } from "./theme-boundary"
import { useI18n } from "../../lib/i18n-provider"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"

export function Dialog<Payload = unknown>({
  onOpenChange,
  ...props
}: DialogPrimitive.Root.Props<Payload>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <DialogPrimitive.Root<Payload>
        {...props}
        onOpenChange={(open, details) => {
          onOpenChange?.(open, details)
          track(open, details)
        }}
      />
    </OverlayFocusScope>
  )
}
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  className,
  children,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "className"> & { className?: string }) {
  const { t } = useI18n()
  const portalContainer = useThemePortalContainer()
  const finalFocus = useOverlayFinalFocus()

  return (
    <OverlayLayer>
      {(layerStyle) => (
        <DialogPrimitive.Portal container={portalContainer}>
          <ThemePortalScope>
            <DialogPrimitive.Backdrop
              style={layerStyle}
              data-overlay-backdrop="dialog"
              className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-[var(--motion-panel)] motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0"
            />
            <DialogPrimitive.Popup
              finalFocus={finalFocus}
              {...props}
              style={{ ...layerStyle, ...props.style }}
              className={cn(
                "fixed top-1/2 left-1/2 w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-6 shadow-[var(--shadow-floating)] outline-none transition-[opacity,scale] duration-[var(--motion-panel)] motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
                className,
              )}
            >
              <div className="flex min-h-0 flex-col overflow-auto overscroll-contain">
                {children}
              </div>
              <DialogPrimitive.Close
                aria-label={t("dialog.closeDialog")}
                className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [@media(pointer:coarse)]:size-11"
              >
                <X aria-hidden="true" size={16} strokeWidth={1.8} />
              </DialogPrimitive.Close>
            </DialogPrimitive.Popup>
          </ThemePortalScope>
        </DialogPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}

export function DialogTitle({
  className,
  ...props
}: Omit<DialogPrimitive.Title.Props, "className"> & { className?: string }) {
  return (
    <DialogPrimitive.Title
      {...props}
      className={cn("pr-8 text-lg font-semibold tracking-tight", className)}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: Omit<DialogPrimitive.Description.Props, "className"> & {
  className?: string
}) {
  return (
    <DialogPrimitive.Description
      {...props}
      className={cn("mt-2 text-sm leading-6 text-muted-foreground", className)}
    />
  )
}

/** Optional slots keep actions fixed while the body owns long-content scrolling. */
export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("shrink-0 max-h-[25dvh] overflow-auto pr-8", className)}
    />
  )
}
export function DialogBody({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "min-h-0 flex-1 overflow-auto overscroll-contain py-3",
        className,
      )}
    />
  )
}
export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex shrink-0 flex-wrap justify-end gap-2 pt-3",
        className,
      )}
    />
  )
}
