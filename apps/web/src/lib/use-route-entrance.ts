import { useEffect, useLayoutEffect, useRef } from "react"
import { useLocation } from "react-router"
import styles from "./route-entrance.module.css"

/** Query params that change the visible view without changing the route. */
const NAV_PARAMS = ["view", "tab", "section"] as const

/** Route 360ms + 100ms stagger; tab 260ms + 100ms. The class only needs to
 * outlive the animation, never later ordinary state renders. */
const ENTRANCE_WINDOW_MS = 600

const TARGET_ATTR = "data-pm-enter-target"

const MARKERS = "[data-pm-page], [data-pm-route-page], [data-pm-people]"

/** Boundaries that do not contain another marked boundary. */
const INNERMOST_MARKERS = [
  "[data-pm-page]:not(:has([data-pm-page],[data-pm-route-page],[data-pm-people]))",
  "[data-pm-route-page]:not(:has([data-pm-page],[data-pm-route-page],[data-pm-people]))",
  "[data-pm-people]:not(:has([data-pm-page],[data-pm-route-page],[data-pm-people]))",
].join(", ")

function navKey(pathname: string, search: string) {
  const params = new URLSearchParams(search)
  const parts = [pathname]
  for (const name of NAV_PARAMS) parts.push(`${name}=${params.get(name) ?? ""}`)
  return parts.join("|")
}

function motionAllowed() {
  if (typeof document === "undefined") return false
  if (document.documentElement.dataset.pmMotion === "reduce") return false
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Direct children of the innermost page boundaries, plus unmarked direct
 * children of the frame. Tagged once per navigation so nodes mounted later by
 * ordinary renders never start an entrance on their own. */
function entranceTargets(root: HTMLElement) {
  const targets = new Set<HTMLElement>()
  for (const boundary of root.querySelectorAll<HTMLElement>(INNERMOST_MARKERS)) {
    for (const child of boundary.children) {
      if (child instanceof HTMLElement) targets.add(child)
    }
  }
  for (const child of root.children) {
    if (!(child instanceof HTMLElement)) continue
    if (child.matches(MARKERS) || child.querySelector(MARKERS)) continue
    targets.add(child)
  }
  return [...targets]
}

function untag(targets: readonly HTMLElement[]) {
  for (const node of targets) node.removeAttribute(TARGET_ATTR)
}

/**
 * One-shot entrance for page-level blocks. The first commit never animates;
 * later route or view/tab/section changes replay the rise-in animation and
 * reset the page's scroll containers to the top.
 */
export function useRouteEntrance<T extends HTMLElement>() {
  const location = useLocation()
  const pathname = location.pathname
  const key = navKey(pathname, location.search)
  const ref = useRef<T | null>(null)
  const previous = useRef<{ key: string; pathname: string } | null>(null)
  const targets = useRef<HTMLElement[]>([])
  const timer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
      untag(targets.current)
      targets.current = []
    },
    [],
  )

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      previous.current = { key, pathname }
      return
    }
    const prior = previous.current
    if (!prior) {
      previous.current = { key, pathname }
      return
    }
    // Same-key location updates (hash, unrelated search) never disturb a
    // running entrance.
    if (prior.key === key) return

    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
    element.classList.remove(styles.enter)
    untag(targets.current)
    targets.current = []
    // Flush the removal before re-tagging: targets that persist across a tab or
    // view switch must lose and regain the attribute in separate style flushes.
    void element.offsetWidth
    previous.current = { key, pathname }

    const scrollRoot = element.closest<HTMLElement>("[data-pm-scroll-root]")
    if (scrollRoot) scrollRoot.scrollTop = 0
    for (const scroller of element.querySelectorAll<HTMLElement>("[data-pm-scroll]")) {
      scroller.scrollTop = 0
    }

    if (!motionAllowed()) {
      delete element.dataset.pmNav
      return
    }
    element.dataset.pmNav = prior.pathname === pathname ? "tab" : "route"
    element.classList.add(styles.enter)
    const next = entranceTargets(element)
    for (const node of next) node.setAttribute(TARGET_ATTR, "")
    targets.current = next
    // Force a style flush so the freshly tagged nodes start their animation now.
    void element.offsetWidth
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      element.classList.remove(styles.enter)
      delete element.dataset.pmNav
      untag(next)
      targets.current = []
    }, ENTRANCE_WINDOW_MS)
  }, [key, pathname])

  return ref
}
