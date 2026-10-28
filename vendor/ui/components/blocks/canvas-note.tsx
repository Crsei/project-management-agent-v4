"use client"
import { useI18n } from "../../lib/i18n-provider"
import type { CanvasNoteRecord } from "../../lib/canvas-model"
import { redactText } from "../../lib/redact"
import styles from "./canvas-annotations.module.css"

/** An annotation, with no discussion thread or execution semantics. */
export function CanvasNote({
  note,
  selected,
}: {
  note: CanvasNoteRecord
  selected?: boolean
}) {
  const { t } = useI18n()

  return (
    <section
      className={styles.note}
      data-selected={selected || undefined}
      data-canvas-note={note.id}
    >
      <strong>{t("canvasNote.workflowNote")}</strong>
      <p>{redactText(note.text)}</p>
    </section>
  )
}
