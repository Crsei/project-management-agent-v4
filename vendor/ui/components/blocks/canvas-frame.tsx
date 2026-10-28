"use client"
import { useI18n } from "../../lib/i18n-provider"
import type { CanvasFrameRecord } from "../../lib/canvas-model"
import { redactText } from "../../lib/redact"
import styles from "./canvas-annotations.module.css"

/** Visual grouping only. Coordinates and member movement belong to canvas commands. */
export function CanvasFrame({
  frame,
  selected,
  collapsed,
}: {
  frame: CanvasFrameRecord
  selected?: boolean
  collapsed?: boolean
}) {
  const { t } = useI18n()

  return (
    <section
      className={styles.frame}
      data-selected={selected || undefined}
      data-canvas-frame={frame.id}
      style={{ width: frame.width, height: collapsed ? 64 : frame.height }}
    >
      <strong>{redactText(frame.title)}</strong>
      <small>
        {collapsed
          ? t("canvasFrame.collapsedNodesAndEdgesPreserved")
          : t("canvasFrame.visualGroup")}
      </small>
    </section>
  )
}
