"use client"
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { useI18n } from "../../lib/i18n-provider"
import { Sheet, SheetContent, type SheetContentProps } from "./sheet"
import { Button } from "./button"
export {
  SheetTrigger as DrawerTrigger,
  SheetClose as DrawerClose,
  SheetTitle as DrawerTitle,
  SheetDescription as DrawerDescription,
  SheetHeader as DrawerHeader,
  SheetBody as DrawerBody,
  SheetFooter as DrawerFooter,
} from "./sheet"
const Context = createContext<{ close: () => void } | null>(null)
export type DrawerProps = Omit<
  ComponentProps<typeof Sheet>,
  "open" | "defaultOpen" | "onOpenChange"
> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}
export function Drawer({
  open: provided,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: DrawerProps) {
  const [internal, setInternal] = useState(defaultOpen)
  const open = provided ?? internal
  const change = (next: boolean) => {
    if (provided === undefined) setInternal(next)
    onOpenChange?.(next)
  }
  return (
    <Context.Provider value={{ close: () => change(false) }}>
      <Sheet {...props} open={open} onOpenChange={change}>
        {children}
      </Sheet>
    </Context.Provider>
  )
}
export function DrawerContent({
  swipeToClose = false,
  side = "bottom",
  children,
  ...props
}: SheetContentProps & { swipeToClose?: boolean }) {
  const context = useContext(Context)
  const { t } = useI18n()
  const start = useRef<{ id: number; y: number } | null>(null)
  const suppress = useRef(false)
  return (
    <SheetContent {...props} side={side}>
      {swipeToClose && side === "bottom" && (
        <Button
          variant="ghost"
          aria-label={t("drawer.close")}
          className="mx-auto min-h-11 min-w-11 touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0 || start.current) return
            start.current = { id: event.pointerId, y: event.clientY }
            suppress.current = false
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerCancel={(event) => {
            if (start.current?.id !== event.pointerId) return
            start.current = null
            suppress.current = true
          }}
          onPointerUp={(event) => {
            const before = start.current
            if (!before || before.id !== event.pointerId) return
            start.current = null
            const delta = event.clientY - before.y
            suppress.current = Math.abs(delta) > 8
            if (delta >= 48) context?.close()
          }}
          onClick={(event) => {
            if (event.detail !== 0 && suppress.current) {
              suppress.current = false
              return
            }
            context?.close()
          }}
        >
          <span aria-hidden="true" className="h-1 w-8 rounded-full bg-border" />
        </Button>
      )}
      {children}
    </SheetContent>
  )
}
