"use client"
import { useI18n } from "../../lib/i18n-provider"

import { useState } from "react"
import { Plus, Search } from "lucide-react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import type { CanvasNodeDefinition } from "../../lib/canvas-model"
import { cn } from "../../lib/utils"
import styles from "./canvas-controls.module.css"

export type NodePaletteProps = {
  definitions: CanvasNodeDefinition[]
  onAdd: (definition: CanvasNodeDefinition) => void
  readOnly?: boolean
  recentTypes?: string[]
  className?: string
}
export function NodePalette({
  definitions,
  onAdd,
  readOnly,
  className,
  recentTypes = [],
}: NodePaletteProps) {
  const { t, resolve } = useI18n()

  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("")
  const visible = definitions.filter(
    (item) =>
      (!category || item.category === category) &&
      `${item.label} ${resolve(item.labelI18n, item.label)} ${item.type} ${item.category} ${resolve(item.categoryI18n, item.category)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )
  return (
    <section
      className={cn(styles.palette, className)}
      aria-label={t("nodePalette.nodePalette")}
    >
      <label className={styles.field}>
        <span>
          <Search size={14} />
          {t("nodePalette.searchNodeTypes")}
        </span>
        <Input
          aria-label={t("nodePalette.searchNodeTypes")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("nodePalette.nameOrType")}
        />
      </label>
      <label className={styles.field}>
        {t("nodePalette.nodeCategory")}
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">{t("nodePalette.allCategories")}</option>
          {[...new Set(definitions.map((item) => item.category))].map(
            (value) => (
              <option key={value} value={value}>
                {resolve(
                  definitions.find((item) => item.category === value)
                    ?.categoryI18n,
                  value,
                )}
              </option>
            ),
          )}
        </select>
      </label>
      {recentTypes.length > 0 && !query && !category && (
        <div
          className={styles.actions}
          aria-label={t("nodePalette.recentlyUsedNodes")}
        >
          <span className={styles.muted}>{t("nodePalette.recentlyUsed")}</span>
          {recentTypes.map((type) => {
            const definition = definitions.find((def) => def.type === type)
            return definition ? (
              <Button
                key={type}
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() => onAdd(definition)}
              >
                {t("nodePalette.recent")}
                {resolve(definition.labelI18n, definition.label)}
              </Button>
            ) : null
          })}
        </div>
      )}
      <ul className={styles.list}>
        {visible.map((definition) => (
          <li key={definition.type}>
            <Button
              variant="ghost"
              className={styles.paletteItem}
              disabled={readOnly}
              aria-label={t("common.addValue", {
                value0: resolve(definition.labelI18n, definition.label),
              })}
              draggable={!readOnly}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/easyuseui-node",
                  definition.type,
                )
                event.dataTransfer.effectAllowed = "copy"
              }}
              onClick={() => onAdd(definition)}
            >
              {definition.icon ?? <Plus size={16} />}
              <span>
                {resolve(definition.labelI18n, definition.label)}
                <small>{definition.type}</small>
              </span>
              <Plus size={14} />
            </Button>
          </li>
        ))}
      </ul>
      {visible.length === 0 && (
        <p role="status" className={styles.muted}>
          {t("nodePalette.noMatchingNodeTypesTryAnotherNameOr")}
        </p>
      )}
      {readOnly && (
        <p className={styles.muted}>
          {t("nodePalette.theNodePaletteRemainsBrowsableOnARead")}
        </p>
      )}
    </section>
  )
}
