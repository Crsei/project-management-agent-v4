import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react"
import { cn } from "../lib/utils"

type RadioGroupContextValue = {
  value: unknown
  disabled?: boolean
  name?: string
  select: (value: unknown) => void
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

export type RadioGroupProps<Value = string> = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange" | "defaultValue"
> & {
  value?: Value | null
  defaultValue?: Value | null
  onValueChange?: (value: Value) => void
  name?: string
  disabled?: boolean
  children: React.ReactNode
}

/**
 * Radix's radio-group is not part of the app's dependency set, so roving
 * tabindex semantics are implemented locally over native buttons. The rendered
 * data-* attributes match the originals so CSS selectors stay unchanged.
 * `useRadioGroupItem` lets a sibling build a differently shaped item (text
 * pills instead of radio dots) on top of the same selection state.
 */
export function RadioGroup<Value = string>({
  value: controlled,
  defaultValue,
  onValueChange,
  name,
  disabled,
  className,
  children,
  ...props
}: RadioGroupProps<Value>) {
  const [internal, setInternal] = useState<Value | null>(defaultValue ?? null)
  const value = controlled !== undefined ? controlled : internal
  const ref = useRef<HTMLDivElement>(null)
  const generatedName = useId()

  const select = useCallback(
    (next: unknown) => {
      if (controlled === undefined) setInternal(next as Value | null)
      onValueChange?.(next as Value)
    },
    [controlled, onValueChange],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
      if (!keys.includes(event.key)) return
      const group = ref.current
      if (!group) return
      const items = Array.from(
        group.querySelectorAll<HTMLElement>(
          '[role="radio"]:not([disabled])',
        ),
      )
      const current = items.indexOf(document.activeElement as HTMLElement)
      const forward = event.key === "ArrowDown" || event.key === "ArrowRight"
      const next =
        current === -1
          ? items[0]
          : items[(current + (forward ? 1 : items.length - 1)) % items.length]
      if (!next) return
      event.preventDefault()
      next.focus()
      if (next.dataset.value !== undefined) select(next.dataset.value)
    },
    [select],
  )

  return (
    <div
      {...props}
      ref={ref}
      role="radiogroup"
      data-disabled={disabled || undefined}
      className={cn("grid gap-2", className)}
      onKeyDown={disabled ? undefined : handleKeyDown}
    >
      <RadioGroupContext.Provider
        value={{ value, disabled, name: name ?? generatedName, select }}
      >
        {children}
      </RadioGroupContext.Provider>
    </div>
  )
}

/** Shared state for custom item shapes rendered inside `RadioGroup`. */
export function useRadioGroupItem<Value>(value: Value) {
  const context = useContext(RadioGroupContext)
  if (!context) throw new Error("RadioGroupItem must be used within a RadioGroup")
  const checked = context.value === value
  return {
    checked,
    selected: checked,
    disabled: context.disabled,
    name: context.name,
    select: () => context.select(value),
    /** Roving tabindex: only the checked item is tabbable. */
    tabIndex: checked ? 0 : -1,
  }
}

export type RadioGroupItemProps<Value = string> = {
  value: Value
  disabled?: boolean
  className?: string
  children?: React.ReactNode
} & Omit<HTMLAttributes<HTMLButtonElement>, "value" | "children">

export function RadioGroupItem<Value = string>({
  className,
  children,
  value,
  ...props
}: RadioGroupItemProps<Value>) {
  const state = useRadioGroupItem(value)
  const disabled = props.disabled || state.disabled
  return (
    <button
      type="button"
      role="radio"
      {...props}
      aria-checked={state.checked}
      disabled={disabled}
      tabIndex={state.tabIndex}
      data-checked={state.checked || undefined}
      data-disabled={disabled || undefined}
      data-value={String(value)}
      onClick={state.select}
      className={cn(
        "group inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-45 data-readonly:cursor-default [@media(pointer:coarse)]:size-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-4 items-center justify-center rounded-full border border-border group-aria-invalid:border-destructive group-data-checked:border-primary"
      >
        {state.checked && <span className="size-2 rounded-full bg-primary" />}
      </span>
      {children}
    </button>
  )
}
