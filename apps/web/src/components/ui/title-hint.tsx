import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

/**
 * Replaces the browser's native `title` bubble with the shared floating-surface
 * treatment. Native bubbles cannot be styled and render outside the theme, so
 * option lists and icon controls ended up with unthemed, inconsistent hints.
 *
 * The layer is intentionally global: titles are an HTML-wide fallback used by
 * menus, selects, option pickers and truncated labels. Elements opt out with
 * `data-title-hint="off"` when their title exists only for assistive tech.
 */

const HINT_DELAY = 350
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 6

const SKIPPED_TAGS: Record<string, true> = {
  IFRAME: true,
  OPTGROUP: true,
  OPTION: true,
  SELECT: true,
  TEXTAREA: true,
}

type PendingHint = {
  element: HTMLElement
  text: string
  timer: number
}

type ActiveHint = {
  element: HTMLElement
  text: string
}

type HintPosition = {
  top: number
  left: number
}

function titleCandidate(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const element = target.closest<HTMLElement>("[title]")
  if (!element || SKIPPED_TAGS[element.tagName]) return null
  if (element.closest('[data-title-hint="off"]')) return null
  const text = element.getAttribute("title")?.trim()
  return text ? element : null
}

function measure(element: HTMLElement, bubble: HTMLElement): HintPosition {
  const anchor = element.getBoundingClientRect()
  const width = bubble.offsetWidth
  const height = bubble.offsetHeight
  const above = anchor.top >= height + ANCHOR_GAP + VIEWPORT_MARGIN
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, above ? anchor.top - height - ANCHOR_GAP : anchor.bottom + ANCHOR_GAP),
    Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
  )
  const centered = anchor.left + anchor.width / 2 - width / 2
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, centered),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  )
  return { top, left }
}

export function TitleHintLayer() {
  const [hint, setHint] = useState<ActiveHint | null>(null)
  const [position, setPosition] = useState<HintPosition | null>(null)
  const bubble = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let pending: PendingHint | null = null
    let active: ActiveHint | null = null
    const hidden = new WeakMap<HTMLElement, string>()

    const restore = (element: HTMLElement) => {
      const text = hidden.get(element)
      if (text === undefined) return
      hidden.delete(element)
      if (!element.isConnected || element.hasAttribute("title")) return
      element.setAttribute("title", text)
    }

    const clearPending = () => {
      if (!pending) return
      window.clearTimeout(pending.timer)
      restore(pending.element)
      pending = null
    }

    const clearActive = () => {
      if (!active) return
      restore(active.element)
      active = null
    }

    const hide = () => {
      clearPending()
      if (!active) return
      clearActive()
      setHint(null)
      setPosition(null)
    }

    const show = (element: HTMLElement, text: string) => {
      active = { element, text }
      setHint(active)
      setPosition(null)
    }

    const start = (element: HTMLElement, text: string) => {
      element.removeAttribute("title")
      hidden.set(element, text)
      pending = {
        element,
        text,
        timer: window.setTimeout(() => {
          pending = null
          if (element.isConnected) {
            show(element, text)
          } else {
            restore(element)
          }
        }, HINT_DELAY),
      }
    }

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return
      const element = titleCandidate(event.target)
      if (!element || element === active?.element || element === pending?.element) return
      hide()
      start(element, element.getAttribute("title")!.trim())
    }

    const onPointerOut = (event: PointerEvent) => {
      const related = event.relatedTarget
      if (active && !(related instanceof Node && active.element.contains(related))) clearActive()
      if (pending && !(related instanceof Node && pending.element.contains(related))) clearPending()
      if (!active && !pending) {
        setHint(null)
        setPosition(null)
      }
    }

    const onGlobalDismiss = () => hide()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide()
    }

    document.addEventListener("pointerover", onPointerOver, true)
    document.addEventListener("pointerout", onPointerOut, true)
    document.addEventListener("pointerdown", onGlobalDismiss, true)
    document.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("wheel", onGlobalDismiss, { capture: true, passive: true })
    window.addEventListener("scroll", onGlobalDismiss, true)
    window.addEventListener("resize", onGlobalDismiss)
    window.addEventListener("blur", onGlobalDismiss)

    return () => {
      clearPending()
      clearActive()
      document.removeEventListener("pointerover", onPointerOver, true)
      document.removeEventListener("pointerout", onPointerOut, true)
      document.removeEventListener("pointerdown", onGlobalDismiss, true)
      document.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("wheel", onGlobalDismiss, true)
      window.removeEventListener("scroll", onGlobalDismiss, true)
      window.removeEventListener("resize", onGlobalDismiss)
      window.removeEventListener("blur", onGlobalDismiss)
    }
  }, [])

  useLayoutEffect(() => {
    if (!hint || !bubble.current) return
    setPosition(measure(hint.element, bubble.current))
  }, [hint])

  if (!hint) return null

  // Native <dialog> content lives in the top layer; a fixed bubble outside it
  // would paint underneath the modal. Keep the hint inside the owning dialog.
  const container = hint.element.closest("dialog") ?? document.body

  return createPortal(
    <div
      ref={bubble}
      data-title-hint-layer="true"
      aria-hidden="true"
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
        zIndex: "calc(var(--layer-overlay, 60) + 400)",
      }}
      className="pointer-events-none max-w-xs whitespace-pre-line break-words rounded-control border bg-surface px-2 py-1 text-xs leading-4 text-foreground shadow-[var(--shadow-floating)]"
    >
      {hint.text}
    </div>,
    container,
  )
}
