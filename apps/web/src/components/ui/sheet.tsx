import {
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
  type RefObject,
} from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import type { CSSProperties, ComponentProps } from "react"
import { X } from "lucide-react"
import {
  OverlayFocusScope,
  OverlayLayer,
  useOverlayFocus,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import { Button } from "./button"
import { ThemePortalScope, useThemePortalContainer } from "./theme-boundary"
import { useI18n } from "../../lib/i18n-provider"
import { asChildElement } from "./render-slot"
import { cn } from "../../lib/utils"
import styles from "./sheet.module.css"

/** Element focused before the sheet opened; Base UI restores focus to it. */
const RestoreFocus = createContext<RefObject<HTMLElement | null> | undefined>(
  undefined,
)

/** Base UI parity: close requests carry a `cancel` veto. The caller owns the
 * controlled `open` prop, so a veto that returns without updating state keeps
 * the sheet open. */
export type SheetOpenChangeDetails = { cancel: () => void }

export function Sheet({
  onOpenChange,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Root>, "onOpenChange"> & {
  onOpenChange?: (open: boolean, details: SheetOpenChangeDetails) => void
}) {
  const { target, track } = useOverlayFocus()
  return (
    <OverlayFocusScope value={target}>
      <RestoreFocus.Provider value={target}>
        <DialogPrimitive.Root
          {...props}
          onOpenChange={(open) => {
            onOpenChange?.(open, { cancel: () => {} })
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
export function SheetTrigger({
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
export function SheetClose({
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

export const SheetTitle = DialogPrimitive.Title
export const SheetDescription = DialogPrimitive.Description

export type SheetContentProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  "className" | "style"
> & {
  className?: string
  style?: CSSProperties
  side?: "left" | "right" | "bottom"
  size?: number
}

export function SheetContent({
  side = "right",
  size = 352,
  className,
  children,
  ...props
}: SheetContentProps) {
  const container = useThemePortalContainer()
  // Base UI's `finalFocus` targeted the popup element; Radix already restores
  // focus to the trigger, so only the recorded opener is reasserted.
  const finalFocus = useOverlayFinalFocus()
  const restoreRef = useContext(RestoreFocus)
  const { t } = useI18n()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <DialogPrimitive.Portal container={container?.current ?? undefined}>
          <DialogPrimitive.Overlay
            data-overlay-backdrop="sheet"
            style={layerStyle}
            className={styles.backdrop}
          />
          <DialogPrimitive.Content
            {...props}
            data-side={side}
            style={
              {
                ...layerStyle,
                "--sheet-size": `${
                  Number.isFinite(size) ? Math.max(200, size) : 352
                }px`,
                ...props.style,
              } as CSSProperties
            }
            onCloseAutoFocus={(event) => {
              const restore = restoreRef?.current
              if (restore && restore.isConnected) {
                event.preventDefault()
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    const active = document.activeElement
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
              const target = finalFocus()
              if (target && target.isConnected) {
                event.preventDefault()
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    target.focus({ preventScroll: true }),
                  ),
                )
              }
            }}
            className={cn(styles.content, className)}
          >
            <ThemePortalScope className="contents">{children}</ThemePortalScope>
            <DialogPrimitive.Close asChild>
              {asChildElement(
                <Button
                  size="icon"
                  variant="ghost"
                  className={styles.close}
                  aria-label={t("dialog.closeDialog")}
                />,
                <X size={16} />,
              )}
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}
export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.header, className)} />
}
export function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.body, className)} />
}
export function SheetFooter({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.footer, className)} />
}
