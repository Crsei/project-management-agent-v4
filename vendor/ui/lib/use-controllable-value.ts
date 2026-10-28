"use client"
import { useState } from "react"
export function useControllableValue<T>(
  value: T | undefined,
  initial: T,
  onChange?: (value: T) => void,
) {
  const [internal, setInternal] = useState(initial)
  const current = value === undefined ? internal : value
  function change(next: T) {
    if (Object.is(current, next)) return
    if (value === undefined) setInternal(next)
    onChange?.(next)
  }
  return [current, change] as const
}
