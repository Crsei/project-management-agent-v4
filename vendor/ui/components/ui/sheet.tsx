"use client"
import {
  OverlayFocusScope,
  useOverlayFocus,
  OverlayLayer,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import type { CSSProperties, ComponentProps } from "react"
import { Dialog as Base } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import { Button } from "./button"
import { ThemePortalScope, useThemePortalContainer } from "./theme-boundary"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import styles from "./sheet.module.css"
export function Sheet<Payload = unknown>({
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
export const SheetTrigger = Base.Trigger
export const SheetClose = Base.Close
export const SheetTitle = Base.Title
export const SheetDescription = Base.Description
export type SheetContentProps = Omit<
  Base.Popup.Props,
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
  const finalFocus = useOverlayFinalFocus()
  const { t } = useI18n()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <Base.Portal container={container}>
          <Base.Backdrop
            data-overlay-backdrop="sheet"
            style={layerStyle}
            className={styles.backdrop}
          />
          <Base.Popup
            finalFocus={finalFocus}
            {...props}
            data-side={side}
            className={cn(styles.content, className)}
            style={
              {
                ...layerStyle,
                "--sheet-size": `${Number.isFinite(size) ? Math.max(200, size) : 352}px`,
                ...props.style,
              } as CSSProperties
            }
          >
            <ThemePortalScope className="contents">{children}</ThemePortalScope>
            <Base.Close
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  className={styles.close}
                  aria-label={t("dialog.closeDialog")}
                />
              }
            >
              <X size={16} />
            </Base.Close>
          </Base.Popup>
        </Base.Portal>
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
