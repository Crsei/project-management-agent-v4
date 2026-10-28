import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export { Field as FormField } from "./field"
/** Native form semantics. Validation, submission, errors and persistence remain caller-owned. */
export function Form({ className, ...props }: ComponentProps<"form">) {
  return <form {...props} className={cn("grid gap-3", className)} />
}
