import type { ReactNode } from "react"
import { cn } from "../../lib/utils"
export type FormSectionProps = {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  disabled?: boolean
  className?: string
}
export function FormSection({
  title,
  description,
  children,
  disabled,
  className,
}: FormSectionProps) {
  return (
    <fieldset
      disabled={disabled}
      className={cn("min-w-0 space-y-4 border-t pt-4", className)}
    >
      <legend className="pr-2 text-sm font-medium">{title}</legend>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {children}
    </fieldset>
  )
}
