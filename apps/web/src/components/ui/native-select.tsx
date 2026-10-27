import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"

export type NativeSelectProps = ComponentProps<"select">

export function NativeSelect({
  className,
  multiple,
  size,
  ...props
}: NativeSelectProps) {
  return (
    <select
      multiple={multiple}
      size={size}
      className={cn(
        "w-full min-w-0 rounded-control border bg-surface px-3 text-[13px] leading-5 text-foreground transition-colors duration-[var(--motion-hover)] ease-out outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-45 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11",
        multiple || (size !== undefined && size > 1)
          ? "h-auto min-h-8 py-1"
          : "h-control",
        className,
      )}
      {...props}
    />
  )
}

export function NativeSelectOption(props: ComponentProps<"option">) {
  return <option {...props} />
}

export function NativeSelectOptGroup(props: ComponentProps<"optgroup">) {
  return <optgroup {...props} />
}
