"use client"
import { useId, type ReactNode } from "react"
export type FieldControlProps = {
  id: string
  "aria-describedby"?: string
  "aria-invalid"?: true
  required?: boolean
}
export type FieldProps = {
  id?: string
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  required?: boolean
  children: (props: FieldControlProps) => ReactNode
  className?: string
}
export function Field({
  id: provided,
  label,
  description,
  error,
  required,
  children,
  className,
}: FieldProps) {
  const generated = useId()
  const id = provided ?? generated
  const described =
    [description ? `${id}-description` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children({
        id,
        "aria-describedby": described,
        "aria-invalid": error ? true : undefined,
        required,
      })}
      {description && (
        <p
          id={`${id}-description`}
          className="mt-1 text-xs text-muted-foreground"
        >
          {description}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
