import {
  createContext,
  useContext,
  isValidElement,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { asChildElement } from "./render-slot"
import {
  OverlayFocusScope,
  OverlayLayer,
  useOverlayFocus,
} from "../lib/overlay-layer"
import { ThemePortalScope, useThemePortalContainer } from "./theme-boundary"
import { useI18n } from "../lib/i18n-provider"
import { cn } from "../lib/utils"

/** Element focused before the dialog opened; Base UI restores focus to it. */
const RestoreFocus = createContext<RefObject<HTMLElement | null> | undefined>(
  undefined,
)

export function Dialog({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <RestoreFocus.Provider value={target}>
        <DialogPrimitive.Root
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
      </RestoreFocus.Provider>
    </OverlayFocusScope>
  )
}

/** `render` supplies a polymorphic trigger element; children stay inside it. */
export function DialogTrigger({
  render,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger> & {
  render?: ReactNode
}) {
  if (isValidElement(render))
    return (
      <DialogPrimitive.Trigger asChild {...props}>
        {asChildElement(render, children)}
      </DialogPrimitive.Trigger>
    )
  return (
    <DialogPrimitive.Trigger {...props}>{children}</DialogPrimitive.Trigger>
  )
}

/** `render` supplies a polymorphic close element; children stay inside it. */
export function DialogClose({
  render,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close> & {
  render?: ReactNode
}) {
  if (render !== undefined)
    return (
      <DialogPrimitive.Close asChild {...props}>
        {asChildElement(render, children)}
      </DialogPrimitive.Close>
    )
  return <DialogPrimitive.Close {...props}>{children}</DialogPrimitive.Close>
}

export function DialogContent({
  className,
  children,
  style,
  finalFocus,
  initialFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  className?: string
  /** Base UI parity: element or resolver that receives focus on close. */
  finalFocus?:
    (() => HTMLElement | false | null) | React.RefObject<HTMLElement | null>
  /** Base UI parity: `false` skips autofocus, a ref focuses that element. */
  initialFocus?: boolean | React.RefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  const portalContainer = useThemePortalContainer()
  const restoreRef = useContext(RestoreFocus)

  return (
    <OverlayLayer>
      {(layerStyle) => (
        <DialogPrimitive.Portal
          container={portalContainer?.current ?? undefined}
        >
          <ThemePortalScope>
            <DialogPrimitive.Overlay
              style={layerStyle}
              data-overlay-backdrop="dialog"
              className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-[var(--motion-panel)] motion-reduce:transition-none data-[state=closed]:opacity-0"
            />
            <DialogPrimitive.Content
              {...props}
              style={{ ...layerStyle, ...style } as CSSProperties}
              onOpenAutoFocus={(event) => {
                if (initialFocus === false) {
                  event.preventDefault()
                  return
                }
                if (initialFocus && typeof initialFocus === "object") {
                  event.preventDefault()
                  initialFocus.current?.focus({ preventScroll: true })
                  return
                }
                onOpenAutoFocus?.(event)
              }}
              onCloseAutoFocus={(event) => {
                // Base UI returns focus to whatever opened the dialog, including
                // keyboard callers without a Radix trigger; mirror that first.
                const restore = restoreRef?.current
                if (restore && restore.isConnected) {
                  event.preventDefault()
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                      const active = document.activeElement
                      // Radix may still be unwinding its own `aria-hidden`,
                      // so only an inert subtree blocks the restore.
                      if (
                        !restore.closest("[inert]") &&
                        (active === document.body ||
                          active === null ||
                          active === restore)
                      )
                        restore.focus({ preventScroll: true })
                    }),
                  )
                }
                if (finalFocus) {
                  event.preventDefault()
                  const target =
                    typeof finalFocus === "function"
                      ? finalFocus()
                      : finalFocus.current
                  if (target && target.isConnected)
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() =>
                        target.focus({ preventScroll: true }),
                      ),
                    )
                  return
                }
                onCloseAutoFocus?.(event)
              }}
              className={cn(
                "fixed top-1/2 left-1/2 w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden -translate-x-1/2 -translate-y-1/2 rounded-panel border bg-surface p-6 shadow-[var(--shadow-floating)] outline-none transition-[opacity,scale] duration-[var(--motion-panel)] motion-reduce:transition-none data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
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
            </DialogPrimitive.Content>
          </ThemePortalScope>
        </DialogPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  className?: string
}) {
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
}: React.ComponentProps<typeof DialogPrimitive.Description> & {
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
