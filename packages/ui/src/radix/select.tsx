import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check } from "lucide-react"
import { OverlayLayer } from "../lib/overlay-layer"
import { useThemePortalContainer } from "./theme-boundary"
import { cn } from "../lib/utils"

/** `items` is the Base UI 1.8 value input; Radix reads the rendered children. */
export type SelectRootProps<T extends string> = Omit<
  React.ComponentProps<typeof SelectPrimitive.Root>,
  "value" | "defaultValue" | "onValueChange" | "open" | "onOpenChange"
> & {
  value?: T | null
  defaultValue?: T
  onValueChange?: (value: T | null) => void
  onOpenChange?: (open: boolean) => void
  open?: boolean
  items?: unknown
}

/** Trigger element, needed to keep it reachable while the modal list is open. */
const SelectTriggerElement = createContext<{
  current: HTMLElement | null
} | null>(null)

export function Select<T extends string>({
  open: openProp,
  onOpenChange,
  ...props
}: SelectRootProps<T>) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = openProp ?? uncontrolled
  const triggerRef = useRef<HTMLElement | null>(null)
  const rootProps: Record<string, unknown> = {
    ...(props as Record<string, unknown>),
  }
  // Base UI 1.8 feeds option values through `items`; Radix derives the selected
  // label from rendered children, so the prop is accepted and dropped.
  delete rootProps.items

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    // Radix's modal list hides every other branch from assistive tech, its own
    // trigger included, and applies it after this wrapper's first effect pass;
    // Base UI keeps the trigger in the accessibility tree, so undo it live.
    const clearHidden = () => {
      let node = trigger.parentElement
      while (node && node !== document.body) {
        if (node.getAttribute("aria-hidden") === "true")
          node.removeAttribute("aria-hidden")
        node = node.parentElement
      }
    }
    clearHidden()
    const observer = new MutationObserver(clearHidden)
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["aria-hidden"],
    })
    return () => observer.disconnect()
  }, [open])

  return (
    <SelectTriggerElement.Provider value={triggerRef}>
      <SelectPrimitive.Root
        {...rootProps}
        open={open}
        onOpenChange={(next) => {
          if (openProp === undefined) setUncontrolled(next)
          onOpenChange?.(next)
        }}
      />
    </SelectTriggerElement.Provider>
  )
}
export const SelectGroup = SelectPrimitive.Group
export const SelectGroupLabel = SelectPrimitive.Label
export const SelectSeparator = SelectPrimitive.Separator
export const SelectItemText = SelectPrimitive.ItemText

export function SelectValue({
  placeholder,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value> & {
  placeholder?: ReactNode
}) {
  return <SelectPrimitive.Value {...props} placeholder={placeholder} />
}

export function SelectContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  className?: string
}) {
  const container = useThemePortalContainer()
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <SelectPrimitive.Portal container={container?.current ?? undefined}>
          <SelectPrimitive.Content
            position="popper"
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={8}
            style={{ ...layerStyle, ...style }}
            {...props}
            className={cn(
              "max-h-[var(--radix-select-content-available-height)] min-w-40 overflow-auto rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
              className,
            )}
          >
            <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  className?: string
}) {
  return (
    <SelectPrimitive.Item
      {...props}
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:text-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {Children.toArray(children).some(
        (child) =>
          isValidElement(child) && child.type === SelectPrimitive.ItemText,
      ) ? (
        children
      ) : (
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      )}
      <SelectPrimitive.ItemIndicator className="ml-auto" aria-hidden="true">
        <Check aria-hidden="true" size={14} strokeWidth={2.7} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export function SelectTrigger({
  className,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  className?: string
}) {
  const triggerRef = useContext(SelectTriggerElement)
  return (
    <SelectPrimitive.Trigger
      {...props}
      data-slot="select-trigger"
      ref={(element) => {
        if (triggerRef) triggerRef.current = element
        if (typeof ref === "function") ref(element)
        else if (ref) ref.current = element
      }}
      className={cn(
        "h-control rounded-md border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {children}
    </SelectPrimitive.Trigger>
  )
}
