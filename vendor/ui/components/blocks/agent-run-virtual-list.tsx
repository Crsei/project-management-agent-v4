"use client"
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { AgentRunRow } from "./agent-run-row"
import type { AgentRunCollectionProps } from "./agent-run-list"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import { runGroup, runGroups } from "../../lib/agent-board-view"
import { virtualWindow } from "../../lib/agent-board-p2"
import type { AgentRunSnapshot } from "../../lib/agent-board-model"
import shared from "./agent-board.module.css"
import styles from "./agent-board-p2.module.css"
type Entry = {
  key: string
  group: (typeof runGroups)[number]
  run?: AgentRunSnapshot
  position?: number
  count?: number
}
export type AgentRunVirtualListProps = AgentRunCollectionProps & {
  height?: number
  overscan?: number
  data?: Omit<DataRegionProps, "children" | "hasContent">
}
/** Variable-height loaded rows only. Focused rows stay mounted; arrows/Home/End move focus without activation. */
export function AgentRunVirtualList({
  records,
  selectedRunId,
  onOpen,
  height = 560,
  overscan = 3,
  data,
}: AgentRunVirtualListProps) {
  const { t } = useI18n()
  const hint = useId()
  const root = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState(() => new Map<string, number>())
  const [scroll, setScroll] = useState(0)
  const safeHeight = Math.max(
    240,
    Math.min(900, Number.isFinite(height) ? height : 560),
  )
  const safeOverscan = Math.max(
    1,
    Math.min(30, Math.floor(Number.isFinite(overscan) ? overscan : 3)),
  )
  const [viewportHeight, setViewportHeight] = useState(safeHeight)
  const [focused, setFocused] = useState<string | null>(null)
  const focusRequest = useRef<string | null>(null)
  const entries = useMemo(() => {
    const output: Entry[] = []
    let position = 0
    for (const group of runGroups) {
      const runs = records.filter(
        (run) => runGroup(run.runtimeStatus) === group,
      )
      if (!runs.length) continue
      output.push({ key: `group:${group}`, group, count: runs.length })
      for (const run of runs)
        output.push({
          key: `run:${run.runId}`,
          group,
          run,
          position: ++position,
        })
    }
    return output
  }, [records])
  const offsets = useMemo(() => {
    const values = [0]
    for (const entry of entries)
      values.push(
        values.at(-1)! + (measured.get(entry.key) ?? (entry.run ? 132 : 45)),
      )
    return values
  }, [entries, measured])
  const window = virtualWindow(offsets, scroll, viewportHeight, safeOverscan)
  const visibleIndices = new Set(
    Array.from(
      { length: window.end - window.start },
      (_, i) => i + window.start,
    ),
  )
  const focusedIndex = entries.findIndex(
    (entry) => entry.run?.runId === focused,
  )
  if (focusedIndex >= 0) visibleIndices.add(focusedIndex)
  const indices = [...visibleIndices].sort((a, b) => a - b)
  const visibleKeys = indices.map((index) => entries[index].key).join("\u0000")
  useEffect(() => {
    const viewport = root.current
    if (!viewport) return
    const observer = new ResizeObserver(() =>
      setViewportHeight(viewport.clientHeight),
    )
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const viewport = root.current
    if (!viewport) return
    const observer = new ResizeObserver((observations) => {
      const changes: [string, number][] = []
      let anchorDelta = 0
      for (const observation of observations) {
        const element = observation.target as HTMLElement
        const key = element.dataset.virtualKey!
        const index = Number(element.dataset.virtualIndex)
        const measuredHeight =
          observation.borderBoxSize?.[0]?.blockSize ??
          element.getBoundingClientRect().height
        const previous = measured.get(key) ?? (entries[index]?.run ? 132 : 45)
        if (Math.abs(measuredHeight - previous) > 0.5) {
          changes.push([key, measuredHeight])
          if (offsets[index] + previous <= viewport.scrollTop)
            anchorDelta += measuredHeight - previous
        }
      }
      if (changes.length) {
        if (anchorDelta) viewport.scrollTop += anchorDelta
        setMeasured((current) => new Map([...current, ...changes]))
      }
    })
    for (const element of viewport.querySelectorAll<HTMLElement>(
      "[data-virtual-key]",
    ))
      observer.observe(element)
    return () => observer.disconnect()
  }, [visibleKeys, entries, offsets, measured])
  useLayoutEffect(() => {
    const request = focusRequest.current
    if (!request) return
    const row = root.current?.querySelector<HTMLElement>(
      `[data-virtual-run="${CSS.escape(request)}"] button`,
    )
    if (row) {
      row.focus({ preventScroll: true })
      focusRequest.current = null
    }
  })
  function moveFocus(index: number) {
    const target = entries[index]
    if (!target?.run) return
    focusRequest.current = target.run.runId
    setFocused(target.run.runId)
    const viewport = root.current!
    const top = offsets[index],
      bottom = offsets[index + 1]
    if (bottom - top > viewport.clientHeight || top < viewport.scrollTop)
      viewport.scrollTop = top
    else if (bottom > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = Math.max(0, bottom - viewport.clientHeight)
    setScroll(viewport.scrollTop)
  }
  return (
    <section className={styles.section} data-agent-virtual-list>
      <p id={hint} className={styles.meta}>
        {t("agentBoardP2.virtualHelp", { count: records.length })}
      </p>
      <DataRegion
        {...data}
        state={data?.state ?? (records.length ? "success" : "empty")}
        hasContent={records.length > 0}
        emptyTitle={t("agentBoard.noRuns")}
      >
        <div
          ref={root}
          className={styles.virtualViewport}
          style={{ height: safeHeight }}
          role="region"
          aria-label={t("agentBoardP2.virtualList")}
          aria-describedby={hint}
          tabIndex={0}
          onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
          onFocusCapture={(event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>(
              "[data-virtual-run]",
            )?.dataset.virtualRun
            if (id) setFocused(id)
          }}
          onKeyDown={(event) => {
            if (
              !onOpen ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return
            const keys = [
              "ArrowDown",
              "ArrowUp",
              "Home",
              "End",
              "PageDown",
              "PageUp",
            ]
            if (!keys.includes(event.key)) return
            const current = entries.findIndex(
              (entry) => entry.run?.runId === focused,
            )
            const rows = entries
              .map((entry, index) => (entry.run ? index : -1))
              .filter((index) => index >= 0)
            if (!rows.length) return
            const at = Math.max(0, rows.indexOf(current))
            let next = at
            if (event.key === "Home") next = 0
            else if (event.key === "End") next = rows.length - 1
            else if (event.key === "PageDown" || event.key === "PageUp")
              next = Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  at +
                    (event.key === "PageDown" ? 1 : -1) *
                      Math.max(1, Math.floor(viewportHeight / 132)),
                ),
              )
            else
              next = Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  at + (event.key === "ArrowDown" ? 1 : -1),
                ),
              )
            event.preventDefault()
            moveFocus(rows[next])
          }}
        >
          <div
            className={styles.virtualContent}
            style={{ height: offsets.at(-1) }}
            role="list"
            aria-label={t("agentBoard.list")}
          >
            {indices.map((index) => {
              const entry = entries[index]
              return (
                <div
                  key={entry.key}
                  className={styles.virtualItem}
                  style={{ transform: `translateY(${offsets[index]}px)` }}
                  data-virtual-key={entry.key}
                  data-virtual-index={index}
                  data-virtual-run={entry.run?.runId}
                  role={entry.run ? "listitem" : "presentation"}
                  aria-setsize={entry.run ? records.length : undefined}
                  aria-posinset={entry.position}
                >
                  {entry.run ? (
                    <AgentRunRow
                      run={entry.run}
                      selected={entry.run.runId === selectedRunId}
                      onOpen={onOpen}
                    />
                  ) : (
                    <h2 className={shared.groupTitle}>
                      {t(`agentBoard.${entry.group}`)} · {entry.count}
                    </h2>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </DataRegion>
    </section>
  )
}
