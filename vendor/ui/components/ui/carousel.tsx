"use client"
import { useId, useRef, useState, type ReactNode } from "react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Empty } from "./empty"
export type CarouselProps = {
  items: ReactNode[]
  label: string
  index?: number
  defaultIndex?: number
  onIndexChange?: (index: number) => void
  loop?: boolean
  className?: string
}
/** Manual navigation only. Slides stay mounted; hidden slides leave the tab order. */
export function Carousel({
  items,
  label,
  index: providedIndex,
  defaultIndex = 0,
  onIndexChange,
  loop = false,
  className,
}: CarouselProps) {
  const { t } = useI18n()
  const id = useId()
  const [internal, setInternal] = useState(defaultIndex)
  const index = Math.max(
    0,
    Math.min(
      items.length - 1,
      Number.isFinite(providedIndex ?? internal)
        ? Math.trunc(providedIndex ?? internal)
        : 0,
    ),
  )
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null)
  const go = (next: number) => {
    if (!items.length) return
    const clamped = loop
      ? (next + items.length) % items.length
      : Math.max(0, Math.min(items.length - 1, next))
    if (clamped === index) return
    if (providedIndex === undefined) setInternal(clamped)
    onIndexChange?.(clamped)
  }
  return (
    <section
      aria-label={label}
      aria-roledescription={t("carousel.description")}
      className={cn("grid min-w-0 gap-2", className)}
    >
      {items.length ? (
        <>
          <div
            id={id}
            tabIndex={0}
            className="rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ touchAction: "pan-y" }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              const rtl =
                getComputedStyle(event.currentTarget).direction === "rtl"
              if (event.key === "ArrowRight") {
                event.preventDefault()
                go(index + (rtl ? -1 : 1))
              }
              if (event.key === "ArrowLeft") {
                event.preventDefault()
                go(index + (rtl ? 1 : -1))
              }
              if (event.key === "Home") {
                event.preventDefault()
                go(0)
              }
              if (event.key === "End") {
                event.preventDefault()
                go(items.length - 1)
              }
            }}
            onPointerDown={(event) => {
              if (
                event.pointerType === "mouse" ||
                event.button !== 0 ||
                (event.target as Element).closest(
                  'a,button,input,textarea,select,[contenteditable="true"]',
                )
              )
                return
              pointer.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              pointer.current = null
            }}
            onPointerUp={(event) => {
              const start = pointer.current
              pointer.current = null
              if (!start || start.id !== event.pointerId) return
              const dx = event.clientX - start.x
              const dy = event.clientY - start.y
              if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) {
                const rtl =
                  getComputedStyle(event.currentTarget).direction === "rtl"
                go(index + (dx < 0 ? 1 : -1) * (rtl ? -1 : 1))
              }
            }}
          >
            {items.map((item, i) => (
              <div
                key={i}
                role="group"
                aria-roledescription={t("carousel.slide")}
                aria-label={t("carousel.position", {
                  current: i + 1,
                  total: items.length,
                })}
                hidden={i !== index}
              >
                {item}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="secondary"
              disabled={!loop && index === 0}
              aria-controls={id}
              onClick={() => go(index - 1)}
            >
              {t("carousel.previous")}
            </Button>
            <p
              role="status"
              aria-live="polite"
              className="text-xs tabular-nums"
            >
              {t("carousel.position", {
                current: index + 1,
                total: items.length,
              })}
            </p>
            <Button
              variant="secondary"
              disabled={!loop && index === items.length - 1}
              aria-controls={id}
              onClick={() => go(index + 1)}
            >
              {t("carousel.next")}
            </Button>
          </div>
        </>
      ) : (
        <Empty />
      )}
    </section>
  )
}
