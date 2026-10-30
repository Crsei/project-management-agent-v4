import { ArrowDown, ArrowUp, ArrowUpDown, Check } from "lucide-react"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Segmented, SegmentedItem } from "../ui/segmented"
import { useI18n } from "../../lib/i18n-provider"
import {
  workItemsSortFields,
  type WorkItemsSort,
  type WorkItemsViewState,
} from "../../lib/work-items-model"
import styles from "./work-items.module.css"

const sortOptions: readonly WorkItemsSort[] = [
  "manual",
  ...workItemsSortFields,
]

export function WorkItemsSortMenu({
  view,
  onViewChange,
  disabled,
}: {
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const label = (sort: WorkItemsSort) =>
    sort === "manual"
      ? t("workItems.manual")
      : t(`workItems.${sort}` as "workItems.state")
  const DirectionIcon = view.sortDirection === "desc" ? ArrowDown : ArrowUp
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" disabled={disabled} />}
      >
        <ArrowUpDown aria-hidden="true" />
        <span className={styles.sortTriggerLabel}>
          {t("workItems.sort")}: {label(view.sort)}
        </span>
        {view.sort !== "manual" && (
          <DirectionIcon className="size-3.5" aria-hidden="true" />
        )}
      </PopoverTrigger>
      <PopoverContent className={styles.sortPopover} align="start">
        <p className={styles.sortHeader}>{t("workItems.sortBy")}</p>
        <div className={styles.sortList} role="listbox" aria-label={t("workItems.sortBy")}>
          {sortOptions.map((sort) => {
            const selected = view.sort === sort
            return (
              <button
                key={sort}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                className={styles.sortOption}
                data-selected={selected || undefined}
                onClick={() =>
                  onViewChange({
                    ...view,
                    sort,
                    sortDirection:
                      sort === "manual" ? "asc" : view.sortDirection,
                  })
                }
              >
                <span>{label(sort)}</span>
                {selected && <Check className="size-4" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
        <div className={styles.sortDirection}>
          <span>{t("workItems.sortDirection")}</span>
          <Segmented
            value={view.sortDirection}
            aria-label={t("workItems.sortDirection")}
            onValueChange={(sortDirection) =>
              onViewChange({
                ...view,
                sortDirection: sortDirection as "asc" | "desc",
              })
            }
          >
            <SegmentedItem value="asc" disabled={disabled}>
              <ArrowUp className="size-3.5" aria-hidden="true" />
              {t("workItems.sortAsc")}
            </SegmentedItem>
            <SegmentedItem value="desc" disabled={disabled}>
              <ArrowDown className="size-3.5" aria-hidden="true" />
              {t("workItems.sortDesc")}
            </SegmentedItem>
          </Segmented>
        </div>
        {view.sort !== "manual" && (
          <p className={styles.sortHint}>{t("workItems.autoSortHint")}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
