import type { ReactNode } from "react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Checkbox } from "../ui/checkbox"
import { Segmented, SegmentedItem } from "../ui/segmented"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/popover"
import { FilterToolbar } from "./filter-toolbar"
import {
  WorkItemsFilterChips,
  WorkItemsFilterMenu,
} from "./work-items-filter"
import { WorkItemsSortMenu } from "./work-items-sort"
import type {
  WorkItemCatalog,
  WorkItemProperty,
  WorkItemsViewState,
} from "../../lib/work-items-model"
import { useI18n } from "../../lib/i18n-provider"
import styles from "./work-items.module.css"
export type WorkItemsToolbarProps = {
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
  catalog: WorkItemCatalog
  enhancements?: {
    swimlanes?: boolean
    subItems?: boolean
    offscreen?: boolean
  }
  extensions?: ReactNode
}
export function WorkItemsDisplayOptions({
  view,
  onViewChange,
  enhancements,
}: Pick<WorkItemsToolbarProps, "view" | "onViewChange" | "enhancements">) {
  const { t } = useI18n()
  const properties: WorkItemProperty[] = [
    "state",
    "priority",
    "assignees",
    "labels",
    "startDate",
    "dueDate",
    "counts",
  ]
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" />}>
        {t("workItems.display")}
      </PopoverTrigger>
      <PopoverContent>
        <div className={styles.display}>
          <label>
            {t("workItems.groupBy")}
            <select
              disabled={
                view.layout === "timeline" || view.layout === "calendar"
              }
              aria-label={t("workItems.groupBy")}
              value={view.groupBy}
              onChange={(e) =>
                onViewChange({
                  ...view,
                  groupBy: e.target.value as WorkItemsViewState["groupBy"],
                  subGroupBy:
                    e.target.value === view.subGroupBy
                      ? "none"
                      : view.subGroupBy,
                })
              }
            >
              <option value="state">{t("workItems.state")}</option>
              <option value="priority">{t("workItems.priority")}</option>
            </select>
          </label>
          {enhancements && (
            <>
              {enhancements.swimlanes && (
                <>
                  <label>
                    {t("workItems.swimlanes")}
                    <select
                      aria-label={t("workItems.swimlanes")}
                      value={view.subGroupBy ?? "none"}
                      onChange={(e) =>
                        onViewChange({
                          ...view,
                          subGroupBy: e.target
                            .value as WorkItemsViewState["subGroupBy"],
                        })
                      }
                    >
                      <option value="none">{t("workItems.noSwimlanes")}</option>
                      <option value="state" disabled={view.groupBy === "state"}>
                        {t("workItems.state")}
                      </option>
                      <option
                        value="priority"
                        disabled={view.groupBy === "priority"}
                      >
                        {t("workItems.priority")}
                      </option>
                    </select>
                  </label>
                  <p className="text-xs">{t("workItems.swimlaneLayoutHint")}</p>
                </>
              )}
              {enhancements.subItems && (
                <label>
                  <Checkbox
                    checked={view.showSubItems ?? false}
                    onCheckedChange={(showSubItems) =>
                      onViewChange({ ...view, showSubItems })
                    }
                  />
                  {t("workItems.showSubItems")}
                </label>
              )}
              {enhancements.offscreen && (
                <label>
                  <Checkbox
                    checked={view.deferOffscreen ?? false}
                    onCheckedChange={(deferOffscreen) =>
                      onViewChange({ ...view, deferOffscreen })
                    }
                  />
                  {t("workItems.deferOffscreen")}
                </label>
              )}
            </>
          )}
          <label>
            <Checkbox
              checked={view.showEmptyGroups}
              onCheckedChange={(showEmptyGroups) =>
                onViewChange({ ...view, showEmptyGroups })
              }
            />
            {t("workItems.showEmptyGroups")}
          </label>
          {properties.map((property) => (
            <label key={property}>
              <Checkbox
                checked={view.visibleProperties.includes(property)}
                onCheckedChange={(checked) =>
                  onViewChange({
                    ...view,
                    visibleProperties: checked
                      ? [...view.visibleProperties, property]
                      : view.visibleProperties.filter(
                          (key) => key !== property,
                        ),
                  })
                }
              />
              {t(`workItems.${property}` as "workItems.sort")}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function WorkItemsToolbar({
  view,
  onViewChange,
  catalog,
  enhancements,
  extensions,
}: WorkItemsToolbarProps) {
  const { t } = useI18n()
  return (
    <div>
      <FilterToolbar
        className={styles.toolbar}
        label={t("workItems.toolbar")}
        search={
          <>
            <Segmented
              className="max-w-full flex-wrap"
              value={view.layout}
              aria-label={t("workItems.layout")}
              onValueChange={(layout) =>
                onViewChange({
                  ...view,
                  layout: layout as WorkItemsViewState["layout"],
                })
              }
            >
              {(
                ["list", "board", "table", "timeline", "calendar"] as const
              ).map((layout) => (
                <SegmentedItem
                  key={layout}
                  value={layout}
                  className="shrink-0 whitespace-nowrap"
                >
                  {t(`workItems.${layout}`)}
                </SegmentedItem>
              ))}
            </Segmented>
            <Input
              className="w-44"
              value={view.query}
              aria-label={t("workItems.search")}
              placeholder={t("workItems.search")}
              onChange={(e) => onViewChange({ ...view, query: e.target.value })}
            />
          </>
        }
        filters={
          <WorkItemsFilterMenu
            view={view}
            onViewChange={onViewChange}
            catalog={catalog}
          />
        }
        sort={
          <WorkItemsSortMenu view={view} onViewChange={onViewChange} />
        }
        actions={
          <>
            <WorkItemsDisplayOptions
              view={view}
              onViewChange={onViewChange}
              enhancements={enhancements}
            />
            {extensions}
          </>
        }
      />
      <WorkItemsFilterChips
        view={view}
        onViewChange={onViewChange}
        catalog={catalog}
      />
    </div>
  )
}
