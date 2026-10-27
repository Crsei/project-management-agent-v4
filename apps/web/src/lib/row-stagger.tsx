import { useEffect, useRef } from "react"
import { useLocation } from "react-router"
import styles from "./row-stagger.module.css"

/** Query params that swap the visible collection without changing the route. */
const NAV_PARAMS = ["view", "tab", "section"] as const

/** Existing markup that renders a single row or card in a collection, plus an
 * explicit opt-in for containers that have no row markers of their own. */
const ROW_SELECTOR = [
  "[data-work-item]",
  "[data-pm-project]",
  ".task-native-list > li",
  "tbody > tr",
  "[data-pm-stagger] > *",
].join(", ")

/** Overlays never animate their rows. */
const OVERLAY_SELECTOR = '[role="dialog"], [data-radix-popper-content-wrapper]'

const SURFACE_SELECTOR = "[data-pm-route-surface]"
const FALLBACK_SURFACE_ID = "root"

const ROW_ATTR = "data-pm-row-enter"
const ROW_INDEX_VAR = "--pm-row-index"

/** Attribute lifetime, row cap and the longest staggered delay bucket. */
const HOLD_MS = 700
const MAX_ROWS = 24
const MAX_INDEX = 15

type StaggerState = {
  seen: WeakSet<Element>
  timers: number[]
}

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

/** The visible route surface, falling back to the app root outside the shell. */
function activeSurface(): HTMLElement | null {
  const surfaces = document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR)
  for (const surface of surfaces) {
    if (surface.getClientRects().length > 0) return surface
  }
  if (surfaces.length > 0) return null
  return document.getElementById(FALLBACK_SURFACE_ID)
}

/** Drops every marker; the animation already ran, so nothing is left behind. */
function clearRows() {
  for (const row of document.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)) {
    row.removeAttribute(ROW_ATTR)
    row.classList.remove(styles.enter)
    row.style.removeProperty(ROW_INDEX_VAR)
  }
}

function clearTimers(state: StaggerState) {
  for (const timer of state.timers) window.clearTimeout(timer)
  state.timers = []
}

/** `WorkItemList`/`WorkItemBoard` wrap each item in a hierarchy row that owns
 * the depth/editor markers; that wrapper is the element to stagger, otherwise
 * every item would be its own single-row group. */
function staggerTarget(row: HTMLElement): HTMLElement {
  if (!row.hasAttribute("data-work-item")) return row
  const parent = row.parentElement
  if (
    parent instanceof HTMLElement &&
    (parent.hasAttribute("data-work-item-depth") ||
      parent.hasAttribute("data-work-item-editors"))
  ) {
    return parent
  }
  return row
}

/**
 * Tags each visible row container once: up to 24 direct row children get the
 * entrance attribute plus their clamped stagger index. Parents are remembered
 * in a per-navigation WeakSet so ordinary renders and filters never replay.
 */
function scan(state: StaggerState) {
  if (!motionAllowed()) return
  const surface = activeSurface()
  if (!surface) return

  const groups = new Map<Element, HTMLElement[]>()
  const collected = new Set<HTMLElement>()
  for (const row of surface.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.closest(OVERLAY_SELECTOR)) continue
    if (row.getClientRects().length === 0) continue
    const target = staggerTarget(row)
    if (target.getClientRects().length === 0) continue
    if (collected.has(target)) continue
    const parent = target.parentElement
    if (!parent || state.seen.has(parent)) continue
    collected.add(target)
    const rows = groups.get(parent)
    if (rows) rows.push(target)
    else groups.set(parent, [target])
  }

  for (const [parent, rows] of groups) {
    if (state.seen.has(parent)) continue
    if (parent.getClientRects().length === 0) continue
    state.seen.add(parent)

    const tagged = rows.slice(0, MAX_ROWS)
    tagged.forEach((row, index) => {
      row.setAttribute(ROW_ATTR, "")
      row.classList.add(styles.enter)
      row.style.setProperty(ROW_INDEX_VAR, String(Math.min(index, MAX_INDEX)))
    })

    const timer = window.setTimeout(() => {
      state.timers = state.timers.filter((id) => id !== timer)
      for (const row of tagged) {
        row.removeAttribute(ROW_ATTR)
        row.classList.remove(styles.enter)
        row.style.removeProperty(ROW_INDEX_VAR)
      }
    }, HOLD_MS)
    state.timers.push(timer)
  }
}

/** Containers whose direct childList changes can introduce rows. */
const ROW_CONTAINER_SELECTOR = [
  "[data-pm-stagger]",
  ".task-native-list",
  "tbody",
  "[data-work-items-lane]",
].join(", ")

/**
 * Cheap relevance test so per-frame text churn (CountUp rewriting text nodes)
 * never schedules a surface scan. Only element insertions/removals that can
 * carry rows, and direct child changes of a row container, are relevant.
 */
function isRowMutation(record: MutationRecord) {
  const target = record.target
  if (target instanceof Element && target.matches(ROW_CONTAINER_SELECTOR)) {
    return true
  }
  for (const list of [record.addedNodes, record.removedNodes]) {
    for (const node of list) {
      // Text (and comment) churn is never a row change.
      if (!(node instanceof Element)) continue
      if (node.matches(ROW_SELECTOR)) return true
      if (node.matches("[data-pm-stagger]")) return true
      if (node.querySelector(ROW_SELECTOR)) return true
    }
  }
  return false
}

/**
 * One-shot row entrance for lists, tables and board columns. Mounted once inside
 * the router: every navigation or view/tab/section switch starts a fresh pass.
 */
export function RowStagger() {
  const location = useLocation()
  const key = navKey(location.pathname, location.search)
  const state = useRef<StaggerState>({ seen: new WeakSet(), timers: [] })

  useEffect(() => {
    const current = state.current
    current.seen = new WeakSet()
    clearTimers(current)
    clearRows()

    if (!motionAllowed()) return

    let frame: number | undefined
    const schedule = () => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        scan(current)
      })
    }

    scan(current)
    const observer = new MutationObserver((records) => {
      if (records.some(isRowMutation)) schedule()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    // Rows that mounted in the same commit land after this effect: scan again.
    schedule()

    return () => {
      observer.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [key])

  useEffect(
    () => () => {
      clearTimers(state.current)
      clearRows()
    },
    [],
  )

  return null
}
