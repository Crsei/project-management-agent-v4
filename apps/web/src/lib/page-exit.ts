/** Clone overlay class; the exit animation lives in index.css. */
const EXIT_CLASS = "pm-page-exit"

/** Hard stop in case `animationend` never fires (e.g. animations disabled). */
const EXIT_MS = 400

/** Pages above this many descendants are cloned without the overlay: the copy
 * would cost more than the fade is worth. */
const MAX_NODES = 4000

let installed = false

function motionAllowed() {
  if (document.documentElement.dataset.pmMotion === "reduce") return false
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Pathname the next history entry will have; a missing URL keeps the current. */
function nextPathname(url?: string | URL | null) {
  if (url === undefined || url === null) return window.location.pathname
  return new URL(url, window.location.href).pathname
}

/** The overlay must never carry live ids, form names, or route/row markers:
 * duplicates would break label/aria wiring and replay entrance animations. */
function stripMarkers(root: HTMLElement) {
  for (const node of [root, ...root.querySelectorAll<HTMLElement>("[id]")]) {
    node.removeAttribute("id")
  }
  for (const node of root.querySelectorAll<HTMLElement>("input[name], select[name], textarea[name]")) {
    node.removeAttribute("name")
  }
  for (const node of [
    root,
    ...root.querySelectorAll<HTMLElement>(
      "[data-pm-route-surface], [data-pm-scroll-root], [data-pm-enter-target], [data-pm-row-enter]",
    ),
  ]) {
    node.removeAttribute("data-pm-route-surface")
    node.removeAttribute("data-pm-scroll-root")
    node.removeAttribute("data-pm-enter-target")
    node.removeAttribute("data-pm-row-enter")
  }
}

/** Keeps the copy visually identical to where the user was when they navigated. */
function copyScroll(source: HTMLElement, clone: HTMLElement) {
  clone.scrollTop = source.scrollTop
  clone.scrollLeft = source.scrollLeft
  const from = source.querySelectorAll<HTMLElement>("[data-pm-scroll]")
  const to = clone.querySelectorAll<HTMLElement>("[data-pm-scroll]")
  for (let index = 0; index < Math.min(from.length, to.length); index += 1) {
    to[index].scrollTop = from[index].scrollTop
    to[index].scrollLeft = from[index].scrollLeft
  }
}

let currentExit: HTMLElement | null = null

/**
 * Freezes the outgoing route surface as a fixed overlay and fades it out while
 * the new page renders underneath. Runs synchronously inside the navigation, so
 * the copy still shows the old page; it styles itself and never re-enters the
 * React tree.
 */
function cloneExit() {
  if (!motionAllowed()) return
  const surface = document.querySelector<HTMLElement>("[data-pm-route-surface]")
  if (!surface) return
  const source = surface.closest<HTMLElement>("[data-pm-scroll-root]") ?? surface.parentElement ?? surface
  if (source.querySelectorAll("*").length > MAX_NODES) return

  const node = source.cloneNode(true)
  if (!(node instanceof HTMLElement)) return
  const clone = node
  stripMarkers(clone)

  const rect = source.getBoundingClientRect()
  clone.setAttribute("aria-hidden", "true")
  clone.setAttribute("inert", "")
  clone.style.position = "fixed"
  clone.style.left = `${rect.left}px`
  clone.style.top = `${rect.top}px`
  clone.style.width = `${rect.width}px`
  clone.style.height = `${rect.height}px`
  clone.style.margin = "0"
  clone.style.overflow = "hidden"
  clone.style.background = "var(--background)"
  clone.style.zIndex = "48"
  clone.style.pointerEvents = "none"

  clone.classList.add(EXIT_CLASS)
  currentExit?.remove()
  document.body.append(clone)
  currentExit = clone
  // Only meaningful once attached: a detached clone has no layout to scroll.
  copyScroll(source, clone)

  // Each clone only ever removes itself, so an older timer or animationend can
  // never tear down a newer exit overlay.
  let timer = 0
  const dispose = () => {
    window.clearTimeout(timer)
    clone.remove()
    if (currentExit === clone) currentExit = null
  }
  timer = window.setTimeout(dispose, EXIT_MS)
  clone.addEventListener("animationend", (event) => {
    // Child animations bubble; only this overlay's own fade may remove it.
    if (event.target === clone) dispose()
  })
}

/**
 * Page-exit animation for pathname changes: the outgoing surface is cloned and
 * faded out synchronously before history changes, so navigation has no
 * transition-phase delay. Query-only changes and re-entrant calls stay on the
 * raw history path.
 */
export function installPageExit() {
  if (installed) return
  if (typeof window === "undefined" || typeof document === "undefined") return
  installed = true

  let lastPathname = window.location.pathname
  let active = false

  const syncPathname = () => {
    lastPathname = window.location.pathname
  }

  const exitThen = (update: () => void) => {
    active = true
    try {
      cloneExit()
    } finally {
      try {
        update()
      } finally {
        syncPathname()
        active = false
      }
    }
  }

  const patch = (name: "pushState" | "replaceState") => {
    const raw = history[name].bind(history) as History[typeof name]

    history[name] = ((data: Parameters<History["pushState"]>[0], unused: string, url?: string | URL | null) => {
      const update = () => raw(data, unused, url)
      // Nested or query-only updates stay on the raw path; the page itself is
      // not being replaced.
      if (active || nextPathname(url) === lastPathname) {
        update()
        syncPathname()
        return
      }
      exitThen(update)
    }) as History[typeof name]
  }

  patch("pushState")
  patch("replaceState")

  window.addEventListener(
    "popstate",
    () => {
      // Capture phase: the overlay is appended before React Router's listener
      // renders the incoming page. The event keeps propagating on its own.
      if (window.location.pathname === lastPathname || active) {
        syncPathname()
        return
      }
      exitThen(() => {})
    },
    true,
  )
}
