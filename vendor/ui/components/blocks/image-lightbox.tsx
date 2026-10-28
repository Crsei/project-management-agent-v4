"use client"

import {
  useCallback,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { safeImageSrc } from "../../lib/agent-media"
import { useI18n } from "../../lib/i18n-provider"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog"

export type LightboxImage = {
  /** Stable identifier: keys, navigation and selection follow it across source updates. */
  id: string
  /** Caller-provided source; it is displayed only when `safeImageSrc` accepts it. */
  src: string
  /** Text alternative describing the image. */
  alt: string
  /** Optional file name shown as the dialog title. */
  name?: string
}

export type ImageLightboxProps = {
  /** Full gallery in caller order; empty means there is nothing to preview. */
  images: readonly LightboxImage[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Active index within `images`. */
  index: number
  onIndexChange: (index: number) => void
  /** Element focused after close; omitted, the Dialog restores its opener. */
  returnFocus?: RefObject<HTMLElement | null>
}

/** Controlled gallery preview on the shared Dialog: Escape closes it, the arrow
 * keys move through the gallery, and a failed source never replaces the
 * attachment state the host already reported. */
export function ImageLightbox({
  images,
  open,
  onOpenChange,
  index,
  onIndexChange,
  returnFocus,
}: ImageLightboxProps) {
  const { t } = useI18n()
  const total = images.length
  const valid = Number.isInteger(index) && index >= 0 && index < total
  // Only the closing transition keeps a picture: while open, an out-of-range
  // index is reported as an empty selection instead of a guessed image.
  const [lastIndex, setLastIndex] = useState(0)
  if (valid && lastIndex !== index) setLastIndex(index)
  const active = valid
    ? index
    : open
      ? -1
      : Math.min(Math.max(lastIndex, 0), Math.max(total - 1, 0))
  const current = active >= 0 && active < total ? images[active] : undefined
  const src = current ? safeImageSrc(current.src) : undefined
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  const move = useCallback(
    (delta: number) => {
      if (active < 0 || total < 2) return
      onIndexChange((active + delta + total) % total)
    },
    [active, total, onIndexChange],
  )
  // The Dialog popup stops arrow keys from leaving it, so the gallery handles
  // them on the popup itself instead of on document.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
      return
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
    }
  }

  if (!open && !current) return null
  const failed = Boolean(src) && failedSrc === src
  const alt = current?.alt ?? ""
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...(returnFocus ? { finalFocus: returnFocus } : {})}
        className="max-w-[min(96vw,56rem)]"
        onKeyDown={onKeyDown}
      >
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-3 pr-10">
            <DialogTitle className="min-w-0 truncate pr-0 text-base">
              {current?.name ?? t("agentElements.imagePreview")}
            </DialogTitle>
            {active >= 0 && (
              <p
                className="shrink-0 text-xs text-muted-foreground"
                aria-live="polite"
                data-lightbox-counter=""
              >
                {t("agentElements.imageCount", { current: active + 1, total })}
              </p>
            )}
          </div>
          <div className="flex min-h-0 items-center justify-center">
            {src && !failed ? (
              // eslint-disable-next-line @next/next/no-img-element -- Portable caller-owned image source.
              <img
                className="max-h-[65dvh] max-w-full rounded-md object-contain"
                src={src}
                alt={alt}
                decoding="async"
                referrerPolicy="no-referrer"
                draggable={false}
                onError={() => setFailedSrc(src)}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {src ? t("agentElements.imageFailed") : t("agentElements.imageUnavailable")}
              </p>
            )}
          </div>
          {active >= 0 && total > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("agentElements.previousImage")}
                onClick={() => move(-1)}
              >
                <ChevronLeft aria-hidden="true" size={16} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("agentElements.nextImage")}
                onClick={() => move(1)}
              >
                <ChevronRight aria-hidden="true" size={16} />
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
