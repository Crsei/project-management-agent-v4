import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type AriaAttributes,
  type CSSProperties,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "../../lib/utils"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

/** Radix Select rejects empty item values; keep the native `""` option working. */
const EMPTY_VALUE = "\u0000pm-empty"

export type RadixSelectOptionElement = {
  value: string
  label: string
  disabled: boolean
  selected: boolean
}

export type RadixSelectChangeTarget = {
  value: string
  selectedOptions: RadixSelectOptionElement[]
  multiple: boolean
  name: string
}

/** Structural stand-in for the native select change event used by existing callers. */
export type RadixSelectChangeEvent = {
  target: RadixSelectChangeTarget
  currentTarget: RadixSelectChangeTarget
}

export type RadixSelectValue = string | number

export type RadixSelectProps = {
  value?: RadixSelectValue | readonly RadixSelectValue[] | null
  defaultValue?: RadixSelectValue | readonly RadixSelectValue[]
  onChange?: (event: RadixSelectChangeEvent) => void
  onValueChange?: (value: string | string[]) => void
  name?: string
  required?: boolean
  disabled?: boolean
  multiple?: boolean
  size?: number
  className?: string
  id?: string
  title?: string
  placeholder?: string
  autoFocus?: boolean
  form?: string
  style?: CSSProperties
  "aria-label"?: string
  "aria-describedby"?: string
  "aria-invalid"?: AriaAttributes["aria-invalid"]
  "data-testid"?: string
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
  onBlur?: FocusEventHandler<HTMLDivElement>
  onFocus?: FocusEventHandler<HTMLDivElement>
  ref?: Ref<HTMLDivElement>
  children?: ReactNode
}

type OptionNode = {
  kind: "option"
  value: string
  label: ReactNode
  text: string
  disabled: boolean
  title?: string
}

type GroupNode = {
  kind: "group"
  label: ReactNode
  text: string
  disabled: boolean
  options: OptionNode[]
}

type SelectNode = OptionNode | GroupNode

type OptionProps = {
  value?: string | number
  disabled?: boolean
  title?: string
  children?: ReactNode
}

type OptGroupProps = {
  label?: ReactNode
  disabled?: boolean
  children?: ReactNode
}

function isOptionElement(element: ReactElement): element is ReactElement<OptionProps> {
  return element.type === "option"
}

function isOptGroupElement(element: ReactElement): element is ReactElement<OptGroupProps> {
  return element.type === "optgroup"
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ""
}

function collectNodes(children: ReactNode, inheritedDisabled = false): SelectNode[] {
  const nodes: SelectNode[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === Fragment) {
      if (child.props && typeof child.props === "object" && "children" in child.props) {
        // React leaves element props untyped; children is all this branch reads.
        const children = child.props.children as ReactNode
        nodes.push(...collectNodes(children, inheritedDisabled))
      }
      return
    }
    if (isOptionElement(child)) {
      const props = child.props
      const text = nodeText(props.children)
      nodes.push({
        kind: "option",
        value: props.value === undefined ? text : String(props.value),
        label: props.children,
        text,
        disabled: inheritedDisabled || Boolean(props.disabled),
        title: props.title,
      })
      return
    }
    if (isOptGroupElement(child)) {
      const props = child.props
      const disabled = inheritedDisabled || Boolean(props.disabled)
      nodes.push({
        kind: "group",
        label: props.label,
        text: nodeText(props.label),
        disabled,
        options: collectNodes(props.children, disabled).filter(
          (node): node is OptionNode => node.kind === "option",
        ),
      })
    }
  })
  return nodes
}

function encodeValue(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value === "" ? EMPTY_VALUE : value
}

function normalizeValues(value: readonly RadixSelectValue[] | RadixSelectValue | null | undefined): string[] {
  if (typeof value === "string" || typeof value === "number") return value === "" ? [] : [String(value)]
  return value ? value.map(String) : []
}

function singleValue(value: readonly RadixSelectValue[] | RadixSelectValue | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  return value.length ? String(value[0]) : undefined
}

export function RadixSelect({
  value,
  defaultValue,
  onChange,
  onValueChange,
  name,
  required,
  disabled,
  multiple,
  size,
  className,
  id,
  title,
  placeholder,
  autoFocus,
  form,
  style,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "data-testid": dataTestId,
  onKeyDown,
  onBlur,
  onFocus,
  ref,
  children,
}: RadixSelectProps) {
  const nodes = collectNodes(children)
  const flat = nodes.flatMap((node) => (node.kind === "group" ? node.options : [node]))
  const labelFor = (candidate: string) =>
    flat.find((option) => option.value === candidate)?.text ?? candidate

  const multipleControlled = multiple && value !== undefined
  const [uncontrolledMultiple, setUncontrolledMultiple] = useState<string[]>(() =>
    normalizeValues(defaultValue),
  )
  const selectedValues = multiple
    ? multipleControlled
      ? normalizeValues(value)
      : uncontrolledMultiple
    : []

  const emit = (next: string | string[]) => {
    const values = Array.isArray(next) ? next : [next]
    const target: RadixSelectChangeTarget = {
      value: values[0] ?? "",
      selectedOptions: values.map((candidate) => ({
        value: candidate,
        label: labelFor(candidate),
        disabled: false,
        selected: true,
      })),
      multiple: Array.isArray(next),
      name: name ?? "",
    }
    onChange?.({ target, currentTarget: target })
  }

  if (multiple) {
    const summary = selectedValues
      .map((candidate) => labelFor(candidate))
      .filter(Boolean)
      .join(", ")
    const toggle = (candidate: string) => {
      const next = selectedValues.includes(candidate)
        ? selectedValues.filter((entry) => entry !== candidate)
        : [...selectedValues, candidate]
      const ordered = flat
        .map((option) => option.value)
        .filter((entry) => next.includes(entry))
      if (!multipleControlled) setUncontrolledMultiple(ordered)
      onValueChange?.(ordered)
      emit(ordered)
    }
    const triggerClassName = cn(
      "flex h-control min-w-0 cursor-pointer select-none items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm text-foreground outline-none data-disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11",
      className,
    )
    const trigger = (
      <PopoverTrigger
        disabled={disabled}
        render={
          <div
            role="combobox"
            tabIndex={disabled ? -1 : 0}
            ref={ref}
            id={id}
            title={title}
            className={triggerClassName}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            aria-haspopup="listbox"
            aria-disabled={disabled || undefined}
            data-slot="select-trigger"
            data-multiple="true"
            data-disabled={disabled || undefined}
            data-testid={dataTestId}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onFocus={onFocus}
            autoFocus={autoFocus}
            style={style}
          />
        }
      >
        <span className="min-w-0 truncate text-left">
          {summary || placeholder || "\u00a0"}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
    )
    return (
      <>
        {name && selectedValues.map((candidate) => (
          <input key={candidate} type="hidden" name={name} value={candidate} form={form} />
        ))}
        <Popover>
          {trigger}
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-1"
            align="start"
          >
            <div
              role="listbox"
              aria-multiselectable="true"
              aria-label={ariaLabel}
              className="grid max-h-72 gap-0.5 overflow-auto"
              style={size && size > 1 ? { maxHeight: `${size * 1.75}rem` } : undefined}
            >
              {flat.map((option) => {
                const checked = selectedValues.includes(option.value)
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    disabled={option.disabled}
                    title={option.title}
                    className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none hover:bg-surface-hover focus-visible:bg-surface-hover data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
                    onClick={() => toggle(option.value)}
                  >
                    <Check
                      className={cn("size-3.5 shrink-0", checked ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">{option.label}</span>
                  </button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      </>
    )
  }

  const renderItem = (option: OptionNode) => (
    <SelectItem
      key={option.value}
      value={option.value === "" ? EMPTY_VALUE : option.value}
      disabled={option.disabled}
      title={option.title}
    >
      {option.label}
    </SelectItem>
  )

  return (
    <Select
      value={encodeValue(singleValue(value))}
      defaultValue={encodeValue(singleValue(defaultValue))}
      onValueChange={(next) => {
        const decoded = next === null ? "" : next === EMPTY_VALUE ? "" : next
        onValueChange?.(decoded)
        emit(decoded)
      }}
      name={name}
      required={required}
      disabled={disabled}
    >
      <SelectTrigger asChild disabled={disabled}>
        <div
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          ref={ref}
          id={id}
          title={title}
          className={cn(
            "flex min-w-0 cursor-pointer select-none items-center justify-between gap-2 text-left",
            className,
          )}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-disabled={disabled || undefined}
          data-slot="select-trigger"
          data-disabled={disabled || undefined}
          data-testid={dataTestId}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onFocus={onFocus}
          autoFocus={autoFocus}
          style={style}
        >
          <SelectValue placeholder={placeholder} className="min-w-0 truncate" />
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {nodes.map((node, index) =>
          node.kind === "group" ? (
            <SelectGroup key={`group-${index}`}>
              <SelectGroupLabel>{node.label}</SelectGroupLabel>
              {node.options.map(renderItem)}
            </SelectGroup>
          ) : (
            renderItem(node)
          ),
        )}
      </SelectContent>
    </Select>
  )
}
