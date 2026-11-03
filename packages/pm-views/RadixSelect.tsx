import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown } from "lucide-react"
import "./radix-select.css"

/** Radix rejects empty item values; keep the `""` option usable. */
const EMPTY_VALUE = "\u0000pm-empty"

type OptionProps = {
  value?: string | number
  disabled?: boolean
  title?: string
  children?: ReactNode
}

type Option = {
  value: string
  label: ReactNode
  text: string
  disabled: boolean
  title?: string
}

export type PmSelectChangeEvent = {
  target: {
    value: string
    selectedOptions: { value: string; label: string; disabled: boolean; selected: boolean }[]
    multiple: false
    name: string
  }
  currentTarget: PmSelectChangeEvent["target"]
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ""
}

function isOptionElement(element: ReactElement): element is ReactElement<OptionProps> {
  return element.type === "option"
}

function collectOptions(children: ReactNode, inheritedDisabled = false): Option[] {
  const options: Option[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === Fragment) {
      if (child.props && typeof child.props === "object" && "children" in child.props) {
        // React leaves element props untyped; children is all this branch reads.
        const nested = child.props.children as ReactNode
        options.push(...collectOptions(nested, inheritedDisabled))
      }
      return
    }
    if (!isOptionElement(child)) return
    const props = child.props
    const text = nodeText(props.children)
    options.push({
      value: props.value === undefined ? text : String(props.value),
      label: props.children,
      text,
      disabled: inheritedDisabled || Boolean(props.disabled),
      title: props.title,
    })
  })
  return options
}

export function RadixSelect({
  value,
  onChange,
  children,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value?: string | number | null
  onChange?: (event: PmSelectChangeEvent) => void
  children?: ReactNode
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  const options = collectOptions(children)
  const raw = value === null || value === undefined ? undefined : String(value)
  const encoded = raw === "" ? EMPTY_VALUE : raw
  const labelFor = (candidate: string) =>
    options.find((option) => option.value === candidate)?.text ?? candidate
  return (
    <SelectPrimitive.Root
      value={encoded}
      disabled={disabled}
      onValueChange={(next) => {
        const decoded = next === EMPTY_VALUE ? "" : next
        const target: PmSelectChangeEvent["target"] = {
          value: decoded,
          selectedOptions: [
            {
              value: decoded,
              label: labelFor(decoded),
              disabled: false,
              selected: true,
            },
          ],
          multiple: false,
          name: "",
        }
        onChange?.({ target, currentTarget: target })
      }}
    >
      <SelectPrimitive.Trigger asChild disabled={disabled}>
        <div
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          className={`pm-radix-select-trigger${className ? ` ${className}` : ""}`}
          data-slot="select-trigger"
          data-disabled={disabled || undefined}
          aria-label={ariaLabel}
        >
          <SelectPrimitive.Value />
          <ChevronDown size={12} aria-hidden="true" />
        </div>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="pm-radix-select-content"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value === "" ? EMPTY_VALUE : option.value}
                disabled={option.disabled}
                title={option.title}
                className="pm-radix-select-item"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="pm-radix-select-check">
                  <Check size={12} aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
