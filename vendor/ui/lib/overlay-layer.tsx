"use client"

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react"

const LayerDepth = createContext(0)

/** Visual nesting follows React ownership, including portals and theme boundaries.
 * Base UI retains focus, dismissal and modal ownership. Ancestors must not create
 * an unrelated stacking context around a theme portal container.
 */
export function OverlayLayer({
  children,
}: {
  children: (style: CSSProperties) => ReactNode
}) {
  const depth = useContext(LayerDepth) + 1
  return (
    <LayerDepth.Provider value={depth}>
      {children({
        zIndex: `calc(var(--layer-overlay, 60) + ${depth} * var(--layer-overlay-step, 20))`,
      })}
    </LayerDepth.Provider>
  )
}

// Explicit final-focus targets prevent an ancestor modal's restore-focus fallback
// from winning when a nested popup disappears in the same render.
const FocusTarget = createContext<
  React.RefObject<HTMLElement | null> | undefined
>(undefined)
export const OverlayFocusScope = FocusTarget.Provider
export function useOverlayFocus() {
  const target = useRef<HTMLElement | null>(null)
  const track = useCallback(
    (open: boolean, details: { trigger?: Element; isCanceled: boolean }) => {
      if (open && !details.isCanceled)
        target.current =
          details.trigger instanceof HTMLElement
            ? details.trigger
            : document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
    },
    [],
  )
  return { target, track }
}
export function useOverlayFinalFocus() {
  const target = useContext(FocusTarget)
  return () => {
    const element = target?.current
    if (!element) return null
    const owner = element.closest('[role="dialog"], [role="alertdialog"]')
    // Base UI 1.8 may schedule its ancestor's restoreFocus="popup" fallback
    // after a nested popup unmounts. Reassert only when that fallback (or the
    // body) owns focus; never replace a user's focus or a newly opened modal.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (
          element.isConnected &&
          element.getClientRects().length &&
          !element.closest('[inert], [aria-hidden="true"]') &&
          (active === document.body || active === owner)
        )
          element.focus({ preventScroll: true })
      }),
    )
    return element
  }
}
