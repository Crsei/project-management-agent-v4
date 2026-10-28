"use client"
import { useId, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "../../ui/dialog"
import { Input } from "../../ui/input"
import { Button } from "../../ui/button"
import { DataRegion, type DataRegionProps } from "../../ui/data-region"
import { Item } from "../../ui/item"
import { useI18n } from "../../../lib/i18n-provider"
import type { ContextReference } from "../../../lib/agent-workbench-model"
import styles from "./workbench.module.css"
export function ContextPicker({
  references,
  onPick,
  onPickMany,
  searchable = false,
  open,
  onOpenChange,
}: {
  references: readonly ContextReference[]
  onPick: (reference: ContextReference) => void
  onPickMany?: (references: ContextReference[]) => void
  searchable?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [internalOpen, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [kind, setKind] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const changeOpen = (value: boolean) => {
    setOpen(value)
    onOpenChange?.(value)
    if (!value) setSelected([])
  }
  if (searchable) {
    const filtered = references.filter(
      (r) =>
        (!kind || r.kind === kind) &&
        `${r.label} ${r.source ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    return (
      <>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open ?? internalOpen}
          onClick={() => changeOpen(true)}
        >
          {t("workbench.addContext")}
        </Button>
        <Dialog open={open ?? internalOpen} onOpenChange={changeOpen}>
          <DialogContent>
            <DialogTitle>{t("resource.chooseContext")}</DialogTitle>
            <DialogDescription>{t("resource.selectionOnly")}</DialogDescription>
            <DialogBody>
              <Input
                aria-label={t("resource.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <label className={styles.label}>
                {t("resource.all")}
                <select
                  className={styles.select}
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="">{t("resource.all")}</option>
                  {["file", "selection", "rule", "skill", "link", "image"].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </label>
              <DataRegion
                state={filtered.length ? "success" : "empty"}
                hasContent={filtered.length > 0}
              >
                {filtered.map((r) => (
                  <label key={r.id} className={styles.context}>
                    <input
                      type="checkbox"
                      checked={selected.includes(r.id)}
                      disabled={r.availability === "denied"}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, r.id]
                            : selected.filter((value) => value !== r.id),
                        )
                      }
                    />{" "}
                    {r.label}{" "}
                    <span className={styles.meta}>
                      {r.source} @{r.version ?? "—"} ·{" "}
                      {t(`workbench.${r.availability}`)}
                    </span>
                  </label>
                ))}
              </DataRegion>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => changeOpen(false)}>
                {t("resource.cancel")}
              </Button>
              <Button
                disabled={!selected.length}
                onClick={() => {
                  const picked = references.filter(
                    (r) =>
                      selected.includes(r.id) && r.availability !== "denied",
                  )
                  if (onPickMany) onPickMany(picked)
                  else picked.forEach(onPick)
                  changeOpen(false)
                }}
              >
                {t("resource.addSelected")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }
  return (
    <label className={styles.label} htmlFor={id}>
      {t("workbench.pickReference")}
      <select
        id={id}
        className={styles.select}
        value=""
        onChange={(e) => {
          const r = references.find((r) => r.id === e.target.value)
          if (r) onPick(r)
        }}
      >
        <option value="">{t("workbench.addContext")}</option>
        {references.map((r) => (
          <option
            key={r.id}
            value={r.id}
            disabled={r.availability === "denied"}
          >
            {r.label} · {t(`workbench.${r.availability}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
export function ContextPanel({
  references,
  onRemove,
  onInclude,
  onRetry,
  onOpen,
  data,
  limit,
}: {
  references: readonly ContextReference[]
  onRemove?: (id: string) => void
  onInclude?: (id: string, included: boolean) => void
  onRetry?: (id: string) => void
  onOpen?: (reference: ContextReference) => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
  limit?: number
}) {
  const { t } = useI18n()
  const included = references.filter((r) => r.included)
  const usage =
    included.length &&
    included.every(
      (r) =>
        r.usage?.unit === "tokens" &&
        Number.isFinite(r.usage.value) &&
        r.usage.value >= 0,
    )
      ? included.reduce((a, r) => a + (r.usage?.value ?? 0), 0)
      : undefined
  return (
    <section aria-label={t("workbench.context")}>
      <p className={styles.status}>
        {usage === undefined
          ? t("workbench.usageUnknown")
          : `${t("resource.referenceUsage")}: ${usage}${limit === undefined ? "" : ` / ${limit}`}`}
        {included.some((r) => r.usage?.estimated) &&
          ` · ${t("workbench.estimated")}`}
        {usage !== undefined && limit !== undefined && usage > limit && (
          <span role="alert"> · {t("workbench.limit")}</span>
        )}
      </p>
      <DataRegion
        state={references.length ? "success" : "empty"}
        {...data}
        hasContent={references.length > 0}
        emptyTitle={t("workbench.emptyContext")}
      >
        {references.map((r) => (
          <div
            className={styles.context}
            key={r.id}
            data-context-id={r.id}
            data-invalid={r.availability !== "available"}
          >
            <Item
              title={r.label}
              description={`${r.kind} · ${r.source ?? "—"}${r.version ? ` @${r.version}` : ""}`}
              onSelect={onOpen ? () => onOpen(r) : undefined}
              trailing={
                onRemove && r.removable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t("workbench.remove")} ${r.label}`}
                    onClick={() => onRemove(r.id)}
                  >
                    {t("workbench.remove")}
                  </Button>
                ) : undefined
              }
            />
            <div className={styles.row}>
              <span className={styles.meta}>
                {t(`workbench.${r.availability}`)}
                {r.reason && ` · ${r.reason}`}
              </span>
              {onInclude && (
                <label className={styles.meta}>
                  <input
                    type="checkbox"
                    checked={r.included}
                    onChange={(e) => onInclude(r.id, e.target.checked)}
                  />{" "}
                  {t("workbench.included")}
                </label>
              )}
              {onRetry &&
                ["failed", "stale", "unknown"].includes(r.availability) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onRetry(r.id)}
                  >
                    {t("workbench.retry")}
                  </Button>
                )}
            </div>
            {r.usage && (
              <p className={styles.meta}>
                {r.usage.value} {r.usage.unit} · {r.usage.source}
                {r.usage.estimated ? ` · ${t("workbench.estimated")}` : ""}
              </p>
            )}
          </div>
        ))}
      </DataRegion>
    </section>
  )
}
