import {
  createContext, forwardRef, useCallback, useContext, useMemo, useRef, useState,
  type ComponentProps, type ReactNode, type RefObject,
} from "react"
import * as MenuPrimitive from "@radix-ui/react-menu"
import { Slot } from "@radix-ui/react-slot"
import { Check, ChevronRight } from "lucide-react"
import { OverlayLayer } from "../../lib/overlay-layer"
import { useThemePortalContainer } from "./theme-boundary"
import { cn } from "../../lib/utils"

type Point = { x: number; y: number }
type FocusTarget = HTMLElement | SVGElement
type CloseReason = "escape" | "outside" | "select" | null
type MenuScope = {
  show: (point: Point, trigger: FocusTarget | null) => void
  trigger: RefObject<FocusTarget | null>
  reason: RefObject<CloseReason>
  nativeDialog: HTMLDialogElement | null | undefined
}
const Scope = createContext<MenuScope | null>(null)
const itemStyle = "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
const popupStyle = "min-w-40 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none"

/** Object menus leave editing, native links, selected text and embedded tools alone. */
export function isNativeContextTarget(target: EventTarget | null, allowNativeTarget = false) {
  if (!(target instanceof Element)) return false
  if (target.closest('[data-native-context-menu], .xterm, iframe')) return true
  if (allowNativeTarget) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), a[href], img, pre, code')) return true
  const selection = target.ownerDocument.getSelection()
  return !!selection && !selection.isCollapsed && selection.containsNode(target, true)
}

export function ContextMenu({
  children, open: controlledOpen, onOpenChange, modal = false, anchor, returnFocus, ...props
}: Omit<ComponentProps<typeof MenuPrimitive.Root>, "open" | "onOpenChange"> & {
  children?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  anchor?: Point
  returnFocus?: FocusTarget | null
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [point, setPoint] = useState<Point>({ x: 0, y: 0 })
  const trigger = useRef<FocusTarget | null>(null)
  const reason = useRef<CloseReason>(null)
  const open = controlledOpen ?? internalOpen
  const changeOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }, [controlledOpen, onOpenChange])
  const show = useCallback((next: Point, element: FocusTarget | null) => {
    trigger.current = element
    reason.current = null
    setPoint(next)
    changeOpen(true)
  }, [changeOpen])
  const resolved = anchor ?? point
  const virtualRef = useMemo(() => ({ current: { getBoundingClientRect: () => DOMRect.fromRect({ x: resolved.x, y: resolved.y, width: 0, height: 0 }) } }), [resolved.x, resolved.y])
  // Imperative widget callbacks supply their actual focused row/node, not a hidden trigger.
  if (returnFocus !== undefined) trigger.current = returnFocus
  const nativeDialog = trigger.current?.closest<HTMLDialogElement>("dialog[open]")
  const scope = useMemo(() => ({ show, trigger, reason, nativeDialog }), [show, nativeDialog])
  return <Scope.Provider value={scope}><MenuPrimitive.Root {...props} open={open} onOpenChange={changeOpen} modal={modal}>
    <MenuPrimitive.Anchor virtualRef={virtualRef} />
    {children}
  </MenuPrimitive.Root></Scope.Provider>
}

type TriggerProps = ComponentProps<"span"> & { asChild?: boolean; disabled?: boolean; allowNativeTarget?: boolean }
export const ContextMenuTrigger = forwardRef<HTMLSpanElement, TriggerProps>(function ContextMenuTrigger({
  asChild, disabled = false, allowNativeTarget = false, onContextMenu, onKeyDown,
  onPointerDown, onPointerMove, onPointerCancel, onPointerUp, tabIndex, ...props
}, ref) {
  const scope = useContext(Scope)
  const pointer = useRef<{ x: number; y: number; moved: boolean; down: boolean; pending?: { point: Point; element: HTMLElement } } | null>(null)
  const Component = asChild ? Slot : "span"
  return <Component {...props} ref={ref} tabIndex={tabIndex ?? (disabled ? undefined : 0)} data-context-menu-trigger=""
    onPointerDown={event => {
      onPointerDown?.(event)
      if (event.button === 2) pointer.current = { x: event.clientX, y: event.clientY, moved: false, down: true }
    }}
    onPointerMove={event => {
      onPointerMove?.(event)
      const start = pointer.current
      if (start && (Math.abs(event.clientX - start.x) > 5 || Math.abs(event.clientY - start.y) > 5)) start.moved = true
    }}
    onPointerCancel={event => { pointer.current = null; onPointerCancel?.(event) }}
    onPointerUp={event => {
      onPointerUp?.(event)
      const start = pointer.current
      if (!start || event.button !== 2) return
      start.down = false
      if (start.pending) {
        if (!start.moved && !disabled) scope?.show(start.pending.point, start.pending.element)
        pointer.current = null
      }
    }}
    onContextMenu={event => {
      if (event.defaultPrevented || disabled || isNativeContextTarget(event.target, allowNativeTarget)) return
      onContextMenu?.(event)
      if (event.defaultPrevented) return
      if (pointer.current?.moved) { event.preventDefault(); event.stopPropagation(); pointer.current = null; return }
      event.preventDefault()
      event.stopPropagation()
      const element = event.currentTarget
      // Browsers may synthesize contextmenu at (0,0) for the dedicated keyboard key.
      const box = element.getBoundingClientRect()
      const point = { x: event.clientX || box.left + 8, y: event.clientY || box.bottom }
      // Linux fires contextmenu on press; wait for release so right-drag can pan.
      if (pointer.current?.down) pointer.current.pending = { point, element }
      else { pointer.current = null; scope?.show(point, element) }
    }}
    onKeyDown={event => {
      onKeyDown?.(event)
      if (event.defaultPrevented || disabled || event.nativeEvent.isComposing || isNativeContextTarget(event.target, allowNativeTarget)) return
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
      event.preventDefault()
      event.stopPropagation()
      const element = event.currentTarget
      const box = element.getBoundingClientRect()
      scope?.show({ x: box.left + Math.min(8, box.width), y: box.bottom }, element)
    }}
  />
})

export function ContextMenuContent({ className, style, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  const container = useThemePortalContainer()
  const scope = useContext(Scope)
  const nativeDialog = scope?.nativeDialog
  return <OverlayLayer>{layerStyle => <MenuPrimitive.Portal container={nativeDialog ?? container?.current ?? undefined}>
    <MenuPrimitive.Content side="right" align="start" sideOffset={2} collisionPadding={8} {...props}
      className={cn(popupStyle, className)} style={{ ...layerStyle, maxHeight: "var(--radix-popper-available-height)", ...style }}
      onEscapeKeyDown={event => { if (scope) scope.reason.current = "escape"; onEscapeKeyDown?.(event) }}
      onInteractOutside={event => { if (scope) scope.reason.current = "outside"; onInteractOutside?.(event) }}
      onCloseAutoFocus={event => {
        onCloseAutoFocus?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        const target = scope?.trigger.current
        if (!target || scope?.reason.current === "outside") return
        requestAnimationFrame(() => {
          const active = target.ownerDocument.activeElement
          // A dialog opened by an action owns its focus; never steal it back.
          if (target.isConnected && target.getClientRects().length && !target.closest('[inert], [aria-hidden="true"]') &&
            (active === target.ownerDocument.body || active === target || active?.closest('[role="menu"]'))) target.focus({ preventScroll: true })
        })
      }}
    />
  </MenuPrimitive.Portal>}</OverlayLayer>
}

export function ContextMenuItem({ className, onSelect, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  const scope = useContext(Scope)
  return <MenuPrimitive.Item {...props} className={cn(itemStyle, className)} onSelect={event => {
    if (scope) scope.reason.current = "select"
    onSelect?.(event)
  }} />
}
export const ContextMenuGroup = MenuPrimitive.Group
export const ContextMenuRadioGroup = MenuPrimitive.RadioGroup
export const ContextMenuSub = MenuPrimitive.Sub
export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label {...props} className={cn("px-3 py-1.5 text-xs text-muted-foreground", className)} />
}
export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator {...props} className={cn("my-1 h-px bg-border", className)} />
}
export function ContextMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return <MenuPrimitive.SubTrigger {...props} className={cn(itemStyle, className)}>{children}<ChevronRight aria-hidden="true" size={14} className="ml-auto" /></MenuPrimitive.SubTrigger>
}
export function ContextMenuSubContent({ className, style, ...props }: ComponentProps<typeof MenuPrimitive.SubContent>) {
  const container = useThemePortalContainer()
  const scope = useContext(Scope)
  const nativeDialog = scope?.nativeDialog
  return <OverlayLayer>{layerStyle => <MenuPrimitive.Portal container={nativeDialog ?? container?.current ?? undefined}>
    <MenuPrimitive.SubContent {...props} collisionPadding={8} className={cn(popupStyle, className)} style={{ ...layerStyle, maxHeight: "var(--radix-popper-available-height)", ...style }} />
  </MenuPrimitive.Portal>}</OverlayLayer>
}
export function ContextMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return <MenuPrimitive.CheckboxItem {...props} className={cn(itemStyle, className)}><span className="flex size-4 items-center"><MenuPrimitive.ItemIndicator><Check aria-hidden="true" size={14} /></MenuPrimitive.ItemIndicator></span>{children}</MenuPrimitive.CheckboxItem>
}
export function ContextMenuRadioItem({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return <MenuPrimitive.RadioItem {...props} className={cn(itemStyle, className)}><span className="flex size-4 items-center"><MenuPrimitive.ItemIndicator><Check aria-hidden="true" size={14} /></MenuPrimitive.ItemIndicator></span>{children}</MenuPrimitive.RadioItem>
}

type ContextEvent = {
  clientX: number; clientY: number; target?: EventTarget | null; currentTarget?: EventTarget | null
  preventDefault: () => void; stopPropagation?: () => void
}
type Snapshot<T> = { target: T; point: Point; trigger: FocusTarget | null }
export type ContextMenuController<T> = {
  target: T | null
  state: Snapshot<T> | null
  open: (event: ContextEvent, target: T, anchorElement?: FocusTarget) => void
  openAt: (point: Point, target: T, trigger?: FocusTarget) => void
  close: () => void
}
/** FullCalendar/ReactFlow/SVG callbacks use the same menu and focus machinery. */
export function useContextMenu<T>(): ContextMenuController<T> {
  const [state, setState] = useState<Snapshot<T> | null>(null)
  const close = useCallback(() => setState(null), [])
  const openAt = useCallback((point: Point, target: T, trigger?: FocusTarget) => {
    setState({ target, point, trigger: trigger ?? null })
  }, [])
  const open = useCallback((event: ContextEvent, target: T, anchorElement?: FocusTarget) => {
    if (isNativeContextTarget(event.target ?? null)) return
    event.preventDefault()
    event.stopPropagation?.()
    const trigger = anchorElement ?? (event.currentTarget instanceof HTMLElement || event.currentTarget instanceof SVGElement ? event.currentTarget : null)
    const box = trigger?.getBoundingClientRect()
    setState({ target, point: { x: event.clientX || (box?.left ?? 0) + 8, y: event.clientY || box?.bottom || 0 }, trigger })
  }, [])
  return { target: state?.target ?? null, state, open, openAt, close }
}
export function ContextMenuPopup<T>({ menu, children, ...props }: Omit<ComponentProps<typeof ContextMenuContent>, "children"> & { menu: ContextMenuController<T>; children?: ReactNode }) {
  const state = menu.state
  return <ContextMenu open={state !== null} onOpenChange={open => { if (!open) menu.close() }} anchor={state?.point} returnFocus={state?.trigger}>
    <ContextMenuContent {...props}>{children}</ContextMenuContent>
  </ContextMenu>
}
