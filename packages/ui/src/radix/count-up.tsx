import { useLayoutEffect, useRef, useState } from "react"
import { cn } from "../lib/utils"

export type CountUpProps = {
  value: number | null | undefined
  fallback?: string
  className?: string
  duration?: number
}

function motionReduced() {
  if (typeof document === "undefined") return true
  if (document.documentElement.dataset.pmMotion === "reduce") return true
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** easeOutCubic: fast start, soft landing. */
function ease(k: number) {
  return 1 - (1 - k) ** 3
}

const DEFAULT_DURATION = 520

/**
 * Tabular numeric readout that counts from 0 to its first real value.
 * Later numeric changes land immediately; missing values render the fallback.
 */
export function CountUp({ value, fallback = "—", className, duration = DEFAULT_DURATION }: CountUpProps) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : null
  const [display, setDisplay] = useState(() => (number === null ? fallback : "0"))
  /** Last numeric value this instance rendered; null means "no value yet". */
  const painted = useRef<number | null>(null)
  /** Guards against a stale frame loop writing after a newer run started. */
  const run = useRef(0)
  /** Target of a count-up that was cancelled mid-flight; distinguishes a
   * StrictMode replay of the same target from a real value change. */
  const aborted = useRef<number | null>(null)

  useLayoutEffect(() => {
    const cancelledTarget = aborted.current
    if (cancelledTarget !== null) {
      aborted.current = null
      if (number !== null && cancelledTarget !== number) {
        /** The target moved before the run finished: land on it, never replay. */
        painted.current = number
        setDisplay(String(number))
        return
      }
      /** Same target (StrictMode replay): forget it so the run animates again. */
      painted.current = null
      /** Render already shows `fallback` when there is no number. */
      if (number === null) return
    }
    if (number === null) {
      painted.current = null
      return
    }
    const previous = painted.current
    painted.current = number
    if (previous !== null || duration <= 0 || motionReduced()) {
      setDisplay(String(number))
      return
    }
    const token = ++run.current
    let finished = false
    setDisplay("0")
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      if (run.current !== token) return
      const k = Math.min(1, (now - start) / duration)
      setDisplay(String(Math.round(number * ease(k))))
      if (k < 1) frame = requestAnimationFrame(step)
      else finished = true
    })
    return () => {
      cancelAnimationFrame(frame)
      if (run.current !== token) return
      run.current += 1
      /** An interrupted run stays "unpainted" as a candidate for replay; the
       * next effect decides whether it was the same target or a new one. */
      if (!finished) aborted.current = number
    }
  }, [number, duration])

  return (
    <span
      className={cn("tabular-nums", className)}
      aria-label={number === null ? fallback : String(number)}
      aria-live="off"
    >
      {number === null ? fallback : display}
    </span>
  )
}
