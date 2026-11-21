import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ArrowLeft, ArrowRight, LoaderCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import styles from "./guided-tour.module.css"

/**
 * Lightweight guided walkthrough: a spotlight cutout over a real control plus
 * an anchored info bubble. The page underneath stays interactive, so a step can
 * either explain an area or point at the control the user should operate next.
 *
 * This intentionally does not add a tour dependency. Targets are looked up by
 * `data-tour` attributes supplied by the caller, and a step may call `prepare`
 * before measuring when it first has to reveal the surrounding view.
 */

export type GuidedTourPlacement = "top" | "right" | "bottom" | "left"

export type GuidedTourStep = {
  id: string
  title: ReactNode
  body: ReactNode
  /** Resolve the real control to highlight. Omit for a floating intro/outro bubble. */
  target?: () => Element | null
  placement?: GuidedTourPlacement
  /** Runs before measuring; use it to switch the surrounding view to this step. */
  prepare?: () => void
  nextLabel?: string
  /** Visually disables the next action while the caller is still reading status. */
  nextDisabled?: boolean
  /** Runs before moving on. Return `false` to keep the current step. */
  next?: () => Promise<boolean | void> | boolean | void
  secondary?: {
    label: string
    onClick: () => Promise<boolean | void> | boolean | void
  }
}

type Labels = {
  kicker: string
  back: string
  next: string
  done: string
  close: string
}

type Rect = { top: number; left: number; width: number; height: number; right: number; bottom: number }

type BubblePosition = {
  top: number
  left: number
  side: GuidedTourPlacement
  arrow: number
}

const VIEWPORT_MARGIN = 12
const ANCHOR_GAP = 14
const SPOTLIGHT_PADDING = 6
const MEASURE_TIMEOUT = 1200

function sameRect(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b
  return Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

function rectOf(element: Element): Rect | null {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
}

function nextFrame(): Promise<number> {
  const frame = Promise.withResolvers<number>()
  requestAnimationFrame(time => frame.resolve(time))
  return frame.promise
}

function chooseSide(rect: Rect, width: number, height: number, preferred: GuidedTourPlacement | undefined): GuidedTourPlacement {
  const room = {
    top: rect.top - VIEWPORT_MARGIN,
    bottom: window.innerHeight - rect.bottom - VIEWPORT_MARGIN,
    left: rect.left - VIEWPORT_MARGIN,
    right: window.innerWidth - rect.right - VIEWPORT_MARGIN,
  }
  const fits: Record<GuidedTourPlacement, boolean> = {
    top: room.top >= height + ANCHOR_GAP,
    bottom: room.bottom >= height + ANCHOR_GAP,
    left: room.left >= width + ANCHOR_GAP,
    right: room.right >= width + ANCHOR_GAP,
  }
  const order: GuidedTourPlacement[] = [preferred ?? "bottom", "bottom", "top", "right", "left"]
  return order.find((side, index) => order.indexOf(side) === index && fits[side]) ?? preferred ?? "bottom"
}

function positionBubble(rect: Rect, width: number, height: number, preferred?: GuidedTourPlacement): BubblePosition {
  const side = chooseSide(rect, width, height, preferred)
  let top = 0
  let left = 0
  if (side === "top") {
    top = rect.top - ANCHOR_GAP - height
    left = rect.left + rect.width / 2 - width / 2
  } else if (side === "bottom") {
    top = rect.bottom + ANCHOR_GAP
    left = rect.left + rect.width / 2 - width / 2
  } else if (side === "left") {
    top = rect.top + rect.height / 2 - height / 2
    left = rect.left - ANCHOR_GAP - width
  } else {
    top = rect.top + rect.height / 2 - height / 2
    left = rect.right + ANCHOR_GAP
  }
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN))
  left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN))
  const horizontal = side === "top" || side === "bottom"
  const arrow = horizontal
    ? Math.min(Math.max(rect.left + rect.width / 2 - left, 18), Math.max(18, width - 18))
    : Math.min(Math.max(rect.top + rect.height / 2 - top, 18), Math.max(18, height - 18))
  return { top, left, side, arrow }
}

function centeredPosition(width: number, height: number): BubblePosition {
  return {
    top: Math.min(Math.max(window.innerHeight / 2 - height / 2, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)),
    left: Math.min(Math.max(window.innerWidth / 2 - width / 2, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)),
    side: "bottom",
    arrow: width / 2,
  }
}

export function GuidedTour({ steps, open, labels, onClose }: {
  steps: GuidedTourStep[]
  open: boolean
  labels: Labels
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [position, setPosition] = useState<BubblePosition | null>(null)
  const [measuring, setMeasuring] = useState(true)
  const [pending, setPending] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const target = useRef<Element | null>(null)
  const titleId = useId()
  const bodyId = useId()
  const step = steps[Math.min(index, Math.max(0, steps.length - 1))]
  const stepRef = useRef(step)
  stepRef.current = step

  useEffect(() => {
    if (open) setIndex(0)
  }, [open])

  // Locate and reveal the target for this step. State changes from `prepare`
  // flush before the next frame, so retry for a short window instead of
  // depending on a caller-supplied delay.
  useLayoutEffect(() => {
    if (!open || !step) return
    let cancelled = false
    const locate = async () => {
      setMeasuring(true)
      setPosition(null)
      setRect(null)
      const current = stepRef.current
      try { await current?.prepare?.() } catch { /* the surrounding page owns its errors */ }
      if (!current?.target) {
        setMeasuring(false)
        return
      }
      const started = performance.now()
      while (!cancelled) {
        const element = current.target?.() ?? null
        target.current = element
        if (element) {
          element.scrollIntoView({ block: "center", inline: "nearest" })
          await nextFrame()
          if (cancelled) return
          const next = rectOf(element)
          if (next) {
            setRect(next)
            setMeasuring(false)
            return
          }
        }
        if (performance.now() - started > MEASURE_TIMEOUT) {
          setMeasuring(false)
          return
        }
        await nextFrame()
      }
    }
    void locate()
    return () => { cancelled = true; target.current = null }
  }, [open, index, step?.id])

  // Keep the cutout glued to the control while the page scrolls or reflows.
  useEffect(() => {
    if (!open || !step) return
    let active = true
    let frame = 0
    let lastScroll = 0
    const update = () => {
      const element = target.current
      if (!element?.isConnected) {
        setRect(previous => sameRect(previous, null) ? previous : null)
        return
      }
      const next = rectOf(element)
      // Status reads and expanding panels can push the target out of view after
      // it was first measured. Bring it back, without fighting partial visibility.
      if (next && (next.bottom <= 0 || next.top >= window.innerHeight) && performance.now() - lastScroll > 800) {
        lastScroll = performance.now()
        element.scrollIntoView({ block: "center", inline: "nearest" })
        void nextFrame().then(() => {
          if (!active) return
          const settled = rectOf(element)
          setRect(previous => sameRect(previous, settled) ? previous : settled)
        })
        return
      }
      setRect(previous => sameRect(previous, next) ? previous : next)
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; update() })
    }
    window.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    const observer = new ResizeObserver(schedule)
    if (target.current) observer.observe(target.current)
    const timer = window.setInterval(update, 500)
    return () => {
      active = false
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      observer.disconnect()
      window.clearInterval(timer)
    }
  }, [open, index, step?.id])

  useLayoutEffect(() => {
    if (!open || !step || !bubble.current) return
    const element = bubble.current
    const measure = () => setPosition(rect
      ? positionBubble(rect, element.offsetWidth, element.offsetHeight, stepRef.current?.placement)
      : centeredPosition(element.offsetWidth, element.offsetHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, step?.id, rect])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => bubble.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open, index])

  const next = useCallback(async () => {
    if (!step || pending || step.nextDisabled) return
    setPending(true)
    try {
      const result = step.next ? await step.next() : true
      if (result === false) return
      if (index >= steps.length - 1) onClose()
      else setIndex(value => value + 1)
    } finally {
      setPending(false)
    }
  }, [index, onClose, pending, step, steps.length])

  const secondary = useCallback(async () => {
    if (!step?.secondary || pending) return
    setPending(true)
    try {
      const result = await step.secondary.onClick()
      if (result === false) return
      if (index >= steps.length - 1) onClose()
      else setIndex(value => value + 1)
    } finally {
      setPending(false)
    }
  }, [index, onClose, pending, step, steps.length])

  const back = useCallback(() => {
    if (pending || index === 0) return
    setIndex(value => value - 1)
  }, [index, pending])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      const inside = !!bubble.current?.contains(document.activeElement)
      if (!inside || event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true']")) return
      if (event.key === "ArrowRight") {
        event.preventDefault()
        void next()
      } else if (event.key === "ArrowLeft") {
        event.preventDefault()
        back()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [back, next, onClose, open])

  if (!open || !step) return null

  const arrowStyle = position
    ? ({ "--arrow": `${position.arrow}px` } as CSSProperties)
    : undefined
  const ready = !!position && !measuring

  return createPortal(
    <>
      {rect && <div
        className={styles.spotlight}
        aria-hidden="true"
        data-tour-spotlight="true"
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
        }}
      />}
      <div
        ref={bubble}
        className={styles.bubble}
        style={{
          top: position?.top ?? -9999,
          left: position?.left ?? -9999,
          visibility: ready ? "visible" : "hidden",
        }}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-guided-tour="true"
        data-tour-state={ready ? "ready" : "measuring"}
        data-tour-index={index}
        data-tour-step={step.id}
      >
        <span className={styles.progress} aria-hidden="true"><span style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></span>
        <div className={styles.bubbleHeader}>
          <p className={styles.kicker}>{labels.kicker} · {index + 1}/{steps.length}</p>
          <button type="button" className={styles.close} onClick={onClose} aria-label={labels.close} data-tour-close="true"><X aria-hidden="true" /></button>
        </div>
        <h3 id={titleId}>{step.title}</h3>
        <div id={bodyId} className={styles.body}>{step.body}</div>
        <div className={styles.footer}>
          <Button type="button" size="sm" variant="ghost" disabled={index === 0 || pending} onClick={back} data-tour-back="true">
            <ArrowLeft aria-hidden="true" />{labels.back}
          </Button>
          <div className={styles.footerActions}>
            {step.secondary && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => { void secondary() }} data-tour-secondary="true">{step.secondary.label}</Button>}
            <Button type="button" size="sm" disabled={pending || measuring || step.nextDisabled} onClick={() => { void next() }} data-tour-next="true">
              {pending && <LoaderCircle className={styles.spinner} aria-hidden="true" />}
              {index >= steps.length - 1 ? step.nextLabel ?? labels.done : step.nextLabel ?? labels.next}
              {!pending && <ArrowRight aria-hidden="true" />}
            </Button>
          </div>
        </div>
        {position && <span className={styles.arrow} data-side={position.side} style={arrowStyle} aria-hidden="true" />}
      </div>
    </>,
    document.body,
  )
}
