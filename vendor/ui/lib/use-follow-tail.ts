"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"

/** Linear membership checks; duplicate source positions are handled by the caller. */
export function countNewIds(
  previous: readonly string[],
  current: readonly string[],
) {
  const known = new Set(previous)
  let additions = 0
  for (const id of current) if (!known.has(id)) additions++
  return additions
}

function readingSelection(element: HTMLElement) {
  const selection = window.getSelection()
  return (
    !!selection &&
    !selection.isCollapsed &&
    !!selection.anchorNode &&
    element.contains(selection.anchorNode)
  )
}

/** Follows only within 64px of the bottom; prepended history retains its anchor. */
export function useFollowTail(
  ids: string[],
  revision: string | number,
  notifyOnUpdate = true,
  initialScroll: "top" | "bottom" = "bottom",
) {
  const ref = useRef<HTMLDivElement>(null)
  const following = useRef(initialScroll === "bottom")
  const initialized = useRef(false)
  const previous = useRef({
    ids: [] as string[],
    height: 0,
    revision: "" as string | number,
  })
  const [unread, setUnread] = useState(0)
  const pendingUnread = useRef(0)
  const anchor = useRef<{ id: string; top: number } | null>(null)
  const rememberAnchor = useCallback((element: HTMLElement) => {
    const bounds = element.getBoundingClientRect()
    const selected = window.getSelection()?.anchorNode
    let entry = readingSelection(element)
      ? (selected instanceof Element
          ? selected
          : selected?.parentElement
        )?.closest<HTMLElement>("[data-follow-tail-id]")
      : null
    const x = Math.max(0, Math.min(innerWidth - 1, bounds.x + bounds.width / 2))
    for (let offset = 4; !entry && offset <= 64; offset += 12) {
      const hit = document.elementFromPoint(x, Math.max(0, bounds.top) + offset)
      const candidate = hit?.closest<HTMLElement>("[data-follow-tail-id]")
      if (candidate && element.contains(candidate)) entry = candidate
    }
    if (entry && element.contains(entry))
      anchor.current = {
        id: entry.dataset.followTailId!,
        top: entry.getBoundingClientRect().top - bounds.top,
      }
  }, [])
  function restoreAnchor(element: HTMLElement) {
    const saved = anchor.current
    const entry =
      saved &&
      element.querySelector<HTMLElement>(
        `[data-follow-tail-id="${CSS.escape(saved.id)}"]`,
      )
    if (!entry || !saved) return false
    const delta =
      entry.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      saved.top
    if (Math.abs(delta) > 0.5) element.scrollTop += delta
    return true
  }
  const unreadFrame = useRef<number | undefined>(undefined)
  useLayoutEffect(
    () => () => {
      if (unreadFrame.current !== undefined)
        cancelAnimationFrame(unreadFrame.current)
    },
    [],
  )
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (readingSelection(element)) following.current = false
    const before = previous.current
    if (!initialized.current && ids.length) {
      initialized.current = true
      if (initialScroll === "top") {
        element.scrollTop = 0
        rememberAnchor(element)
        previous.current = {
          ids: ids.slice(),
          height: element.scrollHeight,
          revision,
        }
        return
      }
    }
    const firstOldIndex = before.ids.length ? ids.indexOf(before.ids[0]) : -1
    const prepended =
      firstOldIndex > 0 &&
      before.ids.every((id, index) => ids[firstOldIndex + index] === id)
    const additions = prepended ? 0 : countNewIds(before.ids, ids)
    if (prepended && !following.current) {
      if (!restoreAnchor(element))
        element.scrollTop += element.scrollHeight - before.height
    } else if (following.current) {
      element.scrollTop = element.scrollHeight
      pendingUnread.current = 0
    } else if (additions || (notifyOnUpdate && revision !== before.revision))
      pendingUnread.current += Math.max(1, additions)
    // Keep one scheduled notification across commits. Canceling on every token
    // loses additions when more than one update arrives before the next frame.
    if (
      (pendingUnread.current || (following.current && unread)) &&
      unreadFrame.current === undefined
    )
      unreadFrame.current = requestAnimationFrame(() => {
        unreadFrame.current = undefined
        const additions = pendingUnread.current
        pendingUnread.current = 0
        setUnread((count) => (following.current ? 0 : count + additions))
      })
    previous.current = {
      ids: ids.slice(),
      height: element.scrollHeight,
      revision,
    }
  }, [ids, revision, notifyOnUpdate, unread, initialScroll, rememberAnchor])
  useLayoutEffect(() => {
    const element = ref.current
    const content = element?.firstElementChild
    if (!element || !content) return
    const observer = new ResizeObserver(() => {
      if (readingSelection(element)) following.current = false
      if (following.current) element.scrollTop = element.scrollHeight
      else {
        restoreAnchor(element)
        if (notifyOnUpdate && element.scrollHeight > previous.current.height)
          setUnread((count) => Math.max(1, count))
      }
      previous.current.height = element.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [notifyOnUpdate])
  function onScroll() {
    const element = ref.current
    if (!element) return
    following.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 64
    if (following.current) {
      pendingUnread.current = 0
      setUnread(0)
    } else rememberAnchor(element)
  }
  function jumpToLatest() {
    const element = ref.current
    if (element) element.scrollTop = element.scrollHeight
    following.current = true
    pendingUnread.current = 0
    setUnread(0)
  }
  function scrollToId(id: string, options: { focus?: boolean } = {}) {
    const element = ref.current
    const entry = element?.querySelector<HTMLElement>(
      `[data-follow-tail-id="${CSS.escape(id)}"]`,
    )
    if (!element || !entry) return false
    following.current = false
    element.scrollTop +=
      entry.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      element.clientTop
    if (options.focus) {
      entry.tabIndex = -1
      entry.focus({ preventScroll: true })
    }
    rememberAnchor(element)
    return true
  }
  return { ref, unread, onScroll, jumpToLatest, scrollToId }
}
