import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Check } from "lucide-react"
import {
  OverlayFocusScope,
  OverlayLayer,
  useOverlayFocus,
  useOverlayFinalFocus,
} from "../../lib/overlay-layer"
import { asChildElement } from "./render-slot"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"

/**
 * Base UI's Combobox has no Radix counterpart: a controlled input drives a
 * popover list. `items` mirrors Base UI's value list, `ComboboxList` accepts a
 * render-prop child per item, and `ComboboxEmpty` hides itself while matches
 * remain — the three call shapes used by the ported blocks.
 */
export type ComboboxProps<
  Value,
  Multiple extends boolean | undefined = undefined,
> = Omit<
  React.ComponentProps<typeof PopoverPrimitive.Root>,
  "children" | "open" | "defaultOpen" | "onOpenChange" | "modal"
> & {
  items?: readonly Value[]
  /** Controlled selection; an array when `multiple` is set. */
  value?: Multiple extends true ? readonly Value[] : Value | null
  defaultValue?: Multiple extends true ? readonly Value[] : Value | null
  onValueChange?: (
    value: Multiple extends true ? Value[] : Value,
  ) => void
  itemToStringLabel?: (item: Value) => string
  multiple?: Multiple
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  name?: string
  children: ReactNode
}

type ComboboxContextValue = {
  items: readonly unknown[]
  visible: readonly unknown[]
  multiple: boolean
  listId: string
  query: string
  setQuery: (query: string) => void
  highlighted: number
  setHighlighted: (index: number) => void
  isSelected: (value: unknown) => boolean
  select: (value: unknown) => void
  stringLabel: (value: unknown) => string
  disabled?: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  name: string
  groupId: string
  setOpen: (open: boolean) => void
  open: boolean
}

const ComboboxContext = createContext<ComboboxContextValue | null>(null)
function useComboboxContext() {
  const context = useContext(ComboboxContext)
  if (!context)
    throw new Error("Combobox parts must be rendered inside <Combobox>")
  return context
}

export function Combobox<
  Value,
  Multiple extends boolean | undefined = undefined,
>({
  items,
  value: valueProp,
  defaultValue,
  onValueChange,
  itemToStringLabel,
  multiple,
  open: openProp,
  onOpenChange,
  disabled,
  name,
  children,
  ...props
}: ComboboxProps<Value, Multiple>) {
  const [uncontrolledValue, setUncontrolledValue] = useState<unknown>(defaultValue ?? null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const open = openProp ?? uncontrolledOpen
  const inputRef = useRef<HTMLInputElement>(null)
  const generatedName = useId()
  const groupId = useId()
  const { target, track } = useOverlayFocus()

  const selected = valueProp !== undefined ? valueProp : uncontrolledValue
  const isSelected = useCallback(
    (candidate: unknown) => {
      if (multiple) return Array.isArray(selected) && selected.includes(candidate)
      return selected === candidate
    },
    [multiple, selected],
  )

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
      track(
        next,
        next
          ? {
              trigger: document.activeElement ?? undefined,
              isCanceled: false,
            }
          : { trigger: undefined, isCanceled: true },
      )
      if (!next) setQuery("")
    },
    [onOpenChange, openProp, track],
  )

  const select = useCallback(
    (candidate: unknown) => {
      if (multiple) {
        const list = Array.isArray(selected) ? selected.slice() : []
        const index = list.indexOf(candidate)
        if (index === -1) list.push(candidate)
        else list.splice(index, 1)
        if (valueProp === undefined) setUncontrolledValue(list)
        onValueChange?.(list as never)
        return
      }
      if (valueProp === undefined) setUncontrolledValue(candidate)
      onValueChange?.(candidate as never)
      setOpen(false)
      inputRef.current?.focus()
    },
    [multiple, onValueChange, selected, setOpen, valueProp],
  )

  const stringLabel = useCallback(
    (candidate: unknown) =>
      itemToStringLabel ? itemToStringLabel(candidate as Value) : String(candidate),
    [itemToStringLabel],
  )

  const visible = useMemo(() => {
    if (!items) return []
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      stringLabel(item).toLocaleLowerCase().includes(needle),
    )
  }, [items, query, stringLabel])

  return (
    <OverlayFocusScope value={target}>
      <ComboboxContext.Provider
        value={{
          items: items ?? [],
          visible,
          multiple: Boolean(multiple),
          listId: `${groupId}-list`,
          query,
          setQuery,
          highlighted,
          setHighlighted,
          isSelected,
          select,
          stringLabel,
          disabled,
          inputRef,
          name: name ?? generatedName,
          groupId,
          setOpen,
          open,
        }}
      >
        <PopoverPrimitive.Root
          {...props}
          open={open}
          onOpenChange={setOpen}
        >
          {children}
        </PopoverPrimitive.Root>
      </ComboboxContext.Provider>
    </OverlayFocusScope>
  )
}

/**
 * `children` is either a render prop per visible item (the ported call shape)
 * or static content.
 */
export function ComboboxList({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  children?: ((item: never) => ReactNode) | ReactNode
}) {
  const context = useComboboxContext()
  return (
    <div
      {...props}
      role="listbox"
      aria-multiselectable={context.multiple || undefined}
      id={context.listId}
      className={cn("max-h-60 overflow-auto py-1", className)}
    >
      {typeof children === "function"
        ? context.visible.map((item) =>
            (children as (item: unknown) => ReactNode)(item),
          )
        : children}
    </div>
  )
}

/** Hides itself while at least one item matches, matching Base UI's Empty. */
export function ComboboxEmpty({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const context = useComboboxContext()
  if (context.visible.length > 0) return null
  return (
    <div
      {...props}
      className={cn(
        "px-3 py-2 text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** `render` supplies a polymorphic trigger element; children stay inside it. */
export function ComboboxTrigger({
  render,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger> & {
  render?: ReactNode
}) {
  const trigger = (
    <PopoverPrimitive.Trigger asChild {...props}>
      {render !== undefined ? asChildElement(render, children) : children}
    </PopoverPrimitive.Trigger>
  )
  return trigger
}

export function ComboboxContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  style,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  className?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
}) {
  const container = useThemePortalContainer()
  // Base UI's popup received a `finalFocus` element; Radix restores focus to
  // the trigger itself, so the recorded opener is reasserted instead.
  const finalFocus = useOverlayFinalFocus()
  const context = useComboboxContext()
  void context
  return (
    <OverlayLayer>
      {(layerStyle) => (
        <PopoverPrimitive.Portal container={container?.current ?? undefined}>
          <PopoverPrimitive.Content
            {...props}
            side={side}
            align={align}
            sideOffset={sideOffset}
            onOpenAutoFocus={(event) => {
              // The search field owns focus; opening on the panel would steal it.
              event.preventDefault()
              context.inputRef.current?.focus()
              onOpenAutoFocus?.(event)
            }}
            onCloseAutoFocus={(event) => {
              const target = finalFocus()
              if (target && target.isConnected) {
                event.preventDefault()
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    target.focus({ preventScroll: true }),
                  ),
                )
              }
              onCloseAutoFocus?.(event)
            }}
            style={
              {
                ...layerStyle,
                // Base UI names the available space; Radix names it per anchor.
                "--available-height":
                  "var(--radix-popover-content-available-height)",
                "--available-width":
                  "var(--radix-popover-content-available-width)",
                ...style,
              } as React.CSSProperties
            }
            className={cn(
              "min-w-40 rounded-lg border bg-surface p-1 text-foreground shadow-[var(--shadow-floating)] outline-none",
              className,
            )}
          >
            {children}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </OverlayLayer>
  )
}

export type ComboboxItemProps = Omit<
  React.ComponentProps<"button">,
  "value"
> & {
  value: unknown
}

export function ComboboxItem({
  className,
  children,
  value,
  onClick,
  onPointerMove,
  ...props
}: ComboboxItemProps) {
  const context = useComboboxContext()
  const selected = context.isSelected(value)
  const index = context.visible.indexOf(value)
  const highlighted = index >= 0 && index === context.highlighted
  return (
    <button
      type="button"
      role="option"
      id={
        index >= 0 ? `${context.groupId}-option-${index}` : undefined
      }
      aria-selected={selected}
      data-highlighted={highlighted || undefined}
      data-selected={selected || undefined}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        context.select(value)
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (index >= 0) context.setHighlighted(index)
      }}
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-3 text-sm outline-none data-highlighted:bg-surface-hover focus-visible:bg-surface-hover data-highlighted:text-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {children}
      <span className="ml-auto" aria-hidden="true">
        {selected && <Check aria-hidden="true" size={14} strokeWidth={2.7} />}
      </span>
    </button>
  )
}

export function ComboboxInput({
  className,
  value,
  onChange,
  onKeyDown,
  ...props
}: React.ComponentProps<"input"> & { className?: string }) {
  const context = useComboboxContext()
  const query = value !== undefined ? value : context.query
  return (
    <input
      {...props}
      ref={context.inputRef}
      role="combobox"
      aria-expanded={context.open}
      aria-controls={context.listId}
      autoComplete="off"
      value={query}
      onChange={(event) => {
        onChange?.(event)
        if (event.defaultPrevented) return
        context.setQuery(String(event.target.value))
        if (!context.open) context.setOpen(true)
        context.setHighlighted(0)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        const count = context.visible.length
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (!count) return
          event.preventDefault()
          const step = event.key === "ArrowDown" ? 1 : count - 1
          context.setHighlighted((context.highlighted + step) % count)
        } else if (event.key === "Enter") {
          const item = context.visible[context.highlighted]
          if (item === undefined) return
          event.preventDefault()
          context.select(item)
        } else if (event.key === "Escape") {
          if (context.open) context.setOpen(false)
        }
      }}
      className={cn(
        "h-control rounded-md border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
