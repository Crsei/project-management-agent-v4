"use client"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"

export type InputOTPProps = Omit<
  ComponentProps<"input">,
  "type" | "size" | "maxLength"
> & { length?: number }

/** One native text field retains paste, selection, deletion, autofill and form semantics. */
export function InputOTP({
  length = 6,
  className,
  inputMode = "numeric",
  autoComplete = "one-time-code",
  pattern = "[0-9]*",
  ...props
}: InputOTPProps) {
  const size = Number.isFinite(length)
    ? Math.max(1, Math.min(12, Math.trunc(length)))
    : 6
  return (
    <input
      {...props}
      type="text"
      inputMode={inputMode}
      autoComplete={autoComplete}
      pattern={pattern}
      maxLength={size}
      size={size}
      className={cn(
        "h-control max-w-full rounded-control border bg-surface px-3 font-mono text-base tracking-[0.4em] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    />
  )
}
