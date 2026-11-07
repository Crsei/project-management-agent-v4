import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "../lib/utils"

export type SwitchProps = Omit<
  React.ComponentProps<typeof SwitchPrimitive.Root>,
  "className" | "onCheckedChange"
> & {
  className?: string
  onCheckedChange?: (checked: boolean) => void
  /** Base UI form parity: accepted, no native form value is submitted here. */
  uncheckedValue?: string
}

export function Switch({ className, onCheckedChange, ...props }: SwitchProps) {
  const rootProps: Record<string, unknown> = {
    ...(props as Record<string, unknown>),
  }
  delete rootProps.uncheckedValue
  return (
    <SwitchPrimitive.Root
      {...rootProps}
      onCheckedChange={
        onCheckedChange && ((checked) => onCheckedChange(checked === true))
      }
      className={cn(
        "group inline-flex h-8 w-11 shrink-0 cursor-pointer items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none relative inline-flex h-5 w-8 items-center rounded-full border bg-muted group-aria-invalid:border-destructive group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary"
      >
        <SwitchPrimitive.Thumb className="absolute left-0.5 size-3.5 rounded-full bg-foreground transition-transform duration-[var(--motion-button)] ease-out data-[state=checked]:translate-x-3 data-[state=checked]:bg-primary-foreground motion-reduce:transition-none" />
      </span>
    </SwitchPrimitive.Root>
  )
}
