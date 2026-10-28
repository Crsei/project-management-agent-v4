"use client"
import type { ReactNode } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { Input } from "../ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover"
import { useI18n } from "../../lib/i18n-provider"
import {
  columnWidth,
  type ConfigurableColumn,
  type DataTableColumnConfig,
} from "../../lib/data-table-model"
export type DataTableControlsProps = {
  columns: readonly (ConfigurableColumn & { label: string })[]
  value: DataTableColumnConfig
  onValueChange: (value: DataTableColumnConfig) => void
  /** Compact uses an icon trigger and a visibility-only panel. */
  variant?: "standard" | "compact"
  /** Accessible icon name and tooltip; defaults to the localized Columns label. */
  triggerLabel?: string
  /** Caller-owned actions, such as export, in the same popover after the columns. */
  actions?: ReactNode
}
/** All column changes are requests; the caller owns the returned configuration. */
export function DataTableControls({
  columns,
  value,
  onValueChange,
  variant = "standard",
  triggerLabel,
  actions,
}: DataTableControlsProps) {
  const { t } = useI18n()
  const compact = variant === "compact"
  const hidden = new Set(value.hiddenIds ?? [])
  const order = [
    ...new Set([...(value.order ?? []), ...columns.map((c) => c.id)]),
  ].filter((id) => columns.some((c) => c.id === id))
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size={compact ? "icon" : "default"}
            aria-label={
              compact ? (triggerLabel ?? t("tableControls.columns")) : undefined
            }
          />
        }
      >
        {compact ? (
          <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          t("tableControls.columns")
        )}
      </PopoverTrigger>
      <PopoverContent
        className={compact ? "w-64 p-2" : "w-80 p-3"}
        align={compact ? "end" : "start"}
      >
        <PopoverTitle
          className={
            compact
              ? "px-2 pb-2 text-sm font-medium"
              : "mb-3 text-sm font-medium"
          }
        >
          {t("tableControls.columns")}
        </PopoverTitle>
        <div className={compact ? "grid" : "grid gap-3"}>
          {order.map((id, index) => {
            const column = columns.find((c) => c.id === id)!
            function move(delta: number) {
              const next = [...order]
              ;[next[index], next[index + delta]] = [
                next[index + delta],
                next[index],
              ]
              onValueChange({ ...value, order: next })
            }
            return (
              <div
                key={id}
                className={
                  compact ? "px-1" : "grid gap-2 border-b pb-3 last:border-0"
                }
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    aria-label={column.label}
                    checked={column.hideable === false || !hidden.has(id)}
                    disabled={column.hideable === false}
                    onCheckedChange={(checked) => {
                      const next = new Set(value.hiddenIds ?? [])
                      if (checked) next.delete(id)
                      else next.add(id)
                      onValueChange({ ...value, hiddenIds: [...next] })
                    }}
                  />
                  <span className="text-sm">{column.label}</span>
                </div>
                {!compact && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={index === 0}
                      aria-label={t("tableControls.earlier", {
                        label: column.label,
                      })}
                      onClick={() => move(-1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={index === order.length - 1}
                      aria-label={t("tableControls.later", {
                        label: column.label,
                      })}
                      onClick={() => move(1)}
                    >
                      ↓
                    </Button>
                    <label className="flex min-w-0 items-center gap-2 text-xs">
                      {t("tableControls.width")}
                      <Input
                        type="number"
                        className="w-20"
                        aria-label={t("tableControls.columnWidth", {
                          label: column.label,
                        })}
                        min={column.minWidth ?? 80}
                        max={column.maxWidth ?? 640}
                        step={8}
                        value={columnWidth(column, value) ?? ""}
                        placeholder={t("tableControls.auto")}
                        onChange={(event) => {
                          const raw = event.target.value,
                            widths = { ...value.widths }
                          if (!raw) delete widths[id]
                          else if (Number.isFinite(Number(raw)))
                            widths[id] = columnWidth(column, {
                              widths: { [id]: Number(raw) },
                            })!
                          onValueChange({ ...value, widths })
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {actions != null && (
          <div className="mt-2 grid gap-1 border-t pt-2">{actions}</div>
        )}
      </PopoverContent>
    </Popover>
  )
}
